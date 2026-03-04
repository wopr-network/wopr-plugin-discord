import { describe, expect, it } from "vitest";
import {
  autocompleteFocusedSchema,
  modelInputSchema,
  pairingCodeSchema,
  sanitize,
  sessionNameSchema,
  thinkLevelSchema,
  usageModeSchema,
  validateInput,
  woprMessageSchema,
} from "./validation.js";

// ============================================================================
// sanitize()
// ============================================================================

describe("sanitize", () => {
  it("passes through normal text unchanged", () => {
    expect(sanitize("hello world")).toBe("hello world");
  });

  it("preserves tabs and newlines", () => {
    expect(sanitize("line1\n\tline2\r\n")).toBe("line1\n\tline2");
  });

  it("strips C0 control characters (except tab/newline/CR)", () => {
    expect(sanitize("ab\x00cd\x01ef\x08gh")).toBe("abcdefgh");
  });

  it("strips C1 control characters", () => {
    expect(sanitize("ab\x7Fcd\x80ef\x9Fgh")).toBe("abcdefgh");
  });

  it("strips zero-width characters", () => {
    expect(sanitize("ab\u200Bcd\u200Fef\uFEFFgh")).toBe("abcdefgh");
  });

  it("strips Unicode line/paragraph separators", () => {
    expect(sanitize("ab\u2028cd\u2029ef")).toBe("abcdef");
  });

  it("trims leading and trailing whitespace", () => {
    expect(sanitize("  hello  ")).toBe("hello");
  });

  it("handles empty string", () => {
    expect(sanitize("")).toBe("");
  });

  it("handles string that is only control characters", () => {
    expect(sanitize("\x00\x01\x02")).toBe("");
  });
});

// ============================================================================
// thinkLevelSchema
// ============================================================================

describe("thinkLevelSchema", () => {
  it.each(["off", "minimal", "low", "medium", "high", "xhigh"])("accepts '%s'", (val) => {
    expect(thinkLevelSchema.safeParse(val).success).toBe(true);
  });

  it("rejects invalid value", () => {
    expect(thinkLevelSchema.safeParse("ultra").success).toBe(false);
  });

  it("rejects non-string", () => {
    expect(thinkLevelSchema.safeParse(42).success).toBe(false);
  });
});

// ============================================================================
// usageModeSchema
// ============================================================================

describe("usageModeSchema", () => {
  it.each(["off", "tokens", "full"])("accepts '%s'", (val) => {
    expect(usageModeSchema.safeParse(val).success).toBe(true);
  });

  it("rejects invalid value", () => {
    expect(usageModeSchema.safeParse("verbose").success).toBe(false);
  });
});

// ============================================================================
// sessionNameSchema
// ============================================================================

describe("sessionNameSchema", () => {
  it("accepts valid alphanumeric with hyphens and underscores", () => {
    expect(sessionNameSchema.safeParse("my-session_01").success).toBe(true);
  });

  it("accepts single character", () => {
    expect(sessionNameSchema.safeParse("a").success).toBe(true);
  });

  it("accepts 64-character name", () => {
    expect(sessionNameSchema.safeParse("a".repeat(64)).success).toBe(true);
  });

  it("rejects empty string", () => {
    const r = sessionNameSchema.safeParse("");
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0].message).toBe("Session name cannot be empty");
  });

  it("rejects name over 64 characters", () => {
    const r = sessionNameSchema.safeParse("a".repeat(65));
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0].message).toBe("Session name must be 64 characters or fewer");
  });

  it("rejects path traversal dots", () => {
    expect(sessionNameSchema.safeParse("../etc/passwd").success).toBe(false);
  });

  it("rejects slashes", () => {
    expect(sessionNameSchema.safeParse("foo/bar").success).toBe(false);
  });

  it("rejects backslashes", () => {
    expect(sessionNameSchema.safeParse("foo\\bar").success).toBe(false);
  });

  it("rejects spaces", () => {
    expect(sessionNameSchema.safeParse("my session").success).toBe(false);
  });

  it("rejects special characters", () => {
    expect(sessionNameSchema.safeParse("hello!@#$").success).toBe(false);
  });

  it("rejects null bytes", () => {
    expect(sessionNameSchema.safeParse("foo\x00bar").success).toBe(false);
  });
});

// ============================================================================
// pairingCodeSchema
// ============================================================================

describe("pairingCodeSchema", () => {
  it("accepts valid uppercase code", () => {
    expect(pairingCodeSchema.safeParse("AB2C9DEF").success).toBe(true);
  });

  it("accepts lowercase (case-insensitive regex)", () => {
    expect(pairingCodeSchema.safeParse("ab2c9def").success).toBe(true);
  });

  it("rejects empty string", () => {
    const r = pairingCodeSchema.safeParse("");
    expect(r.success).toBe(false);
  });

  it("rejects string not exactly 8 characters", () => {
    expect(pairingCodeSchema.safeParse("A".repeat(7)).success).toBe(false);
    expect(pairingCodeSchema.safeParse("A".repeat(9)).success).toBe(false);
  });

  it("accepts exactly 8 characters", () => {
    expect(pairingCodeSchema.safeParse("A".repeat(8)).success).toBe(true);
  });

  it("rejects characters outside alphabet (0, 1)", () => {
    expect(pairingCodeSchema.safeParse("AB01").success).toBe(false);
  });

  it("rejects special characters", () => {
    expect(pairingCodeSchema.safeParse("AB-CD").success).toBe(false);
  });
});

// ============================================================================
// modelInputSchema
// ============================================================================

describe("modelInputSchema", () => {
  it("accepts typical model name", () => {
    expect(modelInputSchema.safeParse("gpt-4o").success).toBe(true);
  });

  it("accepts model with slashes, dots, colons", () => {
    expect(modelInputSchema.safeParse("anthropic/claude-3.5:latest").success).toBe(true);
  });

  it("rejects empty string", () => {
    expect(modelInputSchema.safeParse("").success).toBe(false);
  });

  it("rejects string over 128 characters", () => {
    expect(modelInputSchema.safeParse("a".repeat(129)).success).toBe(false);
  });

  it("rejects spaces", () => {
    expect(modelInputSchema.safeParse("gpt 4").success).toBe(false);
  });

  it("rejects special characters", () => {
    expect(modelInputSchema.safeParse("model;drop").success).toBe(false);
  });
});

// ============================================================================
// woprMessageSchema
// ============================================================================

describe("woprMessageSchema", () => {
  it("accepts normal message", () => {
    expect(woprMessageSchema.safeParse("Hello, how are you?").success).toBe(true);
  });

  it("accepts message with special characters and unicode", () => {
    expect(woprMessageSchema.safeParse("Hello! @#$ \u{1F600}").success).toBe(true);
  });

  it("rejects empty string", () => {
    expect(woprMessageSchema.safeParse("").success).toBe(false);
  });

  it("rejects string over 4000 characters", () => {
    expect(woprMessageSchema.safeParse("a".repeat(4001)).success).toBe(false);
  });

  it("accepts exactly 4000 characters", () => {
    expect(woprMessageSchema.safeParse("a".repeat(4000)).success).toBe(true);
  });
});

// ============================================================================
// autocompleteFocusedSchema
// ============================================================================

describe("autocompleteFocusedSchema", () => {
  it("accepts normal search text", () => {
    expect(autocompleteFocusedSchema.safeParse("claude").success).toBe(true);
  });

  it("accepts empty string", () => {
    expect(autocompleteFocusedSchema.safeParse("").success).toBe(true);
  });

  it("rejects string over 128 characters", () => {
    expect(autocompleteFocusedSchema.safeParse("a".repeat(129)).success).toBe(false);
  });
});

// ============================================================================
// validateInput()
// ============================================================================

describe("validateInput", () => {
  it("returns success with data for valid input", () => {
    const result = validateInput(sessionNameSchema, "my-session");
    expect(result).toEqual({ success: true, data: "my-session" });
  });

  it("returns error string for invalid input", () => {
    const result = validateInput(sessionNameSchema, "");
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBe("Session name cannot be empty");
    }
  });

  it("returns first issue message when multiple errors exist", () => {
    const result = validateInput(sessionNameSchema, "");
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(typeof result.error).toBe("string");
    }
  });

  it("returns error string when input fails type check", () => {
    const result = validateInput(sessionNameSchema, 123);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(typeof result.error).toBe("string");
      expect(result.error.length).toBeGreaterThan(0);
    }
  });

  it("returns 'Invalid input' as fallback when issues array is empty", () => {
    // Exercise the `?? "Invalid input"` defensive branch in validateInput
    const noIssuesSchema = {
      safeParse: () => ({ success: false as const, error: { issues: [] } }),
    } as unknown as Parameters<typeof validateInput>[0];
    const result = validateInput(noIssuesSchema, "anything");
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBe("Invalid input");
    }
  });

  it("works with enum schemas", () => {
    expect(validateInput(thinkLevelSchema, "high")).toEqual({ success: true, data: "high" });
    expect(validateInput(thinkLevelSchema, "invalid").success).toBe(false);
  });
});
