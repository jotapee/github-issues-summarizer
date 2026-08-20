/**
 * Generic batching helpers. Kept free of any runtime imports so the test
 * suite can load them directly under Node's type-stripping loader.
 */

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
