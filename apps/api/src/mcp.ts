/**
 * M7 — MCP server at `/mcp` (spec §9): `get_report`, `get_benchmark`,
 * `request_deepdive`, so an agent buyer needs no HTTP client code, just an
 * MCP connection. Stateless Streamable HTTP (`sessionIdGenerator: undefined`):
 * every POST gets its own `McpServer` + transport pair, connected and torn
 * down within the request — there is no session state to hold between calls,
 * so there is nothing simpler stateful mode would buy here.
 *
 * Thin wrappers: every tool calls the exact same reader / enqueuer functions
 * `server.ts`'s HTTP routes use, so the MCP and HTTP surfaces can never
 * silently disagree.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AssessEnqueuer } from './assess-queue';
import type { DeepdiveEnqueuer } from './deepdive-queue';
import type { BenchmarkReader, ReportReader } from './server';

export interface McpDeps {
  readReport: ReportReader;
  readBenchmark: BenchmarkReader;
  enqueueDeepdive: () => DeepdiveEnqueuer;
  enqueueAssess: () => AssessEnqueuer;
  /** design-partner keys accepted for the spending tool (request_deepdive) */
  designPartnerApiKeys: string[];
}

const TOKEN_ADDR = z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'must be a 20-byte hex address');
const text = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }] });

function buildMcpServer(deps: McpDeps, authed: boolean): McpServer {
  const server = new McpServer({ name: 'launch-auditor', version: '0.0.0' });

  server.tool(
    'get_report',
    "Every forecaster's latest signed prediction for a token, with evidence and on-chain proof status.",
    { token: TOKEN_ADDR },
    async ({ token }) => {
      const row = await deps.readReport(token.toLowerCase());
      return text(row ?? { error: 'no report for this token yet' });
    },
  );

  server.tool(
    'get_benchmark',
    'The public benchmark: every forecaster graded against realized outcomes, with sample sizes.',
    {},
    async () => {
      const b = await deps.readBenchmark();
      return text(b ?? { error: 'benchmark not yet computed — the worker writes a snapshot every 5 minutes' });
    },
  );

  server.tool(
    'request_deepdive',
    'Trigger an on-demand llm_deepdive_v0 run for a qualified-lane token. Spends the ' +
      "agent's Orbio balance; requires the x-api-key header on this MCP connection.",
    { token: TOKEN_ADDR },
    async ({ token }) => {
      if (!authed) {
        return text({ error: "x-api-key required for request_deepdive — this spends the agent's Orbio balance" });
      }
      const { id } = await deps.enqueueDeepdive()({ tokenAddress: token.toLowerCase(), trigger: 'on_demand' });
      return text({ queued: true, token: token.toLowerCase(), jobId: id ?? null });
    },
  );

  return server;
}

export function mountMcp(app: FastifyInstance, deps: McpDeps): void {
  app.post('/mcp', async (req, reply) => {
    const key = req.headers['x-api-key'] as string | undefined;
    const authed = Boolean(key) && deps.designPartnerApiKeys.includes(key!);
    const server = buildMcpServer(deps, authed);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    reply.hijack(); // the transport writes the response itself
    try {
      await server.connect(transport);
      await transport.handleRequest(req.raw, reply.raw, req.body);
    } catch (err) {
      req.log.error(err);
      if (!reply.raw.headersSent) {
        reply.raw.writeHead(500, { 'content-type': 'application/json' });
        reply.raw.end(JSON.stringify({ error: 'mcp request failed' }));
      }
    } finally {
      await transport.close().catch(() => {});
      await server.close().catch(() => {});
    }
  });
}
