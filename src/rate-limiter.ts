import { logger } from "./logger.js";

export interface RateLimiterConfig {
  maxRequests: number;
  windowMs: number;
}

const DEFAULT_CONFIG: RateLimiterConfig = {
  maxRequests: 10,
  windowMs: 60000,
};

export class RateLimiter {
  private windows = new Map<string, number[]>();
  private config: RateLimiterConfig;

  constructor(config?: Partial<RateLimiterConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Check if a user is rate-limited. If not, records the request.
   * Returns true if the user IS rate-limited (request should be dropped).
   */
  isRateLimited(userId: string): boolean {
    const now = Date.now();
    const cutoff = now - this.config.windowMs;

    let timestamps = this.windows.get(userId);
    if (!timestamps) {
      timestamps = [];
      this.windows.set(userId, timestamps);
    }

    // Evict expired entries
    const firstValid = timestamps.findIndex((t) => t > cutoff);
    if (firstValid > 0) {
      timestamps.splice(0, firstValid);
    } else if (firstValid === -1) {
      timestamps.length = 0;
    }

    if (timestamps.length >= this.config.maxRequests) {
      logger.warn({
        msg: "Rate limit exceeded",
        userId,
        count: timestamps.length,
        maxRequests: this.config.maxRequests,
        windowMs: this.config.windowMs,
      });
      return true;
    }

    timestamps.push(now);
    return false;
  }

  getRemainingRequests(userId: string): number {
    const now = Date.now();
    const cutoff = now - this.config.windowMs;
    const timestamps = this.windows.get(userId);
    if (!timestamps) return this.config.maxRequests;

    const validCount = timestamps.filter((t) => t > cutoff).length;
    return Math.max(0, this.config.maxRequests - validCount);
  }

  reset(): void {
    this.windows.clear();
  }
}
