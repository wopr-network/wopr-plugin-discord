/**
 * Discord Owner Pairing
 *
 * Allows the bot owner to claim ownership via a pairing code.
 * The owner DMs the bot, receives a code, then runs the CLI command.
 */

import crypto from "node:crypto";
import type { WOPRPluginContext } from "./types.js";

// Pairing code settings
const PAIRING_CODE_LENGTH = 8;
const PAIRING_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // No ambiguous chars
const PAIRING_CODE_TTL_MS = 15 * 60 * 1000; // 15 minutes

// Rate limiting for claim attempts
const CLAIM_RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 minute window
const CLAIM_RATE_LIMIT_MAX_ATTEMPTS = 5; // max 5 attempts per window

interface ClaimAttempt {
  count: number;
  windowStart: number;
}

// Track claim attempts by source identifier
const claimAttempts: Map<string, ClaimAttempt> = new Map();

/**
 * Pending pairing request
 */
export interface PairingRequest {
  code: string;
  discordUserId: string;
  discordUsername: string;
  createdAt: number;
  claimed: boolean;
}

// In-memory store for pending pairing requests
const pendingPairings: Map<string, PairingRequest> = new Map();

/**
 * Generate a random pairing code
 */
function generateCode(): string {
  let code = "";
  for (let i = 0; i < PAIRING_CODE_LENGTH; i++) {
    const idx = crypto.randomInt(0, PAIRING_CODE_ALPHABET.length);
    code += PAIRING_CODE_ALPHABET[idx];
  }
  return code;
}

/**
 * Generate a unique pairing code
 */
function generateUniqueCode(): string {
  const existingCodes = new Set(Array.from(pendingPairings.values()).map((p) => p.code));
  for (let attempt = 0; attempt < 100; attempt++) {
    const code = generateCode();
    if (!existingCodes.has(code)) {
      return code;
    }
  }
  throw new Error("Failed to generate unique pairing code");
}

/**
 * Create a pairing request for a Discord user
 */
export function createPairingRequest(discordUserId: string, discordUsername: string): string {
  // Check if there's already a pending request for this user
  for (const [_code, request] of pendingPairings) {
    if (request.discordUserId === discordUserId) {
      // Refresh the existing request
      request.createdAt = Date.now();
      return request.code;
    }
  }

  // Create new pairing request
  const code = generateUniqueCode();
  pendingPairings.set(code, {
    code,
    discordUserId,
    discordUsername,
    createdAt: Date.now(),
    claimed: false,
  });

  return code;
}

/**
 * Check if a claim source is rate-limited.
 * Returns true if the attempt is allowed, false if rate-limited.
 */
export function checkClaimRateLimit(sourceId: string): boolean {
  const now = Date.now();
  const attempt = claimAttempts.get(sourceId);

  if (!attempt || now - attempt.windowStart > CLAIM_RATE_LIMIT_WINDOW_MS) {
    claimAttempts.set(sourceId, { count: 1, windowStart: now });
    return true;
  }

  attempt.count++;
  if (attempt.count > CLAIM_RATE_LIMIT_MAX_ATTEMPTS) {
    return false;
  }

  return true;
}

/**
 * Claim a pairing code.
 * sourceId is used for rate limiting (e.g. Discord user ID or IP).
 * claimingUserId, if provided, must match the user who generated the code.
 */
export function claimPairingCode(
  code: string,
  sourceId?: string,
  claimingUserId?: string,
): { request: PairingRequest | null; error?: string } {
  // Rate limit check
  if (sourceId && !checkClaimRateLimit(sourceId)) {
    return { request: null, error: "Rate limited. Try again in 1 minute." };
  }

  const normalizedCode = code.trim().toUpperCase();
  const request = pendingPairings.get(normalizedCode);

  if (!request) {
    return { request: null, error: "Invalid or expired pairing code" };
  }

  // Check expiry
  if (Date.now() - request.createdAt > PAIRING_CODE_TTL_MS) {
    pendingPairings.delete(normalizedCode);
    return { request: null, error: "Pairing code has expired" };
  }

  // Check if already claimed (race condition guard)
  if (request.claimed) {
    return { request: null, error: "Pairing code has already been claimed" };
  }

  // Bind check: code must be claimed by the same Discord user who generated it
  if (claimingUserId && request.discordUserId !== claimingUserId) {
    return { request: null, error: "This pairing code was not generated for your account" };
  }

  // Mark as claimed and remove
  request.claimed = true;
  pendingPairings.delete(normalizedCode);
  return { request };
}

/**
 * Get a pending pairing request by code (for display).
 * @public Part of the Discord plugin extension API.
 */
export function getPairingRequest(code: string): PairingRequest | null {
  const normalizedCode = code.trim().toUpperCase();
  const request = pendingPairings.get(normalizedCode);

  if (!request) {
    return null;
  }

  // Check expiry
  if (Date.now() - request.createdAt > PAIRING_CODE_TTL_MS) {
    pendingPairings.delete(normalizedCode);
    return null;
  }

  return request;
}

/**
 * List all pending pairing requests (for admin).
 * @public Part of the Discord plugin extension API.
 */
export function listPairingRequests(): PairingRequest[] {
  const now = Date.now();
  const valid: PairingRequest[] = [];

  for (const [code, request] of pendingPairings) {
    if (now - request.createdAt <= PAIRING_CODE_TTL_MS) {
      valid.push(request);
    } else {
      pendingPairings.delete(code);
    }
  }

  return valid;
}

/**
 * Clean up expired pairing requests and stale rate limit entries
 */
export function cleanupExpiredPairings(): void {
  const now = Date.now();
  for (const [code, request] of pendingPairings) {
    if (now - request.createdAt > PAIRING_CODE_TTL_MS) {
      pendingPairings.delete(code);
    }
  }
  for (const [sourceId, attempt] of claimAttempts) {
    if (now - attempt.windowStart > CLAIM_RATE_LIMIT_WINDOW_MS) {
      claimAttempts.delete(sourceId);
    }
  }
}

/**
 * Build the pairing message to send to the user
 */
export function buildPairingMessage(code: string): string {
  return [
    "**Owner Pairing Required**",
    "",
    `Your pairing code is: \`${code}\``,
    "",
    "To become the bot owner, run this command:",
    "```",
    `wopr discord claim ${code}`,
    "```",
    "",
    "_This code expires in 15 minutes._",
  ].join("\n");
}

/**
 * Check if the Discord plugin has an owner configured
 */
export function hasOwner(ctx: WOPRPluginContext): boolean {
  const config = ctx.getConfig<{ ownerUserId?: string }>();
  return !!config.ownerUserId;
}

/**
 * Set the owner in the Discord plugin config
 */
export async function setOwner(ctx: WOPRPluginContext, discordUserId: string): Promise<void> {
  const config = ctx.getConfig<Record<string, unknown>>();
  config.ownerUserId = discordUserId;
  await ctx.saveConfig(config);
}
