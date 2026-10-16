import { describe, expect, it } from "vitest";
import { forEachInOrder } from "./worker-pool.js";

describe("forEachInOrder", () => {
  it("starts tasks in the given order", async () => {
    const started: number[] = [];
    await forEachInOrder([2, 0, 1], 1, (index) => {
      started.push(index);
      return Promise.resolve();
    });
    expect(started).toEqual([2, 0, 1]);
  });

  it("runs every index in the order exactly once", async () => {
    const order = [3, 1, 4, 0, 2];
    const seen: number[] = [];
    await forEachInOrder(order, 3, (index) => {
      seen.push(index);
      return Promise.resolve();
    });
    expect([...seen].sort((left, right) => left - right)).toEqual([
      0, 1, 2, 3, 4,
    ]);
  });

  it("never runs more than the concurrency at once", async () => {
    const order = Array.from({ length: 20 }, (_, index) => index);
    let inFlight = 0;
    let peak = 0;
    await forEachInOrder(order, 3, async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await Promise.resolve();
      inFlight -= 1;
    });
    expect(peak).toBe(3);
  });

  it("starts only one worker per index when the order is shorter than the concurrency", async () => {
    const order = [0, 1, 2];
    let inFlight = 0;
    let peak = 0;
    await forEachInOrder(order, 8, async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await Promise.resolve();
      inFlight -= 1;
    });
    expect(peak).toBe(3);
  });

  it("resolves without calling the task for an empty order", async () => {
    let calls = 0;
    await forEachInOrder([], 4, () => {
      calls += 1;
      return Promise.resolve();
    });
    expect(calls).toBe(0);
  });

  it("rejects with the task error", async () => {
    const failure = new Error("task failed");
    await expect(
      forEachInOrder([0, 1, 2], 2, (index) =>
        index === 1 ? Promise.reject(failure) : Promise.resolve(),
      ),
    ).rejects.toBe(failure);
  });
});
