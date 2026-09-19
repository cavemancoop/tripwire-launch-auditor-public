/**
 * M9 — Prometheus-format /metrics. Computed fresh per request straight from
 * Postgres, the same read-only pattern as every other /v1/* route (the API
 * never writes, never runs the scorer, never touches Redis).
 */
import { prisma } from '@launch-auditor/db';

export interface MetricsSnapshot {
  watcherStalenessSec: number | null;
  commitAgeSec: number | null;
  metabolismState: string | null;
  idsOrPhantomFlagged: boolean;
  launches24h: number;
  reports24h: number;
  /** per outcome label: horizon-due PENDING rows, of which deferred (retrying),
   *  and rows resolved in the trailing 24h. A label with a growing due backlog
   *  and ~0 resolved is a starved benchmark cell. Optional so older readers work. */
  outcomes?: Array<{ label: string; pendingDue: number; deferred: number; resolved24h: number }>;
  /** seconds since the newest det_v0 report was written (report generation stalled if this grows) */
  newestDetReportAgeSec?: number | null;
  /** launch -> report delay of that newest report (the T+10m job running behind if this grows) */
  newestDetReportLagSec?: number | null;
  /** share of launches from 1–2h ago that have a det_v0 report (coverage over eligible launches) */
  detCoverage1to2h?: number | null;
  /** M10 — per-catch-site failure counts (packages/db: CatchSiteFailure), the
   *  systemic fix for silently-swallowed errors in the worker's long-running
   *  loops. Optional so older readers work. */
  catchFailures?: Array<{ site: string; count: number; ageSec: number | null }>;
}

export type MetricsReader = () => Promise<MetricsSnapshot>;

const age = (now: Date, at: Date | null | undefined): number | null =>
  at ? (now.getTime() - at.getTime()) / 1000 : null;

export const prismaMetricsReader: MetricsReader = async () => {
  const now = new Date();
  const since24h = new Date(now.getTime() - 24 * 3_600_000);

  const [watcherCursor, commit, lifecycle, epoch, launches24h, reports24h, due, deferred, resolved] = await Promise.all([
    prisma.watcherCursor.findFirst({ orderBy: { updatedAt: 'desc' } }),
    prisma.commit.findFirst({ orderBy: { createdAt: 'desc' } }),
    prisma.lifecycleLog.findFirst({ orderBy: { createdAt: 'desc' } }),
    prisma.metabolismEpoch.findFirst({ orderBy: { at: 'desc' } }),
    prisma.launch.count({ where: { createdAt: { gte: since24h } } }),
    prisma.report.count({ where: { createdAt: { gte: since24h } } }),
    prisma.outcome.groupBy({
      by: ['label'],
      where: { status: 'PENDING', horizonAt: { lte: now } },
      _count: { _all: true },
    }),
    prisma.outcome.groupBy({
      by: ['label'],
      where: { status: 'PENDING', horizonAt: { lte: now }, measuredAt: { not: null } },
      _count: { _all: true },
    }),
    prisma.outcome.groupBy({
      by: ['label'],
      where: { status: 'RESOLVED', measuredAt: { gte: since24h } },
      _count: { _all: true },
    }),
  ]);

  const catchFailureRows = await prisma.catchSiteFailure.findMany({ orderBy: { site: 'asc' } });

  const [newestDet, eligible, eligibleWithDet] = await Promise.all([
    prisma.report.findFirst({
      where: { forecaster: 'det_v0' },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true, launch: { select: { launchAt: true } } },
    }),
    prisma.launch.count({ where: { launchAt: { gte: new Date(now.getTime() - 2 * 3_600_000), lt: new Date(now.getTime() - 3_600_000) } } }),
    prisma.launch.count({
      where: {
        launchAt: { gte: new Date(now.getTime() - 2 * 3_600_000), lt: new Date(now.getTime() - 3_600_000) },
        reports: { some: { forecaster: 'det_v0' } },
      },
    }),
  ]);

  const count = (rows: Array<{ label: string; _count: { _all: number } }>, label: string): number =>
    rows.find((r) => r.label === label)?._count._all ?? 0;
  const labels = [...new Set([...due, ...deferred, ...resolved].map((r) => r.label))].sort();

  return {
    watcherStalenessSec: age(now, watcherCursor?.updatedAt),
    commitAgeSec: age(now, commit?.createdAt),
    metabolismState: lifecycle?.newState ?? null,
    idsOrPhantomFlagged: Boolean(lifecycle?.idsMismatch) || Boolean(epoch?.phantom),
    launches24h,
    reports24h,
    newestDetReportAgeSec: age(now, newestDet?.createdAt),
    newestDetReportLagSec:
      newestDet?.createdAt && newestDet.launch?.launchAt
        ? (newestDet.createdAt.getTime() - newestDet.launch.launchAt.getTime()) / 1000
        : null,
    detCoverage1to2h: eligible > 0 ? eligibleWithDet / eligible : null,
    outcomes: labels.map((label) => ({
      label,
      pendingDue: count(due, label),
      deferred: count(deferred, label),
      resolved24h: count(resolved, label),
    })),
    catchFailures: catchFailureRows.map((r) => ({
      site: r.site,
      count: r.count,
      ageSec: age(now, r.lastAt),
    })),
  };
};

const METABOLISM_STATES = ['NO_KEY', 'ACTIVE', 'DRAINING', 'ROTATING', 'REVOKING', 'STARVED'] as const;

export function formatPrometheus(m: MetricsSnapshot): string {
  const lines: string[] = [];
  const gauge = (name: string, help: string, value: number | null): void => {
    lines.push(`# HELP ${name} ${help}`);
    lines.push(`# TYPE ${name} gauge`);
    lines.push(`${name} ${value === null ? 'NaN' : value}`);
  };

  gauge(
    'launch_auditor_watcher_staleness_seconds',
    'Seconds since the watcher last advanced its cursor',
    m.watcherStalenessSec,
  );
  gauge(
    'launch_auditor_commit_age_seconds',
    'Seconds since the last commit batch was formed',
    m.commitAgeSec,
  );
  gauge(
    'launch_auditor_ids_or_phantom_flagged',
    '1 if the latest lifecycle row flags an IDS mismatch or a phantom-spend epoch',
    m.idsOrPhantomFlagged ? 1 : 0,
  );
  gauge('launch_auditor_launches_24h', 'Launches indexed in the trailing 24h', m.launches24h);
  gauge('launch_auditor_reports_24h', 'Reports written in the trailing 24h', m.reports24h);

  lines.push('# HELP launch_auditor_metabolism_state Current metabolism state (1 = active, one series per known state)');
  lines.push('# TYPE launch_auditor_metabolism_state gauge');
  for (const s of METABOLISM_STATES) {
    lines.push(`launch_auditor_metabolism_state{state="${s}"} ${m.metabolismState === s ? 1 : 0}`);
  }

  if (m.newestDetReportAgeSec !== undefined) {
    gauge('launch_auditor_det_report_age_seconds', 'Seconds since the newest det_v0 report was written', m.newestDetReportAgeSec);
    gauge('launch_auditor_det_report_lag_seconds', 'Launch-to-report delay of the newest det_v0 report', m.newestDetReportLagSec ?? null);
    gauge('launch_auditor_det_coverage_1to2h', 'Share of launches from 1-2h ago with a det_v0 report', m.detCoverage1to2h ?? null);
  }

  const series = (name: string, help: string, pick: (o: NonNullable<MetricsSnapshot['outcomes']>[number]) => number): void => {
    if (!m.outcomes?.length) return;
    lines.push(`# HELP ${name} ${help}`);
    lines.push(`# TYPE ${name} gauge`);
    for (const o of m.outcomes) lines.push(`${name}{label="${o.label}"} ${pick(o)}`);
  };
  series('launch_auditor_outcomes_pending_due', 'PENDING outcomes whose horizon has passed, per label', (o) => o.pendingDue);
  series('launch_auditor_outcomes_deferred', 'Horizon-due PENDING outcomes currently retrying after a transient failure, per label', (o) => o.deferred);
  series('launch_auditor_outcomes_resolved_24h', 'Outcomes resolved in the trailing 24h, per label', (o) => o.resolved24h);

  if (m.catchFailures?.length) {
    lines.push(
      '# HELP launch_auditor_catch_site_failures_total Cumulative failures caught and logged at each named catch site (a loop kept running, not a crash)',
    );
    lines.push('# TYPE launch_auditor_catch_site_failures_total counter');
    for (const f of m.catchFailures) {
      lines.push(`launch_auditor_catch_site_failures_total{site="${f.site}"} ${f.count}`);
    }
    lines.push('# HELP launch_auditor_catch_site_failure_age_seconds Seconds since the last failure at each catch site');
    lines.push('# TYPE launch_auditor_catch_site_failure_age_seconds gauge');
    for (const f of m.catchFailures) {
      lines.push(`launch_auditor_catch_site_failure_age_seconds{site="${f.site}"} ${f.ageSec === null ? 'NaN' : f.ageSec}`);
    }
  }

  return lines.join('\n') + '\n';
}
