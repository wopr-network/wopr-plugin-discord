import { beforeEach, describe, expect, it, vi } from "vitest";
import { RateLimiter } from "./rate-limiter.js";

vi.mock("./logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

describe("RateLimiter", () => {
  let limiter: RateLimiter;

  beforeEach(() => {
    limiter = new RateLimiter({ maxRequests: 3, windowMs: 60000 });
  });

  it("should allow requests under the limit", () => {
    expect(limiter.isRateLimited("user-1")).toBe(false);
    expect(limiter.isRateLimited("user-1")).toBe(false);
    expect(limiter.isRateLimited("user-1")).toBe(false);
  });

  it("should block requests over the limit", () => {
    limiter.isRateLimited("user-1"); // 1
    limiter.isRateLimited("user-1"); // 2
    limiter.isRateLimited("user-1"); // 3
    expect(limiter.isRateLimited("user-1")).toBe(true);
  });

  it("should track users independently", () => {
    limiter.isRateLimited("user-1"); // 1
    limiter.isRateLimited("user-1"); // 2
    limiter.isRateLimited("user-1"); // 3
    expect(limiter.isRateLimited("user-1")).toBe(true);
    expect(limiter.isRateLimited("user-2")).toBe(false);
  });

  it("should allow requests after window expires", () => {
    vi.useFakeTimers();
    limiter.isRateLimited("user-1"); // 1
    limiter.isRateLimited("user-1"); // 2
    limiter.isRateLimited("user-1"); // 3
    expect(limiter.isRateLimited("user-1")).toBe(true);

    vi.advanceTimersByTime(60001);
    expect(limiter.isRateLimited("user-1")).toBe(false);
    vi.useRealTimers();
  });

  it("should use default config when none provided", () => {
    const defaultLimiter = new RateLimiter();
    // Should allow at least 10 requests (default)
    for (let i = 0; i < 10; i++) {
      expect(defaultLimiter.isRateLimited("user-1")).toBe(false);
    }
    expect(defaultLimiter.isRateLimited("user-1")).toBe(true);
  });

  it("should report remaining requests", () => {
    expect(limiter.getRemainingRequests("user-1")).toBe(3);
    limiter.isRateLimited("user-1");
    expect(limiter.getRemainingRequests("user-1")).toBe(2);
    limiter.isRateLimited("user-1");
    expect(limiter.getRemainingRequests("user-1")).toBe(1);
    limiter.isRateLimited("user-1");
    expect(limiter.getRemainingRequests("user-1")).toBe(0);
  });

  it("should reset all state", () => {
    limiter.isRateLimited("user-1");
    limiter.isRateLimited("user-1");
    limiter.isRateLimited("user-1");
    expect(limiter.isRateLimited("user-1")).toBe(true);
    limiter.reset();
    expect(limiter.isRateLimited("user-1")).toBe(false);
  });
});
