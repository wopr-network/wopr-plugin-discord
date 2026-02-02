/**
 * Discord Owner Pairing
 *
 * Allows the bot owner to claim ownership via a pairing code.
 * The owner DMs the bot, receives a code, then runs the CLI command.
 */

import crypto from "crypto";
import type { WOPRPluginContext } from "./types.js";

// Pairing code settings
const PAIRING_CODE_LENGTH = 8;
const PAIRING_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // No ambiguous chars
const PAIRING_CODE_TTL_MS = 15 * 60 * 1000; // 15 minutes

/**
 * Pending pairing request
 */
interface PairingRequest {
  code: string;
  discordUserId: string;
  discordUsername: string;
  createdAt: number;
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
  const existingCodes = new Set(Array.from(pendingPairings.values()).map(p => p.code));
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
  for (const [code, request] of pendingPairings) {
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
  });

  return code;
}

/**
 * Claim a pairing code
 * Returns the Discord user info if valid, null if invalid/expired
 */
export function claimPairingCode(code: string): PairingRequest | null {
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

  // Valid - remove and return
  pendingPairings.delete(normalizedCode);
  return request;
}

/**
 * Get a pending pairing request by code (for display)
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
 * List all pending pairing requests (for admin)
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
 * Clean up expired pairing requests
 */
export function cleanupExpiredPairings(): void {
  const now = Date.now();
  for (const [code, request] of pendingPairings) {
    if (now - request.createdAt > PAIRING_CODE_TTL_MS) {
      pendingPairings.delete(code);
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
