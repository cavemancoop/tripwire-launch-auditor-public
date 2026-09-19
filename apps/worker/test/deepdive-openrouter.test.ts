import { describe, expect, it } from 'vitest';
import type { WorkerEnv } from '../src/env';
import {
  assertScoredModelSlug,
  generationCost,
  resolveGatewayKey,
} from '../src/deepdive/openrouter';

const ENV = { orbioGatewayV1Url: 'https://api.orbio.so/api/v1' } as WorkerEnv;

describe('resolveGatewayKey', () => {
  it('prefers ORBIO_API_KEY over OPENROUTER_API_KEY when no store', () => {
    expect(resolveGatewayKey({ ORBIO_API_KEY: 'sk-orbio-a', OPENROUTER_API_KEY: 'sk-or-b' } as NodeJS.ProcessEnv)).toBe('sk-orbio-a');
  });
  it('falls back to OPENROUTER_API_KEY', () => {
    expect(resolveGatewayKey({ OPENROUTER_API_KEY: 'sk-or-b' } as NodeJS.ProcessEnv)).toBe('sk-or-b');
  });
  it('returns "" when nothing is set', () => {
    expect(resolveGatewayKey({} as NodeJS.ProcessEnv)).toBe('');
  });
});

describe('assertScoredModelSlug', () => {
  it('accepts a pinned exact slug', () => {
    expect(() => assertScoredModelSlug('anthropic/claude-3.7-sonnet')).not.toThrow();
    expect(() => assertScoredModelSlug('openai/gpt-4.1-2025-04-14')).not.toThrow();
  });
  it('rejects empty / ~latest / auto', () => {
    expect(() => assertScoredModelSlug('')).toThrow();
    expect(() => assertScoredModelSlug('anthropic/claude-3.5-sonnet:latest')).toThrow(/identifiable/);
    expect(() => assertScoredModelSlug('openrouter/auto')).toThrow(/identifiable/);
  });
});

describe('generationCost', () => {
  const fakeFetch = (payload: unknown, okStatus = true): typeof fetch =>
    (async () => ({
      ok: okStatus,
      status: okStatus ? 200 : 404,
      json: async () => payload,
    })) as unknown as typeof fetch;

  it('reads total_cost from the { data } envelope and hits the right URL', async () => {
    let calledUrl = '';
    const f: typeof fetch = (async (url: string, init: RequestInit) => {
      calledUrl = url;
      expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sk-orbio-x');
      return { ok: true, status: 200, json: async () => ({ data: { total_cost: 0.0123, model: 'x/y', tokens_prompt: 900, tokens_completion: 210 } }) };
    }) as unknown as typeof fetch;

    const c = await generationCost('gen-1', ENV, { fetchImpl: f, resolveKey: () => 'sk-orbio-x' });
    expect(calledUrl).toBe('https://api.orbio.so/api/v1/generation?id=gen-1');
    expect(c).toMatchObject({ id: 'gen-1', totalCostUsd: 0.0123, model: 'x/y', tokensPrompt: 900, tokensCompletion: 210 });
  });

  it('accepts a bare (non-enveloped) body', async () => {
    const c = await generationCost('g2', ENV, { fetchImpl: fakeFetch({ total_cost: 0.5 }), resolveKey: () => 'k' });
    expect(c.totalCostUsd).toBe(0.5);
  });

  it('throws on a non-OK response', async () => {
    await expect(
      generationCost('g3', ENV, { fetchImpl: fakeFetch({}, false), resolveKey: () => 'k' }),
    ).rejects.toThrow(/HTTP 404/);
  });
});
