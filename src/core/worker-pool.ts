/**
 * Runs one task per index from the ordered list, with at most `concurrency`
 * tasks in flight. Workers share a cursor, so a slow index does not hold up
 * the others. A task that rejects rejects the call; the other workers keep
 * running, as in `Promise.all`.
 */
export async function forEachInOrder(
  order: readonly number[],
  concurrency: number,
  task: (index: number) => Promise<void>,
): Promise<void> {
  let nextPosition = 0;
  const workerCount = Math.min(concurrency, order.length);
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      for (;;) {
        const index = order[nextPosition];
        nextPosition += 1;
        if (index === undefined) return;
        await task(index);
      }
    }),
  );
}
