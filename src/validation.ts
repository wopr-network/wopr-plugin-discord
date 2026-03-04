import { z } from "zod";

// ============================================================================
// Sanitization
// ============================================================================

/**
 * Strip Unicode control characters (C0, C1, and misc invisible) except
 * newlines/tabs which are legitimate in messages. Trim whitespace.
 */
export function sanitize(input: string): string {
  // Remove C0 controls except \t \n \r, plus C1 controls, plus zero-width chars
  // biome-ignore lint/suspicious/noControlCharactersInRegex: This regex intentionally matches control characters for sanitization
  return input.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F\u200B-\u200F\u2028-\u202F\uFEFF]/g, "").trim();
}

// ============================================================================
// Schemas
// ============================================================================

/** /think level — constrained by Discord choices, but validate server-side too */
export const thinkLevelSchema = z.enum(["off", "minimal", "low", "medium", "high", "xhigh"]);

/** /usage mode — constrained by Discord choices */
export const usageModeSchema = z.enum(["off", "tokens", "full"]);

/** /session name — free-text, highest risk for path traversal / injection */
export const sessionNameSchema = z
  .string()
  .min(1, "Session name cannot be empty")
  .max(64, "Session name must be 64 characters or fewer")
  .regex(/^[a-zA-Z0-9_-]+$/, "Session name may only contain letters, numbers, hyphens, and underscores");

/** /claim code — should match the pairing code alphabet: [A-Z2-9], 8 chars */
export const pairingCodeSchema = z
  .string()
  .length(8, "Pairing code must be exactly 8 characters")
  .regex(/^[A-Z2-9]+$/i, "Pairing code contains invalid characters");

/** /model model — free-text with autocomplete */
export const modelInputSchema = z
  .string()
  .min(1, "Model name cannot be empty")
  .max(128, "Model name is too long")
  .regex(/^[a-zA-Z0-9._:/-]+$/, "Model name contains invalid characters");

/** /wopr message — free-text user prompt, most permissive */
export const woprMessageSchema = z
  .string()
  .min(1, "Message cannot be empty")
  .max(4000, "Message must be 4000 characters or fewer");

/** Autocomplete focused value — partial model text */
export const autocompleteFocusedSchema = z.string().max(128, "Search text is too long");

// ============================================================================
// Validate helper
// ============================================================================

export interface ValidationResult<T> {
  success: true;
  data: T;
}

export interface ValidationError {
  success: false;
  error: string;
}

export type ValidateResult<T> = ValidationResult<T> | ValidationError;

/**
 * Validate input against a Zod schema. Returns a discriminated union.
 * On failure, returns a user-friendly error string (first issue message).
 */
export function validateInput<T>(schema: z.ZodType<T>, input: unknown): ValidateResult<T> {
  const result = schema.safeParse(input);
  if (result.success) {
    return { success: true, data: result.data };
  }
  const firstIssue = result.error.issues[0];
  return { success: false, error: firstIssue?.message ?? "Invalid input" };
}
