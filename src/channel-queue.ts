/**
 * Channel Queue Manager
 *
 * Manages per-channel message queuing with promise chains for sequential
 * processing, bot cooldowns, human typing detection, and buffer context.
 */

import type { Message } from "discord.js";
import { REACTION_CANCELLED, REACTION_QUEUED } from "./identity-manager.js";
import { logger } from "./logger.js";
import { clearMessageReactions, setMessageReaction } from "./reaction-manager.js";

export interface BufferedMessage {
  from: string;
  content: string;
  timestamp: number;
  isBot: boolean;
  isMention: boolean;
  originalMessage: Message;
}

export interface QueuedInject {
  sessionKey: string;
  messageContent: string;
  authorDisplayName: string;
  replyToMessage: Message;
  isBot: boolean;
  queuedAt: number;
  cooldownUntil?: number;
}

export interface SessionState {
  thinkingLevel: string;
  verbose: boolean;
  usageMode: string;
  messageCount: number;
  model: string;
  lastBotInteraction?: Record<string, number>;
}

interface ChannelQueue {
  buffer: BufferedMessage[];
  processingChain: Promise<void>;
  pendingItems: QueuedInject[];
  humanTypingUntil: number;
  currentInject: { cancelled: boolean } | null;
}

const HUMAN_TYPING_WINDOW_MS = 15000;
const BOT_COOLDOWN_MS = 5000;

export class ChannelQueueManager {
  private channelQueues = new Map<string, ChannelQueue>();
  private sessionStates = new Map<string, SessionState>();
  private queueProcessorInterval: NodeJS.Timeout | null = null;
  private cleanupInterval: NodeJS.Timeout | null = null;

  constructor(private executeInject: (item: QueuedInject, cancelToken: { cancelled: boolean }) => Promise<void>) {}

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
    // biome-ignore lint/style/noNonNullAssertion: guaranteed by the set() above
    return this.channelQueues.get(channelId)!;
  }

  // === Session State ===

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
    // biome-ignore lint/style/noNonNullAssertion: guaranteed by the set() above
    return this.sessionStates.get(sessionKey)!;
  }

  deleteSessionState(sessionKey: string): void {
    this.sessionStates.delete(sessionKey);
  }

  // === Buffer ===

  addToBuffer(channelId: string, msg: BufferedMessage): void {
    const queue = this.getChannelQueue(channelId);
    queue.buffer.push(msg);
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

    const contextLines = queue.buffer.slice(0, -1).map((m) => `${m.from}: ${m.content}`);
    if (contextLines.length === 0) return "";

    return `[Recent conversation context]\n${contextLines.join("\n")}\n[End context]\n\n`;
  }

  clearBuffer(channelId: string): void {
    const queue = this.getChannelQueue(channelId);
    queue.buffer = [];
  }

  // === Human Typing ===

  setHumanTyping(channelId: string): void {
    const queue = this.getChannelQueue(channelId);
    queue.humanTypingUntil = Date.now() + HUMAN_TYPING_WINDOW_MS;
    logger.info({
      msg: "Human typing detected",
      channelId,
      pauseUntil: new Date(queue.humanTypingUntil).toISOString(),
    });
  }

  // === Queue ===

  queueInject(channelId: string, item: QueuedInject): void {
    const queue = this.getChannelQueue(channelId);

    if (item.isBot) {
      item.cooldownUntil = Date.now() + BOT_COOLDOWN_MS;
      queue.pendingItems.push(item);
      setMessageReaction(item.replyToMessage, REACTION_QUEUED).catch(() => {});
      logger.info({
        msg: "Bot inject queued (pending cooldown)",
        channelId,
        from: item.authorDisplayName,
        queueSize: queue.pendingItems.length,
      });
    } else {
      if (queue.pendingItems.length > 0) {
        logger.info({
          msg: "Clearing pending bot messages - human priority",
          channelId,
          cleared: queue.pendingItems.length,
        });
        for (const pending of queue.pendingItems) {
          clearMessageReactions(pending.replyToMessage).catch(() => {});
        }
        queue.pendingItems = [];
      }

      if (queue.currentInject) {
        setMessageReaction(item.replyToMessage, REACTION_QUEUED).catch(() => {});
      }

      this.addToChain(channelId, item);
      logger.info({ msg: "Human inject queued (direct to chain)", channelId, from: item.authorDisplayName });
    }
  }

  private addToChain(channelId: string, item: QueuedInject): void {
    const queue = this.getChannelQueue(channelId);

    queue.processingChain = queue.processingChain
      .catch((err) => {
        logger.error({ msg: "Queue chain error", channelId, error: String(err) });
      })
      .then(async () => {
        if (queue.currentInject?.cancelled) {
          logger.info({ msg: "Inject skipped - queue was cancelled", channelId, from: item.authorDisplayName });
          return;
        }

        const cancelToken = { cancelled: false };
        queue.currentInject = cancelToken;

        try {
          await this.executeInject(item, cancelToken);
        } catch (error) {
          logger.error({ msg: "Chain inject failed", channelId, error: String(error) });
        } finally {
          if (queue.currentInject === cancelToken) {
            queue.currentInject = null;
          }
        }
      });
  }

  cancelChannelQueue(channelId: string): boolean {
    const queue = this.getChannelQueue(channelId);
    let hadSomething = false;

    if (queue.currentInject) {
      queue.currentInject.cancelled = true;
      hadSomething = true;
      logger.info({ msg: "Current inject cancelled", channelId });
    }

    if (queue.pendingItems.length > 0) {
      hadSomething = true;
      logger.info({ msg: "Pending items cleared", channelId, count: queue.pendingItems.length });
      for (const item of queue.pendingItems) {
        setMessageReaction(item.replyToMessage, REACTION_CANCELLED).catch(() => {});
      }
      queue.pendingItems = [];
    }

    queue.processingChain = Promise.resolve();
    return hadSomething;
  }

  getQueuedCount(channelId: string): number {
    const queue = this.getChannelQueue(channelId);
    return queue.pendingItems.length + (queue.currentInject ? 1 : 0);
  }

  // === Processing Lifecycle ===

  private async processPendingBotResponses(): Promise<void> {
    const now = Date.now();

    for (const [channelId, queue] of this.channelQueues.entries()) {
      if (queue.pendingItems.length === 0) continue;
      if (now < queue.humanTypingUntil) continue;

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

      for (const item of readyItems) {
        logger.info({ msg: "Moving pending item to chain", channelId, from: item.authorDisplayName });
        this.addToChain(channelId, item);
      }
    }
  }

  startProcessing(cleanupFn: () => void): void {
    if (this.queueProcessorInterval) return;
    this.queueProcessorInterval = setInterval(() => {
      this.processPendingBotResponses().catch((err) =>
        logger.error({ msg: "Queue processor error", error: String(err) }),
      );
    }, 1000);
    logger.info({ msg: "Queue processor started" });

    if (!this.cleanupInterval) {
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
