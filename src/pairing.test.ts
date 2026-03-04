import {
  buildPairingMessage,
  checkClaimRateLimit,
  claimPairingCode,
  cleanupExpiredPairings,
  createPairingRequest,
  getPairingRequest,
  hasOwner,
  listPairingRequests,
  setOwner,
} from "./pairing.js";
import type { WOPRPluginContext } from "./types.js";

const PAIRING_CODE_TTL_MS = 15 * 60 * 1000;
const CLAIM_RATE_LIMIT_WINDOW_MS = 60 * 1000;
const CLAIM_RATE_LIMIT_MAX_ATTEMPTS = 5;

// Monotonically increasing base time per test to avoid cross-test state contamination
let baseTime = new Date("2025-01-01T00:00:00Z").getTime();

beforeEach(() => {
  // Each test gets its own time epoch far enough from all others that
  // no pairing or rate limit entry from a prior test is still valid.
  baseTime += PAIRING_CODE_TTL_MS + CLAIM_RATE_LIMIT_WINDOW_MS + 2000;
  vi.useFakeTimers();
  vi.setSystemTime(baseTime);
  // Sweep out anything that was created before our new epoch
  cleanupExpiredPairings();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("createPairingRequest", () => {
  it("returns an 8-character code from the valid alphabet", () => {
    const code = createPairingRequest("user-1", "TestUser");
    expect(code).toHaveLength(8);
    expect(code).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/);
  });

  it("returns the same code for duplicate requests from same user", () => {
    const code1 = createPairingRequest("user-1", "TestUser");
    const code2 = createPairingRequest("user-1", "TestUser");
    expect(code2).toBe(code1);
  });

  it("refreshes createdAt on duplicate request", () => {
    const code = createPairingRequest("user-1", "TestUser");
    const req1 = getPairingRequest(code);
    const originalCreatedAt = req1?.createdAt ?? 0;

    vi.setSystemTime(baseTime + 5000);
    createPairingRequest("user-1", "TestUser");
    const req2 = getPairingRequest(code);

    expect(req2?.createdAt).toBeGreaterThan(originalCreatedAt);
  });

  it("returns different codes for different users", () => {
    const code1 = createPairingRequest("user-1", "Alice");
    const code2 = createPairingRequest("user-2", "Bob");
    expect(code1).not.toBe(code2);
  });
});

describe("claimPairingCode", () => {
  it("claims a valid pairing code", () => {
    const code = createPairingRequest("user-1", "TestUser");
    const result = claimPairingCode(code);

    expect(result.request).not.toBeNull();
    expect(result.request?.discordUserId).toBe("user-1");
    expect(result.request?.discordUsername).toBe("TestUser");
    expect(result.request?.claimed).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it("returns error for invalid code", () => {
    const result = claimPairingCode("ZZZZZZZZ");
    expect(result.request).toBeNull();
    expect(result.error).toBe("Invalid or expired pairing code");
  });

  it("normalizes code (trim + uppercase)", () => {
    const code = createPairingRequest("user-1", "TestUser");
    const result = claimPairingCode(`  ${code.toLowerCase()}  `);
    expect(result.request).not.toBeNull();
  });

  it("returns error for expired code", () => {
    const code = createPairingRequest("user-1", "TestUser");
    vi.advanceTimersByTime(PAIRING_CODE_TTL_MS + 1);
    const result = claimPairingCode(code);
    expect(result.request).toBeNull();
    expect(result.error).toBe("Pairing code has expired");
  });

  it("returns error when code already deleted after claim", () => {
    const code = createPairingRequest("user-1", "TestUser");
    claimPairingCode(code);
    // Second claim: code was deleted, so it returns "Invalid or expired"
    const result = claimPairingCode(code);
    expect(result.request).toBeNull();
    expect(result.error).toBe("Invalid or expired pairing code");
  });

  it("rejects claim when claimingUserId does not match", () => {
    const code = createPairingRequest("user-1", "TestUser");
    const result = claimPairingCode(code, undefined, "user-2");
    expect(result.request).toBeNull();
    expect(result.error).toBe("This pairing code was not generated for your account");
  });

  it("accepts claim when claimingUserId matches", () => {
    const code = createPairingRequest("user-1", "TestUser");
    const result = claimPairingCode(code, undefined, "user-1");
    expect(result.request).not.toBeNull();
  });
});

describe("checkClaimRateLimit", () => {
  it("allows first attempt", () => {
    expect(checkClaimRateLimit("rl-source-1")).toBe(true);
  });

  it("allows up to max attempts in a window", () => {
    for (let i = 0; i < CLAIM_RATE_LIMIT_MAX_ATTEMPTS; i++) {
      expect(checkClaimRateLimit("rl-source-2")).toBe(true);
    }
  });

  it("blocks attempt beyond max in same window", () => {
    for (let i = 0; i < CLAIM_RATE_LIMIT_MAX_ATTEMPTS; i++) {
      checkClaimRateLimit("rl-source-3");
    }
    expect(checkClaimRateLimit("rl-source-3")).toBe(false);
  });

  it("resets after window expires", () => {
    for (let i = 0; i < CLAIM_RATE_LIMIT_MAX_ATTEMPTS; i++) {
      checkClaimRateLimit("rl-source-4");
    }
    expect(checkClaimRateLimit("rl-source-4")).toBe(false);

    vi.advanceTimersByTime(CLAIM_RATE_LIMIT_WINDOW_MS + 1);
    expect(checkClaimRateLimit("rl-source-4")).toBe(true);
  });
});

describe("claimPairingCode rate limiting", () => {
  it("returns rate limit error when sourceId is rate-limited", () => {
    for (let i = 0; i < CLAIM_RATE_LIMIT_MAX_ATTEMPTS; i++) {
      checkClaimRateLimit("rate-src-a");
    }
    const code = createPairingRequest("user-1", "TestUser");
    const result = claimPairingCode(code, "rate-src-a");
    expect(result.request).toBeNull();
    expect(result.error).toBe("Rate limited. Try again in 1 minute.");
  });

  it("skips rate limit check when sourceId is not provided", () => {
    const code = createPairingRequest("user-1", "TestUser");
    const result = claimPairingCode(code);
    expect(result.request).not.toBeNull();
  });
});

describe("cleanupExpiredPairings", () => {
  it("removes expired pairings", () => {
    const code = createPairingRequest("user-1", "TestUser");
    vi.advanceTimersByTime(PAIRING_CODE_TTL_MS + 1);
    cleanupExpiredPairings();
    expect(getPairingRequest(code)).toBeNull();
  });

  it("keeps non-expired pairings", () => {
    const code = createPairingRequest("user-1", "TestUser");
    vi.advanceTimersByTime(PAIRING_CODE_TTL_MS - 1000);
    cleanupExpiredPairings();
    expect(getPairingRequest(code)).not.toBeNull();
  });

  it("cleans up stale rate limit entries", () => {
    for (let i = 0; i < CLAIM_RATE_LIMIT_MAX_ATTEMPTS; i++) {
      checkClaimRateLimit("cleanup-src");
    }
    expect(checkClaimRateLimit("cleanup-src")).toBe(false);

    vi.advanceTimersByTime(CLAIM_RATE_LIMIT_WINDOW_MS + 1);
    cleanupExpiredPairings();

    // After cleanup, window is reset so first call starts a new window
    expect(checkClaimRateLimit("cleanup-src")).toBe(true);
  });
});

describe("getPairingRequest", () => {
  it("returns a valid pending request", () => {
    const code = createPairingRequest("user-1", "TestUser");
    const req = getPairingRequest(code);
    expect(req).not.toBeNull();
    expect(req?.code).toBe(code);
    expect(req?.discordUserId).toBe("user-1");
  });

  it("returns null for unknown code", () => {
    expect(getPairingRequest("NOPE1234")).toBeNull();
  });

  it("returns null and cleans up expired request", () => {
    const code = createPairingRequest("user-1", "TestUser");
    vi.advanceTimersByTime(PAIRING_CODE_TTL_MS + 1);
    expect(getPairingRequest(code)).toBeNull();
    expect(getPairingRequest(code)).toBeNull();
  });

  it("normalizes code input", () => {
    const code = createPairingRequest("user-1", "TestUser");
    expect(getPairingRequest(`  ${code.toLowerCase()}  `)).not.toBeNull();
  });
});

describe("listPairingRequests", () => {
  it("returns empty array when no requests", () => {
    expect(listPairingRequests()).toEqual([]);
  });

  it("returns all valid requests", () => {
    createPairingRequest("user-1", "Alice");
    createPairingRequest("user-2", "Bob");
    const list = listPairingRequests();
    expect(list).toHaveLength(2);
  });

  it("excludes expired requests", () => {
    createPairingRequest("user-1", "Alice");
    vi.advanceTimersByTime(PAIRING_CODE_TTL_MS + 1);
    createPairingRequest("user-2", "Bob");

    const list = listPairingRequests();
    expect(list).toHaveLength(1);
    expect(list[0].discordUserId).toBe("user-2");
  });
});

describe("hasOwner", () => {
  function makeCtx(config: Record<string, unknown>): WOPRPluginContext {
    return {
      getConfig: () => config,
      saveConfig: vi.fn(),
    } as unknown as WOPRPluginContext;
  }

  it("returns false when ownerUserId is not set", () => {
    expect(hasOwner(makeCtx({}))).toBe(false);
  });

  it("returns false when ownerUserId is empty string", () => {
    expect(hasOwner(makeCtx({ ownerUserId: "" }))).toBe(false);
  });

  it("returns true when ownerUserId is set", () => {
    expect(hasOwner(makeCtx({ ownerUserId: "12345" }))).toBe(true);
  });
});

describe("setOwner", () => {
  it("sets ownerUserId in config and saves", async () => {
    const config: Record<string, unknown> = {};
    const saveConfig = vi.fn().mockResolvedValue(undefined);
    const ctx = {
      getConfig: () => config,
      saveConfig,
    } as unknown as WOPRPluginContext;

    await setOwner(ctx, "user-123");

    expect(config.ownerUserId).toBe("user-123");
    expect(saveConfig).toHaveBeenCalledWith(config);
  });
});

describe("buildPairingMessage", () => {
  it("includes the pairing code in backticks", () => {
    const msg = buildPairingMessage("ABCD1234");
    expect(msg).toContain("`ABCD1234`");
  });

  it("includes the CLI claim command", () => {
    const msg = buildPairingMessage("ABCD1234");
    expect(msg).toContain("wopr discord claim ABCD1234");
  });

  it("mentions 15 minute expiry", () => {
    const msg = buildPairingMessage("ABCD1234");
    expect(msg).toContain("15 minutes");
  });
});
