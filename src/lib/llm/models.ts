/**
 * Single source of truth for which model each pipeline stage uses.
 *
 * Every model id here was confirmed against `GET /v1/models` on the account
 * and exercised with the exact Chat Completions call shape this pipeline uses
 * (JSON response_format, a temperature, and an output cap). Do not add an id
 * that has not been probed: the reasoning-era families renamed the output cap
 * and some of them reject an explicit temperature.
 *
 * Prices are USD per 1M tokens, standard tier, taken from OpenAI's pricing
 * page. They exist so the pipeline can report the cost of a run rather than
 * leaving it to guesswork. Models released on or after 2026-03-05 carry a 10%
 * uplift for regional processing, which these figures do not include.
 */

export interface ModelSpec {
  /** Exact API id. */
  id: string;
  inputPerMillion: number;
  outputPerMillion: number;
  /** Reasoning-era models renamed `max_tokens` to `max_completion_tokens`. */
  tokenCapField: 'max_tokens' | 'max_completion_tokens';
  /** Some reasoning models accept only the default temperature. */
  supportsTemperature: boolean;
  /**
   * Models that spend hidden reasoning tokens before answering. Those tokens
   * bill as output, so a nominally cheap model can cost more than a dearer one
   * on short extraction work.
   */
  spendsReasoningTokens: boolean;
}

export const MODELS = {
  'gpt-4.1-nano': {
    id: 'gpt-4.1-nano',
    inputPerMillion: 0.1,
    outputPerMillion: 0.4,
    tokenCapField: 'max_tokens',
    supportsTemperature: true,
    spendsReasoningTokens: false,
  },
  'gpt-4.1-mini': {
    id: 'gpt-4.1-mini',
    inputPerMillion: 0.4,
    outputPerMillion: 1.6,
    tokenCapField: 'max_tokens',
    supportsTemperature: true,
    spendsReasoningTokens: false,
  },
  'gpt-4o-mini': {
    id: 'gpt-4o-mini',
    inputPerMillion: 0.15,
    outputPerMillion: 0.6,
    tokenCapField: 'max_tokens',
    supportsTemperature: true,
    spendsReasoningTokens: false,
  },
  'gpt-4o': {
    id: 'gpt-4o',
    inputPerMillion: 2.5,
    outputPerMillion: 10,
    tokenCapField: 'max_tokens',
    supportsTemperature: true,
    spendsReasoningTokens: false,
  },
  'gpt-5.4-nano': {
    id: 'gpt-5.4-nano',
    inputPerMillion: 0.2,
    outputPerMillion: 1.25,
    tokenCapField: 'max_completion_tokens',
    supportsTemperature: true,
    spendsReasoningTokens: false,
  },
  'gpt-5.4-mini': {
    id: 'gpt-5.4-mini',
    inputPerMillion: 0.75,
    outputPerMillion: 4.5,
    tokenCapField: 'max_completion_tokens',
    supportsTemperature: true,
    spendsReasoningTokens: false,
  },
} as const satisfies Record<string, ModelSpec>;

export type ModelKey = keyof typeof MODELS;

/** The four pipeline stages that call a model. */
export type Stage = 'issues' | 'comments' | 'coherence' | 'composer';

/**
 * Model routing by task type. Change a stage here and nowhere else.
 *
 * See DESIGN.md section 7 for the reasoning behind each assignment and for the
 * measurements that produced it.
 */
export const STAGE_MODELS: Record<Stage, ModelKey> = {
  // Mechanical extraction, high volume, no judgement required.
  issues: 'gpt-4o-mini',
  comments: 'gpt-4o-mini',
  // Verification is judgement, but a cheap model proved sufficient here and
  // this stage runs up to three times per cold run on large inputs, so it is
  // the single biggest cost lever in the pipeline.
  coherence: 'gpt-4o-mini',
  // The only output a human reads, and it runs exactly once per cold run, so
  // the cost of keeping it strong is negligible.
  composer: 'gpt-4o',
};

export function specFor(stage: Stage): ModelSpec {
  return MODELS[STAGE_MODELS[stage]];
}

export function costOf(spec: ModelSpec, inputTokens: number, outputTokens: number): number {
  return (
    (inputTokens / 1_000_000) * spec.inputPerMillion +
    (outputTokens / 1_000_000) * spec.outputPerMillion
  );
}
