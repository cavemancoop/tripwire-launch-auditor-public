// M8 dashboard — no build step, no framework. Every number here either comes
// straight off an api response or is a transparently-labelled derivation from
// one (credits/hr, spend/report, rotation counts); nothing is invented when
// data is missing — those cases render "n/a" or an explicit note instead.

const EXPLORER_BASE = 'https://robinhoodchain.blockscout.com';
const LS_KEY = 'launch-auditor:api-base';

/**
 * Outcomes we measure and publish but do not treat as forecastable. The sell
 * simulation uses a fixed $100 notional against pools whose median depth at
 * T+10m is ~$1,040, so it is ~10% of the pool: the price moves hard on an
 * entirely honest token, and ~90% of launches come back "impaired". The number
 * is a real measurement of liquidity depth, not evidence of deception, and no
 * notional fixes that — 2% of a thin pool still moves the price. So it renders
 * without a claim badge, whatever the arithmetic gate says.
 */
const DESCRIPTIVE_OUTCOMES = {
  'SELL_IMPAIRED@1h':
    'Fixed $100 sell against pools of ~$1k median depth — measures liquidity depth, not deception. Not treated as a forecastable claim.',
  'SELL_IMPAIRED@24h':
    'Fixed $100 sell against pools of ~$1k median depth — measures liquidity depth, not deception. Not treated as a forecastable claim.',
};

// Filled from /config.json at boot (the web service's API_BASE_URL). Guessing
// `own-hostname:3000` only ever worked when one machine ran everything; on a
// per-service-hostname host it's always wrong, and it made every visitor paste
// the URL by hand before the dashboard showed anything. A saved override still
// wins, so pointing a browser at a different instance stays a one-field change.
let servedApiBase = '';

function defaultApiBase() {
  return servedApiBase || `${location.protocol}//${location.hostname}:3000`;
}

function getApiBase() {
  try {
    return localStorage.getItem(LS_KEY) || defaultApiBase();
  } catch {
    return defaultApiBase();
  }
}

async function loadServedConfig() {
  try {
    const res = await fetch('config.json', { cache: 'no-store' });
    if (!res.ok) return;
    const cfg = await res.json();
    if (cfg && typeof cfg.apiBase === 'string' && cfg.apiBase) {
      servedApiBase = cfg.apiBase.replace(/\/$/, '');
    }
  } catch {
    /* no served config — fall back to the guess, same as before */
  }
}

function setApiBase(v) {
  try {
    localStorage.setItem(LS_KEY, v);
  } catch {
    /* private-browsing / storage blocked — the input still works for this load */
  }
}

async function getJson(path) {
  const res = await fetch(`${getApiBase()}${path}`);
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return res.json();
}

/** det_v0 scores rank; they aren't calibrated, so no percent sign. */
const score = (v) => (v === null || v === undefined ? 'n/a' : v.toFixed(3));
const usd = (v, digits = 2) => (v === null || v === undefined || Number.isNaN(v) ? 'n/a' : `$${v.toFixed(digits)}`);
const short = (addr) => (addr ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : 'n/a');
const fmtDate = (iso) => (iso ? new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'n/a');

function el(tag, attrs, children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === 'html') node.innerHTML = v;
    else if (k === 'text') node.textContent = v;
    else node.setAttribute(k, v);
  }
  for (const c of children || []) node.appendChild(c);
  return node;
}

function billingBadge(status) {
  const cls = status === 'anomaly' || status === 'phantom' ? 'bad' : status === 'unavailable' ? 'warn' : status === 'exact' ? 'good' : 'dim';
  return `<span class="badge ${cls}">${status ?? 'n/a'}</span>`;
}

// ── Metabolism ───────────────────────────────────────────────────────────

function metric(label, value, sub) {
  return el('div', { class: 'metric' }, [
    el('div', { class: 'label', text: label }),
    el('div', { class: 'value', text: value }),
    ...(sub ? [el('div', { class: 'sub', text: sub })] : []),
  ]);
}

function creditsAccruedPerHour(entries) {
  if (entries.length < 2) return null;
  let accrued = 0;
  for (let i = 1; i < entries.length; i += 1) {
    const d = (entries[i].balanceUsd ?? 0) - (entries[i - 1].balanceUsd ?? 0);
    if (d > 0) accrued += d; // a drop means the balance was spent into a key, not un-accrued
  }
  const spanMs = new Date(entries[entries.length - 1].at).getTime() - new Date(entries[0].at).getTime();
  const hours = spanMs / 3_600_000;
  if (hours <= 0) return null;
  return { perHour: accrued / hours, hours };
}

/** How long ago the last balance reading landed — printed rather than hidden. */
function balanceAgeLabel(lifecycle) {
  const entries = lifecycle?.entries ?? [];
  const last = entries[entries.length - 1];
  if (!last?.at) return 'never';
  const mins = (Date.now() - Date.parse(last.at)) / 60000;
  if (!Number.isFinite(mins) || mins < 0) return 'unknown';
  if (mins < 60) return `${Math.round(mins)}m ago`;
  if (mins < 1440) return `${(mins / 60).toFixed(1)}h ago`;
  return `${(mins / 1440).toFixed(1)}d ago`;
}

function renderMetabolism(lifecycle) {
  const { entries, estimator, budget } = lifecycle;
  const latest = entries[entries.length - 1];
  const grid = document.getElementById('metabolism-metrics');
  grid.innerHTML = '';

  const accrual = creditsAccruedPerHour(entries);
  const rotations = entries.filter((e) => e.newState === 'ROTATING').length;
  const revocations = entries.filter((e) => e.newState === 'REVOKING').length;
  const spendPerReport = estimator.requests24h > 0 ? estimator.estimatedSpend24hUsd / estimator.requests24h : null;

  grid.appendChild(metric('AI balance', usd(latest?.balanceUsd ?? null), latest?.keyHashPrefix ? `${latest.newState} · key ${latest.keyHashPrefix}` : latest ? latest.newState : 'no reading yet'));
  grid.appendChild(metric('Credits accrued', accrual ? `${usd(accrual.perHour)}/hr` : 'n/a', accrual ? `over ${accrual.hours.toFixed(1)}h of samples` : 'not enough samples yet'));
  grid.appendChild(metric('Spend per report', spendPerReport !== null ? usd(spendPerReport, 4) : 'n/a', `${estimator.requests24h} requests, trailing 24h`));
  grid.appendChild(metric('Rotations', String(rotations), `${revocations} revocation${revocations === 1 ? '' : 's'}`));
  grid.appendChild(metric('Billing status', latest?.billingStatus ?? 'n/a', latest?.newState ?? 'no reading yet'));

  const b = budget;
  const BINDING = { daily_cap: 'configured ceiling', credit_share: 'half of CREDIT activated in the last 24h', key_reserve: 'balance above reserve', zero: 'nothing left' };
  document.getElementById('budget-body').innerHTML = `
    <div class="kv"><span class="k">configured ceiling</span><span class="v">${usd(b.dailyCapUsd)}</span></div>
    <div class="kv"><span class="k">today's effective cap</span><span class="v">${usd(b.effectiveDailyCapUsd)} · ${BINDING[b.effectiveCapBinding] ?? b.effectiveCapBinding}</span></div>
    <div class="kv"><span class="k">spent since 00:00 UTC</span><span class="v">${usd(b.spentTodayUsd)}</span></div>
    <div class="kv"><span class="k">remaining today</span><span class="v">${usd(b.remainingTodayUsd)}</span></div>
    <div class="kv"><span class="k">next run allows up to</span><span class="v">${usd(b.maxRunCostUsd)}</span></div>
    <p class="note">Computed with the worker's own gate and spend window. ${
      b.capSource === 'credit_linked'
        ? 'The cap follows on-chain CREDIT: at most half of what was activated into the agent\'s account in the trailing 24h.'
        : 'CREDIT activations could not be read, so the flat configured ceiling applies — the worker falls back the same way.'
    }${b.allowed ? '' : ` Not running now: ${b.reason}.`}</p>
    ${b.gateClosedByBilling ? '<p class="note" style="color:var(--bad)">Gate closed — billing status is anomaly or phantom.</p>' : ''}
    ${b.balanceUnknown ? '<p class="note" style="color:var(--warn)">No balance has been read yet; the daily ceiling stands in for it, as in the worker.</p>' : ''}
    ${b.balanceStale ? `<p class="note" style="color:var(--warn)">Balance last confirmed ${balanceAgeLabel(lifecycle)}; research continues under the daily cap and the local spend ledger.</p>` : ''}
  `;

  const spanMs = entries.length ? new Date(entries[entries.length - 1].at).getTime() - new Date(entries[0].at).getTime() : 0;
  const spanDays = spanMs / 86_400_000;
  let maxGapMs = 0;
  for (let i = 1; i < entries.length; i += 1) {
    maxGapMs = Math.max(maxGapMs, Date.parse(entries[i].at) - Date.parse(entries[i - 1].at));
  }
  const forks = lifecycle.forks || [];
  document.getElementById('continuity-body').innerHTML = `
    ${entries.length === 0
      ? '<div class="kv"><span class="k">chain</span><span class="v">no signed rows yet — nothing to verify</span></div>'
      : `<div class="kv"><span class="k">rows unaltered</span><span class="v">${chainLabel(lifecycle)}</span></div>
    <div class="kv"><span class="k">window</span><span class="v">${lifecycle.startsAtGenesis ? 'from genesis' : `newest ${entries.length} rows, not from genesis`}</span></div>
    <div class="kv"><span class="k">longest gap between rows</span><span class="v">${maxGapMs >= 3_600_000 ? (maxGapMs / 3_600_000).toFixed(1) + ' h' : Math.round(maxGapMs / 60_000) + ' min'}</span></div>`}
    <div class="kv"><span class="k">log span held</span><span class="v">${spanDays.toFixed(2)} days (${entries.length} rows)</span></div>
    ${forks.length ? `<p class="note">${forks.length} fork${forks.length === 1 ? '' : 's'}: two signed rows name the same parent. That happens when two worker containers overlap during a deploy; no row was changed. Each row still verifies against its parent.</p>` : ''}
    <p class="note">The agent's API key is a signature from its own wallet, so no sign-in expires. This describes what the signed log currently covers, not a guarantee of what comes next.</p>
  `;
}

// ── P&L ──────────────────────────────────────────────────────────────────

function renderPnl(lifecycle) {
  const { estimator } = lifecycle;
  const n = estimator.requests24h;
  const reqs = `${n} request${n === 1 ? '' : 's'}`;

  const standalone = document.querySelector('#pnl-standalone .pnl-body');
  standalone.innerHTML = `
    <div class="big">${usd(estimator.estimatedSpend24hUsd, 4)}</div>
    <div class="kv"><span class="k">basis</span><span class="v">token counts × pinned model price</span></div>
    <div class="kv"><span class="k">requests</span><span class="v">${n}</span></div>
    <p class="note">What the trailing-24h LLM deep-dives would cost at list price on a plain OpenRouter account. An estimate, labelled as one.</p>
  `;

  const orbio = document.querySelector('#pnl-orbio .pnl-body');
  orbio.innerHTML = `
    <div class="big">${usd(estimator.providerSpend24hUsd, 4)}</div>
    <div class="kv"><span class="k">basis</span><span class="v">${estimator.basis === 'epoch_reconciled' ? "Orbio's own balance counter, per 60s window" : estimator.basis}</span></div>
    <div class="kv"><span class="k">paid from</span><span class="v">activated CREDIT balance</span></div>
    <p class="note">Same ${reqs}, as charged by the Orbio gateway to the agent's account. Where that balance came from is listed under Funding, with the on-chain transactions.</p>
  `;
}

// ── Funding ─────────────────────────────────────────────────────────────

function renderFunding(f) {
  const body = document.getElementById('funding-body');
  if (!f || !f.configured) {
    body.innerHTML = '<p class="note">Funding source not configured on this instance.</p>';
    return;
  }
  const rows = f.activations
    .map(
      (a) => `<div class="kv"><span class="k">${fmtDate(a.at)} · #${a.activationId} · ${a.by === 'agent' ? 'agent activated its own CREDIT' : 'operator activation from ' + short(a.from)}</span><span class="v">${usd(a.amountUsd)} · <a href="${EXPLORER_BASE}/tx/${a.txHash}" target="_blank" rel="noopener">tx ↗</a></span></div>`,
    )
    .join('');
  body.innerHTML = `
    <div class="kv"><span class="k">agent account</span><span class="v"><a href="${EXPLORER_BASE}/address/${f.account}" target="_blank" rel="noopener">${short(f.account)} ↗</a></span></div>
    <div class="kv"><span class="k">activated in total</span><span class="v">${usd(f.totalActivatedUsd)} (operator ${usd(f.byOperatorUsd)} · agent ${usd(f.byAgentUsd)})</span></div>
    ${rows || '<p class="note">No activations yet.</p>'}
    <p class="note">The worker's code only ever activates the CREDIT the agent holds: its call allowlist permits <code>CREDIT.activate</code> and <code>Staking.claim</code> and refuses transfers (<code>apps/worker/src/metabolism/credit-wallet.ts</code>). That's an application check, not a restriction on the wallet itself — whoever holds the wallet key could sign anything.</p>
  `;
}

// ── Live launches ────────────────────────────────────────────────────────

/**
 * The receipt proves *this* forecast — its signed bytes, signature, Merkle
 * proof, commit block time and outcomes — where the tx alone only shows a
 * batch root that many reports share.
 */
function proofCell(proof, reportHash) {
  if (!proof || !proof.committed) return '<span class="badge dim">not committed</span>';
  const receipt = reportHash
    ? `<a href="${getApiBase()}/v1/receipt/${reportHash}" target="_blank" rel="noopener" title="Signed report bytes, signature, Merkle proof, commit block time and outcomes. Check it offline with: pnpm verify:receipt ${reportHash}">receipt ↗</a>`
    : '';
  if (!proof.txHash) return `${receipt} <span class="badge warn">no tx yet</span>`;
  return `${receipt} <a class="dim-link" href="${EXPLORER_BASE}/tx/${proof.txHash}" target="_blank" rel="noopener" title="The batch transaction — shared by every report in this Merkle batch">batch tx ↗</a>`;
}

function renderLaunches(rows) {
  const body = document.getElementById('launches-body');
  if (rows.length === 0) {
    body.innerHTML = '<tr><td colspan="7" class="empty">no launches yet</td></tr>';
    return;
  }
  body.innerHTML = rows
    .map((l) => {
      const d = l.detV0 || {};
      return `<tr>
        <td>${short(l.token)}</td>
        <td>${l.source}</td>
        <td>${l.lane}</td>
        <td>${fmtDate(l.launchAt)}</td>
        <td>${score(d.pInsiderExit24h)}</td>
        <td>${score(d.pTradingAlive24h)}</td>
        <td>${proofCell(l.proof, d.reportHash)}</td>
      </tr>`;
    })
    .join('');
}

// ── Benchmark ────────────────────────────────────────────────────────────

function renderBenchmark(snapshot) {
  const wrap = document.getElementById('benchmark-wrap');
  // One cohort: live forecasts, eligible rows only — the rows the claims are made on.
  const bench = snapshot.live;
  const all = bench.sections.find((s) => s.splitBy === 'all');
  document.getElementById('min-metrics').textContent = String(bench.minForMetrics);
  document.getElementById('min-claims').textContent = String(bench.minForClaims);
  if (!all) {
    wrap.innerHTML = '<p class="empty">no resolved outcomes yet</p>';
    return;
  }
  const coverage = snapshot.coverage || {};
  const exclusions = bench.exclusions || {};
  // The resolver's backlog is the main operational risk: state it before any metric.
  const cells = Object.values(coverage);
  const graded = cells.reduce((a, c) => a + (c.resolved || 0), 0);
  const due = cells.reduce((a, c) => a + (c.resolved || 0) + (c.pendingDue || 0) + (c.unresolvable || 0), 0);
  const backlog = due
    ? `<p class="note" style="color:var(--warn)">Graded so far: ${graded.toLocaleString('en-US')} of ${due.toLocaleString('en-US')} outcomes whose horizon has passed (${((100 * graded) / due).toFixed(1)}%). The resolver can't keep up, so everything below describes a small subset that isn't a random sample. Current rate and failure counts are on <code>/metrics</code>.</p>`
    : '';

  const rows = [];
  for (const [outcome, cells] of Object.entries(all.byOutcome)) {
    cells.forEach((c, i) => {
      const claim = c.comparisons?.find((x) => x.claimAllowed);
      const descriptive = DESCRIPTIVE_OUTCOMES[outcome];
      const cov = i === 0 ? coverageLine(coverage[outcome], exclusions[outcome]?.det_v0) : '';
      rows.push(`<tr>
        <td>${outcome}${descriptive ? ' <span class="badge dim" title="' + descriptive + '">descriptive</span>' : ''}${cov}</td>
        <td>${c.forecaster}</td>
        <td>${c.n}${c.insufficientSample ? ' <span class="badge warn" title="Below the minimum sample: metrics withheld.">insufficient</span>' : ''}</td>
        <td>${c.positives}</td>
        <td>${c.auroc === null ? 'n/a' : c.auroc.toFixed(3)}${c.invertedRanking ? ` <a class="badge warn" href="${INVERTED_NOTE_URL}" target="_blank" rel="noopener" title="${INVERTED_TITLE}">ranks backwards</a>` : ''}</td>
        <td>${c.brierSkill === null ? 'n/a' : c.brierSkill.toFixed(3)}</td>
        <td>${descriptive ? '' : claim ? `<span class="badge good">beats ${claim.vs} p=${claim.p}</span>` : ''}</td>
      </tr>`);
    });
  }

  wrap.innerHTML = `${backlog}<table>
    <thead><tr><th>outcome</th><th>forecaster</th><th>n</th><th>positives</th><th>auroc</th><th>brier skill</th><th></th></tr></thead>
    <tbody>${rows.join('') || '<tr><td colspan="7" class="empty">no cells yet</td></tr>'}</tbody>
  </table>${snapshot.resolutionPolicy ? `<p class="note">${snapshot.resolutionPolicy}</p>` : ''}`;
}

const INVERTED_NOTE_URL =
  'https://github.com/cavemancoop/tripwire-launch-auditor/blob/main/DECISIONS.md#inverted-cells-planned-applicability-rule-2026-09-19';
const INVERTED_TITLE =
  'AUROC significantly below 0.5 on a claim-sized sample: this forecaster orders this outcome backwards. Our hypothesis and the planned fix are in DECISIONS.md.';

/**
 * Under an outcome's first row: how many outcome rows exist and why most of
 * them aren't in the table. `excl` = det_v0's report-outcome pairs by
 * eligibility class; every other forecaster in the cell is scored on the same rows.
 */
function coverageLine(c, excl) {
  if (!c && !excl) return '';
  const n = (x) => Number(x).toLocaleString('en-US');
  const lines = [];
  if (c) {
    const parts = [`graded ${n(c.resolved)}`, `pending ${n(c.pendingDue)}`];
    if (c.unresolvable) parts.push(`unresolvable ${n(c.unresolvable)}`);
    if (c.na) parts.push(`n/a ${n(c.na)}`);
    lines.push(`<span title="Live outcome rows whose horizon has passed. Pending = due but not yet graded.">${parts.join(' · ')}</span>`);
  }
  if (excl) {
    const out = ['late', 'replay', 'uncommitted', 'missing_time'].filter((k) => excl[k]).map((k) => `${k.replace('_', ' ')} ${n(excl[k])}`);
    if (out.length) {
      lines.push(`<span title="Graded, but not counted: committed after the horizon ended (late), more than 30 min after the anchor (replay), never committed, or commit time unreadable.">excluded from claims: ${out.join(' · ')}</span>`);
    }
  }
  if (c && c.retrospectiveResolved) {
    lines.push(`<span title="Backfilled (retrospective) outcomes exist for this cell and are not in this table.">backfill graded, not shown: ${n(c.retrospectiveResolved)}</span>`);
  }
  return `<div class="note">${lines.join('<br>')}</div>`;
}

/** "intact" / "intact, 2 forks" / "BROKEN at N" — a fork is two signed rows sharing a parent, not an altered row. */
function chainLabel(lifecycle) {
  if (!lifecycle.verified) return `BROKEN at row ${lifecycle.brokenAt}`;
  const f = (lifecycle.forks || []).length;
  return f ? `intact, ${f} fork${f === 1 ? '' : 's'}` : 'intact, one chain';
}

// ── Lifecycle timeline ───────────────────────────────────────────────────

function renderLifecycle(lifecycle) {
  const { entries } = lifecycle;
  document.getElementById('chain-status').textContent =
    `${entries.length} rows · ${chainLabel(lifecycle)} · ${lifecycle.startsAtGenesis ? 'from genesis' : 'newest rows only'}`;

  const body = document.getElementById('lifecycle-body');
  const recent = entries.slice(-30).reverse();
  if (recent.length === 0) {
    body.innerHTML = '<tr><td colspan="6" class="empty">no lifecycle rows yet</td></tr>';
    return;
  }
  body.innerHTML = recent
    .map(
      (e) => `<tr>
        <td>${fmtDate(e.at)}</td>
        <td>${e.prevState ?? '—'} → <strong>${e.newState}</strong></td>
        <td style="white-space:normal;font-family:var(--sans)">${e.reason ?? ''}</td>
        <td>${usd(e.balanceUsd)}</td>
        <td>${usd(e.keyRemainingUsd)}</td>
        <td>${billingBadge(e.billingStatus)}</td>
      </tr>`,
    )
    .join('');
}

// ── Boot ─────────────────────────────────────────────────────────────────

// ── Pinned example ───────────────────────────────────────────────────────

/**
 * Feed post 884 (2026-09-15): picked from the 113 completed, fully eligible
 * forecasts in the 12–16 Sep feed archive because it resolved the cell det_v0
 * is best at (insider exit). It illustrates the mechanism; it is not evidence
 * of skill, since one hit says little when most launches score above 0.99.
 */
const PINNED_EXAMPLE = '0xbe1e685a69a34249a45bed2a31bda873c0765cf32abb8a41ab906ec768c7e915';

async function renderExample() {
  const body = document.getElementById('example-body');
  try {
    const r = await getJson(`/v1/receipt/${PINNED_EXAMPLE}`);
    const c = JSON.parse(r.canonicalJson);
    const n = (x) => Number(x).toLocaleString('en-US');
    const rows = r.outcomes
      .filter((o) => ['INSIDER_EXIT', 'TRADING_ALIVE', 'LIQ_IMPAIRED', 'DRAWDOWN_80'].includes(o.label) && ['6h', '24h'].includes(o.horizon))
      .map((o) => {
        const key = `${o.label}@${o.horizon}`;
        const p = c.probabilities?.[key];
        const result = o.status === 'RESOLVED' ? (o.value ? 'yes' : 'no') : o.status.toLowerCase();
        return `<tr><td>${key}</td><td>${p == null ? 'n/a' : p.toFixed(3)}</td><td>${result}</td><td>${o.eligibility}</td></tr>`;
      })
      .join('');
    body.innerHTML = `
      <div class="kv"><span class="k">token</span><span class="v"><a href="${EXPLORER_BASE}/token/${c.tokenAddress}" target="_blank" rel="noopener">${short(c.tokenAddress)} ↗</a></span></div>
      <div class="kv"><span class="k">forecast anchored (T+10m block)</span><span class="v">${new Date(c.reportTime).toISOString().replace('.000Z', 'Z')}</span></div>
      <div class="kv"><span class="k">committed on-chain (block time)</span><span class="v">${r.commit.blockTime?.replace('.000Z', 'Z') ?? 'unknown'} · ${n(r.commit.lagFromAnchorSec)} s later · <a href="${EXPLORER_BASE}/tx/${r.commit.txHash}" target="_blank" rel="noopener">tx ↗</a></span></div>
      <div class="kv"><span class="k">signed by</span><span class="v">${short(r.signer)} (EIP-712)</span></div>
      <div class="table-wrap" style="margin-top:0.7rem;max-height:none"><table>
        <thead><tr><th>outcome</th><th>det_v0 score</th><th>happened?</th><th>counts toward claims</th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>
      <p class="note">An insider exit did happen, and <code>det_v0</code> scored it 0.996. That's one example of the mechanism, not evidence of skill: most launches score above 0.99, and the scores rank launches rather than being probabilities. Whether the ranking works is answered by the benchmark (04) on every eligible forecast. It was picked from 113 completed, fully eligible forecasts in the 12–16 Sep feed archive because it resolved the outcome <code>det_v0</code> is best at. Its research budget came from on-chain CREDIT (Funding, under 01).</p>
      <p class="note">Check it yourself: <code>pnpm verify:receipt ${r.reportHash}</code> recomputes the hash from these exact bytes, recovers the signer, folds the Merkle proof and reads the commit from chain · <a href="${getApiBase()}/v1/receipt/${r.reportHash}" target="_blank" rel="noopener">raw receipt ↗</a></p>`;
  } catch (err) {
    body.innerHTML = `<p class="note">Receipt unavailable right now (${err instanceof Error ? err.message : err}).</p>`;
  }
}

async function loadAll() {
  void renderExample();
  const statusDot = document.getElementById('api-status');
  try {
    const [lifecycle, launches, benchmark, funding] = await Promise.all([
      getJson('/v1/lifecycle?limit=500'),
      getJson('/v1/launches?limit=50'),
      getJson('/v1/benchmark').catch(() => null),
      getJson('/v1/funding').catch(() => null),
    ]);
    statusDot.className = 'status-dot ok';
    renderMetabolism(lifecycle);
    renderPnl(lifecycle);
    renderFunding(funding);
    renderLifecycle(lifecycle);
    renderLaunches(launches.launches);
    if (benchmark && benchmark.all) {
      renderBenchmark(benchmark);
    } else {
      document.getElementById('benchmark-wrap').innerHTML =
        '<p class="empty">benchmark not yet computed — the worker writes a snapshot every 5 minutes</p>';
    }
  } catch (err) {
    statusDot.className = 'status-dot bad';
    // eslint-disable-next-line no-console
    console.error('[dashboard] load failed', err);
  }
}

function initApiConfig() {
  const input = document.getElementById('api-base');
  input.value = getApiBase();
  document.getElementById('api-reload').addEventListener('click', () => {
    setApiBase(input.value.trim() || defaultApiBase());
    loadAll();
  });
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') document.getElementById('api-reload').click();
  });
}

async function boot() {
  await loadServedConfig(); // before initApiConfig, so the box shows the real default
  initApiConfig();
  await loadAll();
  setInterval(loadAll, 30_000);
}

boot();
