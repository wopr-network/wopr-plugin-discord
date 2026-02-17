// Tests for Zod input validation on slash commands (WOP-585)
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
} from "../src/validation.js";

describe("sanitize()", () => {
  it("should remove null bytes", () => {
    expect(sanitize("hello\x00world")).toBe("helloworld");
  });

  it("should remove zero-width characters", () => {
    expect(sanitize("hello\u200Bworld")).toBe("helloworld");
  });

  it("should preserve newlines and tabs", () => {
    expect(sanitize("hello\nworld\ttab")).toBe("hello\nworld\ttab");
  });

  it("should trim whitespace", () => {
    expect(sanitize("  hello  ")).toBe("hello");
  });

  it("should handle empty string", () => {
    expect(sanitize("")).toBe("");
  });
});

describe("thinkLevelSchema", () => {
  it.each(["off", "minimal", "low", "medium", "high", "xhigh"])("should accept '%s'", (level) => {
    expect(validateInput(thinkLevelSchema, level).success).toBe(true);
  });

  it("should reject invalid values", () => {
    const result = validateInput(thinkLevelSchema, "ultra");
    expect(result.success).toBe(false);
  });
});

describe("usageModeSchema", () => {
  it.each(["off", "tokens", "full"])("should accept '%s'", (mode) => {
    expect(validateInput(usageModeSchema, mode).success).toBe(true);
  });

  it("should reject invalid values", () => {
    expect(validateInput(usageModeSchema, "verbose").success).toBe(false);
  });
});

describe("sessionNameSchema", () => {
  it("should accept valid names", () => {
    expect(validateInput(sessionNameSchema, "research").success).toBe(true);
    expect(validateInput(sessionNameSchema, "my-project_v2").success).toBe(true);
  });

  it("should reject empty string", () => {
    expect(validateInput(sessionNameSchema, "").success).toBe(false);
  });

  it("should reject names with spaces", () => {
    expect(validateInput(sessionNameSchema, "my project").success).toBe(false);
  });

  it("should reject names with path traversal", () => {
    expect(validateInput(sessionNameSchema, "../../../etc/passwd").success).toBe(false);
  });

  it("should reject names longer than 64 chars", () => {
    expect(validateInput(sessionNameSchema, "a".repeat(65)).success).toBe(false);
  });

  it("should reject names with special characters", () => {
    expect(validateInput(sessionNameSchema, "hello<script>").success).toBe(false);
  });
});

describe("pairingCodeSchema", () => {
  it("should accept valid codes", () => {
    expect(validateInput(pairingCodeSchema, "ABCD2345").success).toBe(true);
  });

  it("should reject empty string", () => {
    expect(validateInput(pairingCodeSchema, "").success).toBe(false);
  });

  it("should reject codes with invalid characters", () => {
    expect(validateInput(pairingCodeSchema, "ABC!@#$%").success).toBe(false);
  });

  it("should reject codes that are too long", () => {
    expect(validateInput(pairingCodeSchema, "A".repeat(17)).success).toBe(false);
  });
});

describe("modelInputSchema", () => {
  it("should accept valid model IDs", () => {
    expect(validateInput(modelInputSchema, "claude-opus-4-6").success).toBe(true);
    expect(validateInput(modelInputSchema, "gpt-5.2").success).toBe(true);
    expect(validateInput(modelInputSchema, "anthropic/claude-3.5-sonnet").success).toBe(true);
  });

  it("should reject empty string", () => {
    expect(validateInput(modelInputSchema, "").success).toBe(false);
  });

  it("should reject model names with spaces", () => {
    expect(validateInput(modelInputSchema, "my model").success).toBe(false);
  });

  it("should reject model names with shell metacharacters", () => {
    expect(validateInput(modelInputSchema, "model; rm -rf /").success).toBe(false);
    expect(validateInput(modelInputSchema, "model$(whoami)").success).toBe(false);
    expect(validateInput(modelInputSchema, "model`id`").success).toBe(false);
  });

  it("should reject model names longer than 128 chars", () => {
    expect(validateInput(modelInputSchema, "a".repeat(129)).success).toBe(false);
  });
});

describe("woprMessageSchema", () => {
  it("should accept normal messages", () => {
    expect(validateInput(woprMessageSchema, "Tell me a joke").success).toBe(true);
  });

  it("should reject empty string", () => {
    expect(validateInput(woprMessageSchema, "").success).toBe(false);
  });

  it("should reject messages over 4000 chars", () => {
    expect(validateInput(woprMessageSchema, "a".repeat(4001)).success).toBe(false);
  });

  it("should accept messages with unicode", () => {
    expect(validateInput(woprMessageSchema, "Hello! How are you doing today?").success).toBe(true);
  });
});

describe("autocompleteFocusedSchema", () => {
  it("should accept empty string", () => {
    const result = validateInput(autocompleteFocusedSchema, "");
    expect(result.success).toBe(true);
  });

  it("should accept partial model names", () => {
    expect(validateInput(autocompleteFocusedSchema, "opus").success).toBe(true);
  });

  it("should reject strings over 128 chars", () => {
    expect(validateInput(autocompleteFocusedSchema, "a".repeat(129)).success).toBe(false);
  });
});
