/**
 * The `llm_deepdive_v0` agent loop (spec §5): `callModel` with the read-only
 * tool belt, a step + cost stop condition, and a strict structured output. The
 * model call is injectable so the loop's logic (evidence accumulation, output
 * validation + clamp, stop classification, cost surfacing) is unit-tested
 * against a recorded transcript with no live calls.
 */
import { maxCost, stepCountIs } from '@openrouter/agent';
import type { EvidenceRow, Limitation, ToolOutput } from './evidence';
import type { DeepdiveClient } from './openrouter';
import type { TargetPacket } from './packet';
import { buildDeepdiveUserPrompt, DEEPDIVE_SYSTEM_PROMPT } from './prompt';
import {
  clampDeepDiveOutput,
  DeepDiveOutputSchema,
  DEEPDIVE_OUTPUT_JSON_SCHEMA,
  type DeepDiveOutput,
  type DeepDiveResult,
} from './schema';
import { buildDeepdiveTools, type DeepdiveContext } from './tools';

export interface DeepdiveAgentInput {
  client: DeepdiveClient;
  ctx: DeepdiveContext;
  packet: TargetPacket;
  externalContext?: { label: string; text: string }[];
  /** hard stop on the number of tool-execution turns */
  maxSteps: number;
  /** hard stop on accumulated model cost (USD) — spec §5: ≤ 0.20 per run */
  maxCostUsd: number;
}

/** Minimal view of `callModel`'s `ModelResult` that this loop consumes. */
export interface AgentRun {
  getText(): Promise<string>;
  getResponse(): Promise<{ id?: string } & Record<string, unknown>>;
  getUsage(): Promise<Record<string, unknown>>;
}

export interface InvokeRequest {
  model: string;
  instructions: string;
  input: string;
  tools: readonly unknown[];
  stopWhen: readonly unknown[];
  jsonSchema: unknown;
  /** called once per completed turn with that turn's generation id (if any) */
  onTurnEnd: (info: { generationId: string | null }) => void;
}

export type InvokeFn = (client: DeepdiveClient, req: InvokeRequest) => AgentRun | Promise<AgentRun>;

/** Default: build a real `callModel` run on the Orbio gateway. */
export const defaultInvoke: InvokeFn = (client, req) => {
  return client.openrouter.callModel({
    model: req.model,
    instructions: req.instructions,
    input: req.input,
    tools: req.tools as never,
    stopWhen: req.stopWhen as never,
    text: { format: { type: 'json_schema', name: 'deepdive_v0', strict: true, schema: req.jsonSchema as never } } as never,
    onTurnEnd: (_ctx: unknown, response: { id?: string }) =>
      req.onTurnEnd({ generationId: response?.id ?? null }),
  } as never) as unknown as AgentRun;
};

export interface DeepdiveAgentDeps {
  invoke?: InvokeFn;
}

const EMPTY_OUTPUT: DeepDiveOutput = {
  p_insider_exit_24h: 0,
  p_drawdown_80_7d: 0,
  p_sell_impaired_24h: 0,
  evidence: [{ claim: 'model run did not complete', tx_or_url: null }],
  confidence: 0,
};

const COST_KEYS = ['costUsd', 'totalCost', 'total_cost', 'cost'];
const PROMPT_KEYS = ['promptTokens', 'prompt_tokens', 'inputTokens', 'input_tokens'];
const COMPLETION_KEYS = ['completionTokens', 'completion_tokens', 'outputTokens', 'output_tokens'];

function pickNum(usage: Record<string, unknown>, keys: string[]): number | null {
  for (const k of keys) {
    const v = usage[k];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  return null;
}

/**
 * Read whatever the gateway put in the usage object. OpenRouter includes a
 * dollar cost; an OpenAI-shaped gateway (Orbio) includes only token counts.
 * Both are recorded as-is — the ledger decides the cost basis (cost.ts).
 */
function pickUsage(usage: Record<string, unknown>): {
  costUsd: number | null;
  promptTokens: number | null;
  completionTokens: number | null;
} {
  return {
    costUsd: pickNum(usage, COST_KEYS),
    promptTokens: pickNum(usage, PROMPT_KEYS),
    completionTokens: pickNum(usage, COMPLETION_KEYS),
  };
}

export async function runDeepdiveAgent(
  input: DeepdiveAgentInput,
  deps: DeepdiveAgentDeps = {},
): Promise<DeepDiveResult> {
  const invoke = deps.invoke ?? defaultInvoke;
  const evidence: EvidenceRow[] = [];
  const limitations: Limitation[] = [];
  const onResult = (out: ToolOutput): void => {
    evidence.push(...out.evidence);
    limitations.push(...out.limitations);
  };

  // 2026-09-12, measured: adding DEEPDIVE_SERVER_TOOLS (web_search) to a
  // structured-output call against the Orbio gateway makes the *gateway*
  // return an error envelope whose `error.code` is a string; the pinned
  // @openrouter/sdk's own response schema expects a number there and throws
  // `ResponseValidationError: Response validation failed` before we ever see
  // Orbio's real error — every deep-dive run failed this way (stoppedBy:
  // 'error', correctly building/persisting nothing). Reproduced directly
  // against the SDK: identical structured-output call with no tools, or with
  // only client-side tools, succeeds; adding just this one server tool
  // reproduces the failure every time. Left out of the live tool set until
  // Orbio's gateway supports it for this model — DEEPDIVE_SERVER_TOOLS itself
  // is kept (not deleted) so it's a one-line change to restore.
  const tools = [...buildDeepdiveTools(input.ctx, onResult)];
  const generationIds: string[] = [];
  let steps = 0;

  const run = await invoke(input.client, {
    model: input.client.model,
    instructions: DEEPDIVE_SYSTEM_PROMPT,
    input: buildDeepdiveUserPrompt({ packet: input.packet, externalContext: input.externalContext }),
    tools,
    stopWhen: [stepCountIs(input.maxSteps), maxCost(input.maxCostUsd)],
    jsonSchema: DEEPDIVE_OUTPUT_JSON_SCHEMA,
    onTurnEnd: ({ generationId }) => {
      steps += 1;
      if (generationId) generationIds.push(generationId);
    },
  });

  const base = {
    evidence,
    limitations,
    modelSlug: input.client.model,
    targetPacket: input.packet,
    generationIds,
    steps,
  };

  let text: string;
  try {
    text = await run.getText();
  } catch (e) {
    return {
      ...base,
      output: EMPTY_OUTPUT,
      warnings: [`model run failed: ${e instanceof Error ? e.message : String(e)}`],
      usageCostUsd: null,
      promptTokens: null,
      completionTokens: null,
      stoppedBy: 'error',
    };
  }

  const usage = await run.getUsage().catch(() => ({}) as Record<string, unknown>);
  const u = pickUsage(usage);
  const usageCostUsd = u.costUsd;
  if (u.costUsd == null && u.promptTokens == null && u.completionTokens == null) {
    // M5c diagnostic: the Orbio gateway's usage shape is not one of the known
    // spellings. Log the keys (never the values) so the next live run tells us.
    // eslint-disable-next-line no-console
    console.warn(`[deepdive] usage object had no cost or token counts; keys: [${Object.keys(usage).join(', ')}]`);
  }

  let parsed;
  try {
    parsed = DeepDiveOutputSchema.parse(JSON.parse(text));
  } catch (e) {
    throw new Error(
      `deep-dive output failed validation (${e instanceof Error ? e.message : String(e)}); raw: ${text.slice(0, 400)}`,
    );
  }
  const { output, warnings } = clampDeepDiveOutput(parsed);

  return {
    ...base,
    output,
    warnings,
    usageCostUsd,
    promptTokens: u.promptTokens,
    completionTokens: u.completionTokens,
    stoppedBy:
      usageCostUsd !== null && usageCostUsd >= input.maxCostUsd
        ? 'max_cost'
        : steps >= input.maxSteps
          ? 'max_steps'
          : 'complete',
  };
}
