import type { Client, Message } from "discord.js";
import type { IdentityManager } from "./identity-manager.js";
import { logger } from "./logger.js";

export class ReactionManager {
  constructor(
    private getClient: () => Client | null,
    private identityManager: IdentityManager,
  ) {}

  /**
   * Set reaction state on a message. Removes old state reactions first.
   */
  async setReaction(message: Message, state: "queued" | "active" | "done" | "error" | "cancelled"): Promise<void> {
    const client = this.getClient();
    if (!client?.user) return;

    const botId = client.user.id;
    const stateReactions = this.identityManager.getAllStateReactions();
    const reactionValue = this.identityManager.getReactionEmoji(state);

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
  async clearReactions(message: Message): Promise<void> {
    const client = this.getClient();
    if (!client?.user) return;

    const botId = client.user.id;
    const stateReactions = this.identityManager.getAllStateReactions();

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
}
