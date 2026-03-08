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
   * Prune expired timestamps for a user, delete their map entry if empty,
   * and return the live (in-map) array reference (or [] if deleted).
   */
  private pruneExpired(userId: string): number[] {
    const timestamps = this.windows.get(userId);
    if (!timestamps) return [];

    const cutoff = Date.now() - this.config.windowMs;
    const firstValid = timestamps.findIndex((t) => t > cutoff);
    if (firstValid > 0) {
      timestamps.splice(0, firstValid);
    } else if (firstValid === -1) {
      timestamps.length = 0;
    }

    if (timestamps.length === 0) {
      this.windows.delete(userId);
      return [];
    }
    return timestamps;
  }

  /**
   * Check if a user is rate-limited. If not, records the request.
   * Returns true if the user IS rate-limited (request should be dropped).
   */
  isRateLimited(userId: string): boolean {
    const timestamps = this.pruneExpired(userId);

    if (timestamps.length >= this.config.maxRequests) {
      return true;
    }

    // Get or create the array (pruneExpired may have deleted it if empty)
    let arr = this.windows.get(userId);
    if (!arr) {
      arr = [];
      this.windows.set(userId, arr);
    }
    arr.push(Date.now());
    return false;
  }

  getRemainingRequests(userId: string): number {
    const timestamps = this.pruneExpired(userId);
    return Math.max(0, this.config.maxRequests - timestamps.length);
  }

  reset(): void {
    this.windows.clear();
  }
}
