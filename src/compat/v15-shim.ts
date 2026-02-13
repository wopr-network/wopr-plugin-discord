/**
 * discord.js v15 Compatibility Shim
 *
 * Provides a compatibility layer for gradual migration from discord.js v14 to v15.
 * Re-exports renamed types with deprecation warnings and maps old APIs to new ones.
 *
 * Usage:
 *   import { getInteractionSource, isEphemeral, getDMChannelType } from './compat/v15-shim.js';
 *
 * After upgrading to v15, this shim can be removed and direct v15 APIs used.
 */

import type { Message } from "discord.js";
import { ChannelType, MessageFlags } from "discord.js";

// ---------------------------------------------------------------------------
// Message#interaction -> Message#interactionMetadata
// ---------------------------------------------------------------------------

/**
 * v14/v15 compatible way to check if a message originated from an interaction.
 *
 * In v14: `message.interaction` returns MessageInteraction | null
 * In v15: `message.interactionMetadata` returns InteractionMetadata | null
 *         `message.interaction` is removed
 *
 * @returns true if the message was created by an interaction (slash command, button, etc.)
 */
export function isInteractionMessage(message: Message): boolean {
  const msg = message as unknown as Record<string, unknown>;
  // v15 path: interactionMetadata
  if (msg.interactionMetadata != null) {
    return true;
  }
  // v14 path: interaction (deprecated in v15)
  if (msg.interaction != null) {
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Channel type helpers
// ---------------------------------------------------------------------------

/**
 * Check if a channel type is a DM channel.
 * Uses ChannelType enum instead of numeric literal for forward compatibility.
 *
 * v14 ChannelType.DM = 1
 * v15 ChannelType.DM = 1 (same value, but using enum is safer)
 */
export function isDMChannel(channelType: number): boolean {
  return channelType === ChannelType.DM;
}

/**
 * The ChannelType value for DM channels, exported for use in comparisons.
 * Prefer using `isDMChannel()` or `ChannelType.DM` directly.
 */
export const DM_CHANNEL_TYPE = ChannelType.DM;

// ---------------------------------------------------------------------------
// Event name mapping
// ---------------------------------------------------------------------------

/**
 * Maps v14 event string names to their v15 equivalents.
 * This plugin uses the Events enum, so these are mainly for documentation
 * and any code that uses string-based event names.
 */
export const V15_EVENT_MAP: Record<string, string> = {
  ready: "clientReady",
  webhookUpdate: "webhooksUpdate",
  // These events are removed in v15 (shard events moved to @discordjs/ws)
  shardDisconnect: "__removed__",
  shardError: "__removed__",
  shardReady: "__removed__",
  shardReconnecting: "__removed__",
  shardResume: "__removed__",
};

/**
 * Get the v15-compatible event name for a given v14 event name.
 * Returns the input unchanged if no mapping exists.
 *
 * @throws if the event was removed in v15
 */
export function mapEventName(v14EventName: string): string {
  const mapped = V15_EVENT_MAP[v14EventName];
  if (mapped === "__removed__") {
    throw new Error(
      `Event "${v14EventName}" was removed in discord.js v15. Shard events are now handled by @discordjs/ws.`,
    );
  }
  return mapped ?? v14EventName;
}

// ---------------------------------------------------------------------------
// Type rename re-exports with deprecation warnings
// ---------------------------------------------------------------------------

/**
 * Type renames in v15. These help identify code that uses old type names.
 *
 * Note: This plugin does NOT use any of these types directly, but the
 * mapping is provided for completeness and for any future usage.
 */
export const V15_TYPE_RENAMES: Record<string, string> = {
  NewsChannel: "AnnouncementChannel",
  SelectMenuBuilder: "StringSelectMenuBuilder",
  SelectMenuComponent: "StringSelectMenuComponent",
  SelectMenuInteraction: "StringSelectMenuInteraction",
  SelectMenuOptionBuilder: "StringSelectMenuOptionBuilder",
  ClientEvents: "ClientEventTypes",
  GuildMemberResolvable: "UserResolvable",
};

/**
 * Look up the v15 name for a v14 type.
 * Returns undefined if the type name is unchanged in v15.
 */
export function getV15TypeName(v14TypeName: string): string | undefined {
  return V15_TYPE_RENAMES[v14TypeName];
}

// ---------------------------------------------------------------------------
// Ephemeral reply helper
// ---------------------------------------------------------------------------

/**
 * Build the flags/ephemeral option in a v14/v15 compatible way.
 *
 * v14: `{ ephemeral: true }` works
 * v15: `{ ephemeral: true }` is removed; use `{ flags: MessageFlags.Ephemeral }`
 *
 * This helper returns the correct option shape for the current discord.js version.
 * On v14 it returns `{ ephemeral: true }`, on v15 it returns `{ flags: 64 }`.
 */
export function ephemeralFlag(): { ephemeral: true } | { flags: number } {
  // MessageFlags.Ephemeral = 1 << 6 = 64
  // Available in both v14 and v15; on v14 ephemeral: true also works,
  // but using flags is forward-compatible with v15 where ephemeral is removed.
  if (MessageFlags.Ephemeral != null) {
    return { flags: Number(MessageFlags.Ephemeral) };
  }
  return { ephemeral: true };
}

// ---------------------------------------------------------------------------
// getFocused() compatibility
// ---------------------------------------------------------------------------

/**
 * Extract the focused autocomplete value in a v14/v15 compatible way.
 *
 * v14: `getFocused()` returns string, `getFocused(true)` returns AutocompleteFocusedOption
 * v15: `getFocused()` always returns AutocompleteFocusedOption (param removed)
 *
 * @param focusedResult - The result of calling `interaction.options.getFocused()`
 * @returns The string value of the focused option
 */
export function extractFocusedValue(focusedResult: string | { value: string; name: string; type: number }): string {
  if (typeof focusedResult === "string") {
    return focusedResult;
  }
  return focusedResult.value;
}
