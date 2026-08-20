import OpenAI from 'openai';

/** Cheap, high-throughput stages: the two scouts (LLM 1 and LLM 2). */
export const SCOUT_MODEL = 'gpt-4o-mini';
/** Judgement stages: the coherence checker (LLM 3) and composer (LLM 4). */
export const REASONING_MODEL = 'gpt-4o';

export class LLMError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LLMError';
  }
}

const clients = new Map<string, OpenAI>();

export function getClient(apiKey: string): OpenAI {
  let client = clients.get(apiKey);
  if (!client) {
    client = new OpenAI({ apiKey });
    clients.set(apiKey, client);
  }
  return client;
}

interface JsonCallOptions {
  apiKey: string;
  model: string;
  system: string;
  user: string;
  /** Composer output is long; scouts are short. */
  maxTokens?: number;
  temperature?: number;
}

/**
 * One JSON-mode completion, with a bounded retry on transient failures.
 * JSON mode guarantees parseable JSON but not a particular shape, so every
 * caller validates the result itself.
 */
export async function callJson<T>(options: JsonCallOptions): Promise<T> {
  const { apiKey, model, system, user, maxTokens = 2000, temperature = 0.2 } = options;
  const openai = getClient(apiKey);

  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const completion = await openai.chat.completions.create({
        model,
        temperature,
        max_tokens: maxTokens,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      });

      const text = completion.choices[0]?.message?.content;
      if (!text) throw new LLMError('Model returned an empty response.');
      return JSON.parse(text) as T;
    } catch (error) {
      lastError = error;
      const status = (error as { status?: number }).status;
      // 4xx other than 429 will not get better on retry.
      if (status && status !== 429 && status < 500) break;
      await new Promise((resolve) => setTimeout(resolve, 400 * 2 ** attempt));
    }
  }

  const message = lastError instanceof Error ? lastError.message : String(lastError);
  throw new LLMError(`${model} call failed: ${message}`);
}

/** Splits work into batches so no single prompt gets unreasonably large. */
export function batch<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export interface BatchRun<TIn, TOut> {
  results: TOut[];
  /** Items belonging to batches whose model call failed outright. */
  failed: TIn[];
  firstError: unknown;
}

/**
 * Runs batches concurrently and isolates failures to the batch that caused
 * them. DESIGN.md section 8 requires that one bad issue must not abort the
 * run, so a rejected batch is recorded rather than propagated.
 *
 * Callers are expected to treat "every batch failed" as systemic (a bad API
 * key, for instance) and re-throw.
 */
export async function runBatches<TIn, TOut>(
  groups: TIn[][],
  handler: (group: TIn[]) => Promise<TOut[]>,
): Promise<BatchRun<TIn, TOut>> {
  const settled = await Promise.allSettled(groups.map(handler));

  const results: TOut[] = [];
  const failed: TIn[] = [];
  let firstError: unknown;

  settled.forEach((outcome, index) => {
    if (outcome.status === 'fulfilled') {
      results.push(...outcome.value);
      return;
    }
    failed.push(...groups[index]);
    firstError ??= outcome.reason;
  });

  return { results, failed, firstError };
}
