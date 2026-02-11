import { logger } from "./logger.js";
import type { AgentIdentity, WOPRPluginContext } from "./types.js";

export class IdentityManager {
  private agentIdentity: AgentIdentity = { name: "WOPR", emoji: "\u{1F440}" };
  private reactionEmojis = {
    queued: "\u{1F550}",
    active: "\u26A1",
    done: "\u2705",
    error: "\u274C",
    cancelled: "\u23F9\uFE0F",
  };

  constructor(private ctx: WOPRPluginContext) {}

  async refresh(): Promise<void> {
    try {
      const identity = await this.ctx.getAgentIdentity();
      if (identity) {
        this.agentIdentity = { ...this.agentIdentity, ...identity };
        logger.info({ msg: "Identity refreshed", identity: this.agentIdentity });
      }
    } catch (e) {
      logger.warn({ msg: "Failed to refresh identity", error: String(e) });
    }
    // Also refresh reaction emojis from config
    await this.refreshReactionEmojis();
  }

  private async refreshReactionEmojis(): Promise<void> {
    try {
      const config = this.ctx.getConfig<Record<string, any>>();
      if (config) {
        this.reactionEmojis = {
          queued: config.emojiQueued || "\u{1F550}",
          active: config.emojiActive || "\u26A1",
          done: config.emojiDone || "\u2705",
          error: config.emojiError || "\u274C",
          cancelled: config.emojiCancelled || "\u23F9\uFE0F",
        };
        logger.info({ msg: "Reaction emojis refreshed", emojis: this.reactionEmojis });
      }
    } catch (e) {
      logger.warn({ msg: "Failed to refresh reaction emojis", error: String(e) });
    }
  }

  get identity(): AgentIdentity {
    return this.agentIdentity;
  }

  getAckReaction(): string {
    return this.agentIdentity.emoji?.trim() || "\u{1F440}";
  }

  getMessagePrefix(): string {
    const name = this.agentIdentity.name?.trim();
    return name ? `[${name}]` : "[WOPR]";
  }

  getReactionEmoji(state: "queued" | "active" | "done" | "error" | "cancelled"): string {
    return this.reactionEmojis[state] ?? "\u2753";
  }

  getAllStateReactions(): string[] {
    return [
      this.reactionEmojis.queued,
      this.reactionEmojis.active,
      this.reactionEmojis.done,
      this.reactionEmojis.error,
      this.reactionEmojis.cancelled,
    ];
  }
}
