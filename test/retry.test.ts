import { describe, it, expect, vi, afterEach } from "vitest";
import { withRetry } from "../src/gmail.js";

const err = (status: number, extra: Record<string, unknown> = {}) =>
  Object.assign(new Error(`HTTP ${status}`), { code: status, ...extra });

/** Run withRetry under fake timers, recording each requested delay. */
async function run(fn: () => Promise<unknown>) {
  vi.useFakeTimers();
  const delays: number[] = [];
  const realSetTimeout = globalThis.setTimeout;
  const spy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((cb: () => void, ms?: number) => {
    delays.push(ms ?? 0);
    return realSetTimeout(cb, 0);
  }) as typeof setTimeout);
  const p = withRetry(fn).then(
    (v) => ({ ok: true as const, v }),
    (e) => ({ ok: false as const, e }),
  );
  await vi.runAllTimersAsync();
  const result = await p;
  spy.mockRestore();
  return { result, delays };
}

afterEach(() => vi.useRealTimers());

describe("withRetry", () => {
  it("retries rate limits up to 6 attempts with growing backoff", async () => {
    let calls = 0;
    const { result, delays } = await run(async () => {
      calls++;
      throw err(429);
    });
    expect(result.ok).toBe(false);
    expect(calls).toBe(6);
    expect(delays).toHaveLength(5);
    // ~1s, 2s, 4s, 8s, 16s (+ <250ms jitter), capped at 16s.
    delays.forEach((d, i) => {
      const base = Math.min(1000 * 2 ** i, 16_000);
      expect(d).toBeGreaterThanOrEqual(base);
      expect(d).toBeLessThan(base + 250);
    });
  });

  it("treats 403 rateLimitExceeded as a rate limit", async () => {
    let calls = 0;
    const { result } = await run(async () => {
      calls++;
      if (calls < 3) throw err(403, { errors: [{ reason: "rateLimitExceeded" }] });
      return "ok";
    });
    expect(result).toEqual({ ok: true, v: "ok" });
    expect(calls).toBe(3);
  });

  it("honours Retry-After", async () => {
    let calls = 0;
    const { delays } = await run(async () => {
      calls++;
      if (calls === 1) throw err(429, { response: { status: 429, headers: { "retry-after": "7" } } });
      return "ok";
    });
    expect(delays).toEqual([7000]);
  });

  it("retries 5xx only 3 times", async () => {
    let calls = 0;
    const { result, delays } = await run(async () => {
      calls++;
      throw err(503);
    });
    expect(result.ok).toBe(false);
    expect(calls).toBe(3);
    expect(delays[0]).toBeGreaterThanOrEqual(500);
    expect(delays[0]).toBeLessThan(750);
  });

  it("does not retry other errors", async () => {
    let calls = 0;
    const { result, delays } = await run(async () => {
      calls++;
      throw err(404);
    });
    expect(result.ok).toBe(false);
    expect(calls).toBe(1);
    expect(delays).toEqual([]);
  });
});
