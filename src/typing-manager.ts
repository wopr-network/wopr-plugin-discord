import type { DMChannel, TextChannel, ThreadChannel } from "discord.js";
import { logger } from "./logger.js";

interface TypingState {
  interval: NodeJS.Timeout | null;
  lastActivity: number;
  active: boolean;
}

export class TypingManager {
  private typingStates = new Map<string, TypingState>();
  private readonly TYPING_REFRESH_MS = 8000; // Discord typing indicator lasts ~10s, refresh at 8s
  private readonly TYPING_IDLE_TIMEOUT_MS = 5000; // Stop typing after 5s of no activity

  /**
   * Start showing typing indicator in a channel.
   * Will auto-refresh every 8 seconds until stopped.
   */
  async startTyping(channel: TextChannel | ThreadChannel | DMChannel): Promise<void> {
    const channelId = channel.id;

    // Clean up any existing typing state
    this.stopTyping(channelId);

    const state: TypingState = {
      interval: null,
      lastActivity: Date.now(),
      active: true,
    };

    // Send initial typing indicator
    try {
      await channel.sendTyping();
      logger.debug({ msg: "Typing indicator started", channelId });
    } catch (e) {
      logger.debug({ msg: "Failed to start typing indicator", channelId, error: String(e) });
      return;
    }

    // Set up refresh interval
    state.interval = setInterval(async () => {
      const now = Date.now();
      const idleTime = now - state.lastActivity;

      // Stop if idle for too long
      if (idleTime > this.TYPING_IDLE_TIMEOUT_MS) {
        logger.debug({ msg: "Typing indicator stopped (idle)", channelId, idleTime });
        this.stopTyping(channelId);
        return;
      }

      // Refresh typing indicator
      if (state.active) {
        try {
          await channel.sendTyping();
          logger.debug({ msg: "Typing indicator refreshed", channelId });
        } catch (_e) {
          // Channel might be gone, stop typing
          this.stopTyping(channelId);
        }
      }
    }, this.TYPING_REFRESH_MS);

    this.typingStates.set(channelId, state);
  }

  /**
   * Update activity timestamp to prevent idle timeout.
   * Call this when receiving stream chunks.
   */
  tickTyping(channelId: string): void {
    const state = this.typingStates.get(channelId);
    if (state) {
      state.lastActivity = Date.now();
    }
  }

  /**
   * Stop showing typing indicator in a channel.
   * Optionally pass the channel to force-clear Discord's typing state
   * (Discord has no "stop typing" API -- the only way is to send and delete a message).
   */
  stopTyping(channelId: string, channel?: TextChannel | ThreadChannel | DMChannel): void {
    const state = this.typingStates.get(channelId);
    if (state) {
      state.active = false;
      if (state.interval) {
        clearInterval(state.interval);
        state.interval = null;
      }
      this.typingStates.delete(channelId);
      logger.debug({ msg: "Typing indicator stopped", channelId });
    }

    // Force-clear typing by sending and immediately deleting an invisible message
    if (channel) {
      channel
        .send("\u200b")
        .then((m: any) => m.delete().catch(() => {}))
        .catch(() => {});
    }
  }

  dispose(): void {
    for (const [channelId] of this.typingStates) {
      this.stopTyping(channelId);
    }
  }
}
