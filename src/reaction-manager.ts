/**
 * Reaction Manager
 *
 * Manages state-indicating emoji reactions on Discord messages.
 * Uses configurable emojis from identity-manager for queued,
 * active, done, error, and cancelled states.
 */

import type { Client, Message } from "discord.js";
import {
  REACTION_ACTIVE,
  REACTION_CANCELLED,
  REACTION_DONE,
  REACTION_ERROR,
  REACTION_QUEUED,
} from "./identity-manager.js";
import { logger } from "./logger.js";

let discordClient: Client | null = null;

export function setReactionClient(c: Client | null): void {
  discordClient = c;
}

/**
 * Set reaction state on a message. Removes old state reactions first.
 */
export async function setMessageReaction(message: Message, reaction: string | (() => string)): Promise<void> {
  if (!discordClient?.user) return;

  const botId = discordClient.user.id;
  const stateReactions = [
    REACTION_QUEUED(),
    REACTION_ACTIVE(),
    REACTION_DONE(),
    REACTION_ERROR(),
    REACTION_CANCELLED(),
  ];
  const reactionValue = typeof reaction === "function" ? reaction() : reaction;

  try {
    // Remove any existing state reactions from us
    for (const emoji of stateReactions) {
      try {
        const existingReaction = message.reactions.cache.get(emoji);
        if (existingReaction?.users.cache.has(botId)) {
          await existingReaction.users.remove(botId);
        }
      } catch (_e) {
        // Ignore - reaction might not exist
      }
    }

    // Add the new reaction
    await message.react(reactionValue);
  } catch (e) {
    logger.debug({ msg: "Failed to set reaction", reaction: reactionValue, error: String(e) });
  }
}

/**
 * Clear all state reactions from a message
 */
export async function clearMessageReactions(message: Message): Promise<void> {
  if (!discordClient?.user) return;

  const botId = discordClient.user.id;
  const stateReactions = [
    REACTION_QUEUED(),
    REACTION_ACTIVE(),
    REACTION_DONE(),
    REACTION_ERROR(),
    REACTION_CANCELLED(),
  ];

  for (const emoji of stateReactions) {
    try {
      const existingReaction = message.reactions.cache.get(emoji);
      if (existingReaction?.users.cache.has(botId)) {
        await existingReaction.users.remove(botId);
      }
    } catch (_e) {
      // Ignore
    }
  }
}
