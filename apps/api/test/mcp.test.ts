import { describe, expect, it } from 'vitest';
import { buildServer } from '../src/server';

// Stateless Streamable HTTP: each POST is handled by a fresh McpServer +
// transport pair (mcp.ts), so a bare tools/list needs no prior `initialize`
// call in the same connection. The transport replies as SSE
// (`event: message\ndata: {...}`) even for a single response — pull the JSON
// out of the `data:` line.
function parseSse(payload: string): { result: { tools?: Array<{ name: string }>; content?: Array<{ text: string }> } } {
  const line = payload.split('\n').find((l) => l.startsWith('data: '));
  if (!line) throw new Error(`no data: line in SSE payload: ${payload}`);
  return JSON.parse(line.slice('data: '.length));
}

const MCP_HEADERS = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };

describe('POST /mcp', () => {
  it('lists get_report, get_benchmark, request_deepdive', async () => {
    const app = buildServer({ reportReader: async () => null, benchmarkReader: async () => null });
    const res = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: MCP_HEADERS,
      payload: { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
    });
    expect(res.statusCode).toBe(200);
    const body = parseSse(res.payload);
    const names = (body.result.tools ?? []).map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(['get_report', 'get_benchmark', 'request_deepdive']));
    await app.close();
  });

  it('calls get_report through the injected reader', async () => {
    const app = buildServer({ reportReader: async (token) => ({ token, reportTime: 't', forecasters: [] }) });
    const res = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: MCP_HEADERS,
      payload: {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'get_report', arguments: { token: '0x00000000000000000000000000000000dec0ded1' } },
      },
    });
    expect(res.statusCode).toBe(200);
    const body = parseSse(res.payload);
    const parsed = JSON.parse(body.result.content![0]!.text);
    expect(parsed.token).toBe('0x00000000000000000000000000000000dec0ded1');
    await app.close();
  });

  it('rejects a malformed token argument via the zod schema, not a 500', async () => {
    const app = buildServer({ reportReader: async () => null });
    const res = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: MCP_HEADERS,
      payload: {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'get_report', arguments: { token: 'not-an-address' } },
      },
    });
    expect(res.statusCode).toBe(200); // JSON-RPC reports the error in the body, not the HTTP status
    const body = parseSse(res.payload) as { result?: { isError?: boolean }; error?: unknown };
    expect(body.result?.isError ?? Boolean(body.error)).toBe(true);
    await app.close();
  });

  // 2026-09-16: request_deepdive spends the agent's own Orbio balance, so it
  // needs the same x-api-key design partners send to the HTTP endpoint.
  describe('request_deepdive — requires a design-partner key', () => {
    const call = (headers: Record<string, string>, enqueueDeepdive?: never) =>
      buildServer({ env: { designPartnerApiKeys: ['partner-key-1'] } as never, enqueueDeepdive }).inject({
        method: 'POST',
        url: '/mcp',
        headers,
        payload: {
          jsonrpc: '2.0',
          id: 4,
          method: 'tools/call',
          params: { name: 'request_deepdive', arguments: { token: '0x00000000000000000000000000000000dec0ded1' } },
        },
      });
    // never enqueued when unauthed — passing it would throw (no Redis in tests) if the lock failed open
    const unreachable = (async () => {
      throw new Error('must not enqueue without a valid key');
    }) as never;

    it('refuses without the header', async () => {
      const res = await call(MCP_HEADERS, unreachable);
      const body = parseSse(res.payload);
      expect(JSON.parse(body.result!.content![0]!.text).error).toMatch(/x-api-key/);
    });

    it('refuses a wrong key', async () => {
      const res = await call({ ...MCP_HEADERS, 'x-api-key': 'wrong' }, unreachable);
      const body = parseSse(res.payload);
      expect(JSON.parse(body.result!.content![0]!.text).error).toMatch(/x-api-key/);
    });

    it('enqueues with a valid key', async () => {
      const enqueue = (async () => ({ id: 'job-1' })) as never;
      const res = await call({ ...MCP_HEADERS, 'x-api-key': 'partner-key-1' }, enqueue);
      const body = parseSse(res.payload);
      expect(JSON.parse(body.result!.content![0]!.text).queued).toBe(true);
    });
  });
});
