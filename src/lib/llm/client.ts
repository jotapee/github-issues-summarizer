import OpenAI from 'openai';
import { type Stage, costOf, specFor } from './models';

export { batch, runBatches, type BatchRun } from './batching';

export { type Stage } from './models';

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
  /** Which pipeline stage is calling. The model is resolved from models.ts. */
  stage: Stage;
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
  const { apiKey, stage, system, user, maxTokens = 2000, temperature = 0.2 } = options;
  const spec = specFor(stage);
  const openai = getClient(apiKey);

  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const completion = await openai.chat.completions.create({
        model: spec.id,
        // The reasoning-era families renamed the cap and some reject an
        // explicit temperature, so both are driven by the model spec.
        ...(spec.tokenCapField === 'max_tokens'
          ? { max_tokens: maxTokens }
          : { max_completion_tokens: maxTokens }),
        ...(spec.supportsTemperature ? { temperature } : {}),
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      });

      const usage = completion.usage;
      if (usage) {
        // Emitted so a run's cost can be measured rather than estimated.
        console.log(
          JSON.stringify({
            llmUsage: {
              stage,
              model: spec.id,
              inputTokens: usage.prompt_tokens,
              outputTokens: usage.completion_tokens,
              usd: Number(
                costOf(spec, usage.prompt_tokens ?? 0, usage.completion_tokens ?? 0).toFixed(6),
              ),
            },
          }),
        );
      }

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
  throw new LLMError(`${spec.id} call failed: ${message}`);
}
