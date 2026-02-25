/**
 * Agent identity and reaction emoji management.
 *
 * Manages the cached agent identity (name, emoji, etc.) and
 * configurable reaction emojis used for message state indicators.
 */

import { logger } from "./logger.js";
import type { AgentIdentity, WOPRPluginContext } from "./types.js";

let agentIdentity: AgentIdentity = { name: "WOPR", emoji: "👀" };

let reactionEmojis = {
  queued: "🕐",
  active: "⚡",
  done: "✅",
  error: "❌",
  cancelled: "⏹️",
};

export function getAgentIdentity(): AgentIdentity {
  return agentIdentity;
}

export function setAgentIdentity(identity: AgentIdentity): void {
  agentIdentity = identity;
}

/**
 * Refresh identity from the plugin context and update reaction emojis.
 */
export async function refreshIdentity(ctx: WOPRPluginContext): Promise<void> {
  try {
    const identity = await ctx.getAgentIdentity();
    if (identity) {
      agentIdentity = { ...agentIdentity, ...identity };
      logger.info({ msg: "Identity refreshed", identity: agentIdentity });
    }
  } catch (e) {
    logger.warn({ msg: "Failed to refresh identity", error: String(e) });
  }
  await refreshReactionEmojis(ctx);
}

/**
 * Refresh reaction emojis from plugin config.
 */
export async function refreshReactionEmojis(ctx: WOPRPluginContext): Promise<void> {
  try {
    const config = ctx.getConfig<Record<string, unknown>>();
    if (config) {
      reactionEmojis = {
        queued: (config.emojiQueued as string) || "🕐",
        active: (config.emojiActive as string) || "⚡",
        done: (config.emojiDone as string) || "✅",
        error: (config.emojiError as string) || "❌",
        cancelled: (config.emojiCancelled as string) || "⏹️",
      };
      logger.info({ msg: "Reaction emojis refreshed", emojis: reactionEmojis });
    }
  } catch (e) {
    logger.warn({ msg: "Failed to refresh reaction emojis", error: String(e) });
  }
}

// Convenience getters for current reaction emojis
export const REACTION_QUEUED = () => reactionEmojis.queued;
export const REACTION_ACTIVE = () => reactionEmojis.active;
export const REACTION_DONE = () => reactionEmojis.done;
export const REACTION_ERROR = () => reactionEmojis.error;
export const REACTION_CANCELLED = () => reactionEmojis.cancelled;
