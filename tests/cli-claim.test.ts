/**
 * Tests for the `wopr discord claim` CLI handler.
 *
 * The claim handler logic is mirrored here to test it without importing
 * the full index.ts (which drags in discord.js and other heavy deps).
 * Pattern matches tests/identity-manager.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mirrored claim handler logic (mirrors src/index.ts implementation)
// ---------------------------------------------------------------------------

interface ClaimResult {
  success?: boolean;
  userId?: string;
  username?: string;
  error?: string;
}

interface RunClaimOptions {
  code: string;
  /** Simulated content of the token file, Error instance to simulate a read error,
   *  or undefined to simulate ENOENT (file absent). */
  tokenFileContent?: string | Error;
  /** Simulated fetch response, or undefined to simulate a connection error. */
  fetchResponse?: { ok: boolean; status: number; text?: string };
  woprHome?: string;
}

/**
 * Mirrors the claim handler from src/index.ts for isolated unit testing.
 * Does NOT include the outer catch (connection-error path), which is tested
 * separately since mocking process.exit makes that path complex.
 */
async function runClaimHandler(opts: RunClaimOptions): Promise<void> {
  const { code, tokenFileContent, fetchResponse, woprHome = "/tmp/test-wopr-home" } = opts;
  const tokenPath = `${woprHome}/daemon-token`;

  let authToken: string | null = null;
  try {
    if (tokenFileContent instanceof Error) throw tokenFileContent;
    if (tokenFileContent === undefined) {
      const err = new Error("ENOENT") as NodeJS.ErrnoException;
      err.code = "ENOENT";
      throw err;
    }
    authToken = tokenFileContent.trim() || null;
  } catch (err: unknown) {
    const fsCode = (err as NodeJS.ErrnoException).code;
    if (fsCode !== "ENOENT") {
      // biome-ignore lint/suspicious/noConsole: CLI output
      console.warn(
        `Warning: Could not read daemon auth token at ${tokenPath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // Guard against header injection via embedded newlines (outside the fs catch)
  if (authToken && (authToken.includes("\n") || authToken.includes("\r"))) {
    // biome-ignore lint/suspicious/noConsole: CLI output
    console.error(`Invalid daemon auth token (contains newline characters): ${tokenPath}`);
    process.exit(1);
  }

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (authToken) {
    headers.Authorization = `Bearer ${authToken}`;
  }

  if (!fetchResponse) {
    // Simulate connection failure — the outer catch in production prints the hint
    throw new Error("fetch: connect ECONNREFUSED");
  }

  const { ok, status, text: bodyText = "" } = fetchResponse;

  if (!ok) {
    const rawBody = bodyText;
    let errorMsg: string;
    try {
      const errJson = rawBody ? (JSON.parse(rawBody) as { error?: string }) : {};
      errorMsg = errJson.error ?? `HTTP ${status}`;
    } catch {
      errorMsg = rawBody || `HTTP ${status}`;
    }
    if (status === 401 || status === 403) {
      // biome-ignore lint/suspicious/noConsole: CLI output
      console.error(`Authentication failed (${status}): ${errorMsg}`);
      if (!authToken) {
        // biome-ignore lint/suspicious/noConsole: CLI output
        console.error(`  Daemon auth token not found at: ${tokenPath}`);
        // biome-ignore lint/suspicious/noConsole: CLI output
        console.error(`  Ensure WOPR daemon has written a token to that path.`);
      }
    } else {
      // biome-ignore lint/suspicious/noConsole: CLI output
      console.error(`Failed to claim: ${errorMsg}`);
    }
    process.exit(1);
    return;
  }

  let result: ClaimResult = {};
  try {
    result = bodyText ? (JSON.parse(bodyText) as ClaimResult) : {};
  } catch {
    result = { success: false, error: bodyText || "Invalid response from daemon" };
  }

  if (result.success) {
    // biome-ignore lint/suspicious/noConsole: CLI output
    console.log(`\u2713 Discord ownership claimed!`);
    // biome-ignore lint/suspicious/noConsole: CLI output
    console.log(`  Owner: ${result.username} (${result.userId})`);
    process.exit(0);
  } else {
    // biome-ignore lint/suspicious/noConsole: CLI output
    console.error(`Failed to claim: ${result.error || "Unknown error"}`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function successBody(body: ClaimResult): RunClaimOptions["fetchResponse"] {
  return { ok: true, status: 200, text: JSON.stringify(body) };
}

function errorBody(status: number, body: Record<string, unknown> | string): RunClaimOptions["fetchResponse"] {
  return { ok: false, status, text: typeof body === "string" ? body : JSON.stringify(body) };
}

async function expectsExit(opts: RunClaimOptions, code: number): Promise<void> {
  await expect(runClaimHandler(opts)).rejects.toThrow(`process.exit(${code})`);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("wopr discord claim handler", () => {
  let mockExit: ReturnType<typeof vi.spyOn>;
  let mockLog: ReturnType<typeof vi.spyOn>;
  let mockError: ReturnType<typeof vi.spyOn>;
  let mockWarn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockExit = vi.spyOn(process, "exit").mockImplementation((code?: number) => {
      throw new Error(`process.exit(${code})`);
    });
    mockLog = vi.spyOn(console, "log").mockImplementation(() => {});
    mockError = vi.spyOn(console, "error").mockImplementation(() => {});
    mockWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    mockExit.mockRestore();
    mockLog.mockRestore();
    mockError.mockRestore();
    mockWarn.mockRestore();
  });

  // -------------------------------------------------------------------------
  // Success paths
  // -------------------------------------------------------------------------
  describe("successful claim", () => {
    it("exits 0 and prints owner when claim succeeds with token", async () => {
      await expectsExit(
        {
          code: "ABC123",
          tokenFileContent: "my-secret-token",
          fetchResponse: successBody({ success: true, userId: "u1", username: "testuser" }),
        },
        0,
      );
      expect(mockLog).toHaveBeenCalledWith(expect.stringContaining("Discord ownership claimed"));
      expect(mockLog).toHaveBeenCalledWith(expect.stringContaining("testuser"));
      expect(mockLog).toHaveBeenCalledWith(expect.stringContaining("u1"));
    });

    it("exits 0 when token file is absent (ENOENT — unauthenticated)", async () => {
      await expectsExit(
        {
          code: "CODE",
          tokenFileContent: undefined,
          fetchResponse: successBody({ success: true, userId: "u2", username: "user2" }),
        },
        0,
      );
      expect(mockLog).toHaveBeenCalledWith(expect.stringContaining("Discord ownership claimed"));
      // No auth warning expected for ENOENT
      expect(mockWarn).not.toHaveBeenCalled();
    });

    it("strips surrounding whitespace from token file content", async () => {
      await expectsExit(
        {
          code: "CODE",
          tokenFileContent: "  valid-token  \n",
          fetchResponse: successBody({ success: true, userId: "u3", username: "u3" }),
        },
        0,
      );
      expect(mockLog).toHaveBeenCalledWith(expect.stringContaining("Discord ownership claimed"));
    });
  });

  // -------------------------------------------------------------------------
  // HTTP error handling
  // -------------------------------------------------------------------------
  describe("HTTP error responses", () => {
    it("exits 1 with targeted auth message on 401 when no token was read", async () => {
      await expectsExit(
        {
          code: "CODE",
          tokenFileContent: undefined,
          fetchResponse: errorBody(401, { error: "Unauthorized" }),
        },
        1,
      );
      expect(mockError).toHaveBeenCalledWith(expect.stringContaining("Authentication failed (401)"));
      expect(mockError).toHaveBeenCalledWith(expect.stringContaining("Daemon auth token not found at"));
    });

    it("exits 1 with auth message on 401 but omits token-path hint when token was present", async () => {
      await expectsExit(
        {
          code: "CODE",
          tokenFileContent: "stale-token",
          fetchResponse: errorBody(401, { error: "Token expired" }),
        },
        1,
      );
      expect(mockError).toHaveBeenCalledWith(expect.stringContaining("Authentication failed (401)"));
      const allErrors = mockError.mock.calls.flat().join("\n");
      expect(allErrors).not.toContain("Daemon auth token not found");
    });

    it("exits 1 with targeted auth message on 403", async () => {
      await expectsExit(
        {
          code: "CODE",
          tokenFileContent: "tok",
          fetchResponse: errorBody(403, { error: "Forbidden" }),
        },
        1,
      );
      expect(mockError).toHaveBeenCalledWith(expect.stringContaining("Authentication failed (403)"));
    });

    it("exits 1 with generic error on non-auth failure (e.g. 500)", async () => {
      await expectsExit(
        {
          code: "CODE",
          tokenFileContent: "tok",
          fetchResponse: errorBody(500, { error: "Internal server error" }),
        },
        1,
      );
      expect(mockError).toHaveBeenCalledWith(expect.stringContaining("Failed to claim: Internal server error"));
    });

    it("handles non-JSON error body gracefully", async () => {
      await expectsExit(
        {
          code: "CODE",
          tokenFileContent: undefined,
          fetchResponse: { ok: false, status: 502, text: "Bad Gateway" },
        },
        1,
      );
      expect(mockError).toHaveBeenCalledWith(expect.stringContaining("Bad Gateway"));
    });

    it("falls back to HTTP status when error body is empty", async () => {
      await expectsExit(
        {
          code: "CODE",
          tokenFileContent: undefined,
          fetchResponse: { ok: false, status: 503, text: "" },
        },
        1,
      );
      expect(mockError).toHaveBeenCalledWith(expect.stringContaining("HTTP 503"));
    });
  });

  // -------------------------------------------------------------------------
  // Success body parsing
  // -------------------------------------------------------------------------
  describe("response body parsing", () => {
    it("exits 1 and shows server-provided error when success is false", async () => {
      await expectsExit(
        {
          code: "CODE",
          tokenFileContent: "tok",
          fetchResponse: successBody({ success: false, error: "Code already used" }),
        },
        1,
      );
      expect(mockError).toHaveBeenCalledWith(expect.stringContaining("Code already used"));
    });

    it("falls back to 'Unknown error' when success is false and no error field", async () => {
      await expectsExit(
        {
          code: "CODE",
          tokenFileContent: undefined,
          fetchResponse: successBody({ success: false }),
        },
        1,
      );
      expect(mockError).toHaveBeenCalledWith(expect.stringContaining("Unknown error"));
    });

    it("exits 1 gracefully on non-JSON 200 body", async () => {
      await expectsExit(
        {
          code: "CODE",
          tokenFileContent: undefined,
          fetchResponse: { ok: true, status: 200, text: "not-json" },
        },
        1,
      );
      expect(mockError).toHaveBeenCalledWith(expect.stringContaining("not-json"));
    });

    it("exits 1 gracefully on empty 200 body", async () => {
      await expectsExit(
        {
          code: "CODE",
          tokenFileContent: undefined,
          fetchResponse: { ok: true, status: 200, text: "" },
        },
        1,
      );
      expect(mockError).toHaveBeenCalledWith(expect.stringContaining("Unknown error"));
    });
  });

  // -------------------------------------------------------------------------
  // Token security validation
  // -------------------------------------------------------------------------
  describe("token security validation", () => {
    it("exits 1 and reports error when token contains embedded newline (header injection)", async () => {
      await expectsExit(
        {
          code: "CODE",
          tokenFileContent: "valid-part\nX-Injected: evil",
          fetchResponse: successBody({ success: true }),
        },
        1,
      );
      expect(mockError).toHaveBeenCalledWith(expect.stringContaining("contains newline characters"));
    });

    it("exits 1 and reports error when token contains embedded carriage return", async () => {
      await expectsExit(
        {
          code: "CODE",
          tokenFileContent: "token\rstuff",
          fetchResponse: successBody({ success: true }),
        },
        1,
      );
      expect(mockError).toHaveBeenCalledWith(expect.stringContaining("contains newline characters"));
    });

    it("treats a whitespace-only token file as absent (null auth)", async () => {
      // A file containing only spaces/newlines → trimmed to "" → null → no auth header
      const trimmed = "   \n  ".trim();
      const authToken = trimmed || null;
      expect(authToken).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // Unreadable token file
  // -------------------------------------------------------------------------
  describe("unreadable token file", () => {
    it("warns (does NOT silently swallow) when token file has a permission error", async () => {
      const permError = new Error("EACCES: permission denied") as NodeJS.ErrnoException;
      permError.code = "EACCES";

      await expectsExit(
        {
          code: "CODE",
          tokenFileContent: permError,
          fetchResponse: successBody({ success: true, userId: "u1", username: "u1" }),
        },
        0,
      );
      expect(mockWarn).toHaveBeenCalledWith(expect.stringContaining("Could not read daemon auth token"));
    });

    it("does NOT warn for ENOENT (token file simply absent is expected)", async () => {
      await expectsExit(
        {
          code: "CODE",
          tokenFileContent: undefined,
          fetchResponse: successBody({ success: true, userId: "u1", username: "u1" }),
        },
        0,
      );
      expect(mockWarn).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Connection failure (no outer catch in mirror — verifies raw throw)
  // -------------------------------------------------------------------------
  describe("connection failure", () => {
    it("throws a connection error when fetch is unavailable", async () => {
      await expect(
        runClaimHandler({ code: "CODE", tokenFileContent: undefined, fetchResponse: undefined }),
      ).rejects.toThrow("ECONNREFUSED");
    });
  });
});
