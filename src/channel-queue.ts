import type { Message } from "discord.js";
import { logger } from "./logger.js";
import type { ReactionManager } from "./reaction-manager.js";

export interface BufferedMessage {
  from: string;
  content: string;
  timestamp: number;
  isBot: boolean;
  isMention: boolean; // was this bot directly @mentioned?
  originalMessage: Message;
}

export interface QueuedInject {
  sessionKey: string;
  messageContent: string;
  authorDisplayName: string;
  replyToMessage: Message;
  isBot: boolean;
  queuedAt: number;
  cooldownUntil?: number; // for bot messages only
}

export interface SessionState {
  thinkingLevel: string;
  verbose: boolean;
  usageMode: string;
  messageCount: number;
  model: string;
  lastBotInteraction?: Record<string, number>; // botId -> timestamp for cooldown
}

interface ChannelQueue {
  buffer: BufferedMessage[];
  // Promise chain - each inject waits for the previous to complete
  processingChain: Promise<void>;
  // Pending items waiting to be added to chain (for bot cooldown/human typing)
  pendingItems: QueuedInject[];
  humanTypingUntil: number;
  // Track if we're currently processing (for /cancel)
  currentInject: { cancelled: boolean } | null;
}

const HUMAN_TYPING_WINDOW_MS = 15000; // 15s after human stops typing
const BOT_COOLDOWN_MS = 5000; // 5s between bot responses

export class ChannelQueueManager {
  private channelQueues = new Map<string, ChannelQueue>();
  private sessionStates = new Map<string, SessionState>();
  private queueProcessorInterval: NodeJS.Timeout | null = null;
  private cleanupInterval: NodeJS.Timeout | null = null;

  constructor(
    private reactionManager: ReactionManager,
    private executeInject: (item: QueuedInject, cancelToken: { cancelled: boolean }) => Promise<void>,
  ) {}

  private getChannelQueue(channelId: string): ChannelQueue {
    if (!this.channelQueues.has(channelId)) {
      this.channelQueues.set(channelId, {
        buffer: [],
        processingChain: Promise.resolve(),
        pendingItems: [],
        humanTypingUntil: 0,
        currentInject: null,
      });
    }
    return this.channelQueues.get(channelId)!;
  }

  // Buffer

  addToBuffer(channelId: string, msg: BufferedMessage): void {
    const queue = this.getChannelQueue(channelId);
    queue.buffer.push(msg);
    // Keep buffer reasonable size (last 20 messages)
    if (queue.buffer.length > 20) {
      queue.buffer.shift();
    }
    logger.info({
      msg: "Buffer add",
      channelId,
      from: msg.from,
      isBot: msg.isBot,
      isMention: msg.isMention,
      bufferSize: queue.buffer.length,
    });
  }

  getBufferContext(channelId: string): string {
    const queue = this.getChannelQueue(channelId);
    if (queue.buffer.length === 0) return "";

    // Build context from buffer (exclude the triggering message itself)
    const contextLines = queue.buffer.slice(0, -1).map((m) => `${m.from}: ${m.content}`);
    if (contextLines.length === 0) return "";

    return `[Recent conversation context]\n${contextLines.join("\n")}\n[End context]\n\n`;
  }

  clearBuffer(channelId: string): void {
    const queue = this.getChannelQueue(channelId);
    queue.buffer = [];
  }

  // Session state

  getSessionState(sessionKey: string): SessionState {
    if (!this.sessionStates.has(sessionKey)) {
      this.sessionStates.set(sessionKey, {
        thinkingLevel: "medium",
        verbose: false,
        usageMode: "tokens",
        messageCount: 0,
        model: "claude-sonnet-4-20250514",
      });
    }
    return this.sessionStates.get(sessionKey)!;
  }

  deleteSessionState(sessionKey: string): void {
    this.sessionStates.delete(sessionKey);
  }

  // Queue

  /**
   * Queue an inject to the promise chain.
   * Human messages go directly to chain. Bot messages wait for cooldown.
   */
  queueInject(channelId: string, item: QueuedInject): void {
    const queue = this.getChannelQueue(channelId);

    if (item.isBot) {
      // Bot messages: add to pending with cooldown, processor will add to chain
      item.cooldownUntil = Date.now() + BOT_COOLDOWN_MS;
      queue.pendingItems.push(item);
      // Show queued reaction
      this.reactionManager.setReaction(item.replyToMessage, "queued").catch(() => {});
      logger.info({
        msg: "Bot inject queued (pending cooldown)",
        channelId,
        from: item.authorDisplayName,
        queueSize: queue.pendingItems.length,
      });
    } else {
      // Human messages: add directly to promise chain (immediate priority)
      // Also clear any pending bot messages - human takes priority
      if (queue.pendingItems.length > 0) {
        logger.info({
          msg: "Clearing pending bot messages - human priority",
          channelId,
          cleared: queue.pendingItems.length,
        });
        // Clear queued reactions from cancelled bot messages
        for (const pending of queue.pendingItems) {
          this.reactionManager.clearReactions(pending.replyToMessage).catch(() => {});
        }
        queue.pendingItems = [];
      }

      // Check if there's already something processing - if so, show queued first
      if (queue.currentInject) {
        this.reactionManager.setReaction(item.replyToMessage, "queued").catch(() => {});
      }

      this.addToChain(channelId, item);
      logger.info({ msg: "Human inject queued (direct to chain)", channelId, from: item.authorDisplayName });
    }
  }

  /**
   * Cancel current and pending injects for a channel.
   * Returns true if there was something to cancel.
   */
  cancelChannelQueue(channelId: string): boolean {
    const queue = this.getChannelQueue(channelId);
    let hadSomething = false;

    // Cancel current inject (reaction will be set by executeInjectInternal when it detects cancellation)
    if (queue.currentInject) {
      queue.currentInject.cancelled = true;
      hadSomething = true;
      logger.info({ msg: "Current inject cancelled", channelId });
    }

    // Clear pending items and set cancelled reaction on each
    if (queue.pendingItems.length > 0) {
      hadSomething = true;
      logger.info({ msg: "Pending items cleared", channelId, count: queue.pendingItems.length });
      for (const item of queue.pendingItems) {
        this.reactionManager.setReaction(item.replyToMessage, "cancelled").catch(() => {});
      }
      queue.pendingItems = [];
    }

    // Reset the chain to resolved (don't wait for cancelled items)
    queue.processingChain = Promise.resolve();

    return hadSomething;
  }

  /**
   * Get count of pending items in queue (for status display)
   */
  getQueuedCount(channelId: string): number {
    const queue = this.getChannelQueue(channelId);
    return queue.pendingItems.length + (queue.currentInject ? 1 : 0);
  }

  setHumanTyping(channelId: string): void {
    const queue = this.getChannelQueue(channelId);
    queue.humanTypingUntil = Date.now() + HUMAN_TYPING_WINDOW_MS;
    logger.info({
      msg: "Human typing detected",
      channelId,
      pauseUntil: new Date(queue.humanTypingUntil).toISOString(),
    });
  }

  // Lifecycle

  /**
   * Add an inject to the promise chain - it will execute after all previous injects complete.
   */
  private addToChain(channelId: string, item: QueuedInject): void {
    const queue = this.getChannelQueue(channelId);

    queue.processingChain = queue.processingChain.then(async () => {
      // Check if cancelled before starting
      if (queue.currentInject?.cancelled) {
        logger.info({ msg: "Inject skipped - queue was cancelled", channelId, from: item.authorDisplayName });
        return;
      }

      // Create cancellation token for this inject
      const cancelToken = { cancelled: false };
      queue.currentInject = cancelToken;

      try {
        await this.executeInject(item, cancelToken);
      } catch (error) {
        logger.error({ msg: "Chain inject failed", channelId, error: String(error) });
      } finally {
        // Clear current inject if it's still ours
        if (queue.currentInject === cancelToken) {
          queue.currentInject = null;
        }
      }
    });
  }

  // Check and fire pending bot responses (called periodically)
  private async processPendingBotResponses(): Promise<void> {
    const now = Date.now();

    for (const [channelId, queue] of this.channelQueues.entries()) {
      // Skip if no pending items
      if (queue.pendingItems.length === 0) continue;

      // Skip if human is typing
      if (now < queue.humanTypingUntil) continue;

      // Find items ready to fire (past cooldown)
      const readyItems: QueuedInject[] = [];
      const stillPending: QueuedInject[] = [];

      for (const item of queue.pendingItems) {
        if (item.cooldownUntil && now < item.cooldownUntil) {
          stillPending.push(item);
        } else {
          readyItems.push(item);
        }
      }

      queue.pendingItems = stillPending;

      // Add ready items to chain
      for (const item of readyItems) {
        logger.info({ msg: "Moving pending item to chain", channelId, from: item.authorDisplayName });
        this.addToChain(channelId, item);
      }
    }
  }

  /**
   * Start periodic processing of pending responses and cleanup intervals.
   */
  startProcessing(cleanupFn: () => void): void {
    if (this.queueProcessorInterval) return;
    this.queueProcessorInterval = setInterval(() => {
      this.processPendingBotResponses().catch((err) =>
        logger.error({ msg: "Queue processor error", error: String(err) }),
      );
    }, 1000); // Check every second
    logger.info({ msg: "Queue processor started" });

    if (!this.cleanupInterval) {
      // Clean up expired pairings and button requests every minute
      this.cleanupInterval = setInterval(cleanupFn, 60000);
      logger.info({ msg: "Cleanup interval started" });
    }
  }

  stopProcessing(): void {
    if (this.queueProcessorInterval) {
      clearInterval(this.queueProcessorInterval);
      this.queueProcessorInterval = null;
      logger.info({ msg: "Queue processor stopped" });
    }
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }
}
