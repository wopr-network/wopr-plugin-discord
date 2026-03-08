/**
 * Discord Message Streaming
 *
 * Manages streaming AI responses into Discord messages with edit-in-place,
 * overflow handling, idle-split, and rate-limit retry. Exports the stream
 * registry (keyed by Discord message ID) and the handleChunk function.
 */

import type {
  DMChannel,
  Message,
  MessageCreateOptions,
  MessageEditOptions,
  TextChannel,
  ThreadChannel,
} from "discord.js";
import { textToComponentsV2, textToComponentsV2Edit } from "./components-v2.js";
import { logger } from "./logger.js";
import type { StreamMessage } from "./types.js";

export interface MessageUnitOptions {
  useComponentsV2?: boolean;
}

export interface StreamOptions {
  useComponentsV2?: boolean;
}

export const DISCORD_LIMIT = 2000;
const EDIT_INTERVAL_MS = 1000; // Max 1 edit per second (Discord rate limit: 5 req/5s per channel)
const IDLE_SPLIT_MS = 3500;
const RATE_LIMIT_MAX_RETRIES = 3;

/**
 * Retry a Discord API call with exponential backoff on 429 rate-limit errors.
 */
async function withRateLimitRetry<T>(fn: () => Promise<T>, label: string): Promise<T> {
  for (let attempt = 0; attempt <= RATE_LIMIT_MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err: unknown) {
      const typedErr = err as { httpStatus?: number; status?: number; retryAfter?: number };
      const isRateLimit = typedErr?.httpStatus === 429 || typedErr?.status === 429;
      if (!isRateLimit || attempt >= RATE_LIMIT_MAX_RETRIES) {
        throw err;
      }
      const retryAfterMs = typedErr.retryAfter ?? (attempt + 1) * 2000;
      logger.warn({
        msg: "Discord rate limit hit, retrying",
        label,
        attempt: attempt + 1,
        retryAfterMs,
      });
      await new Promise((resolve) => setTimeout(resolve, retryAfterMs));
    }
  }
  throw new Error(`Rate limit retry exhausted for ${label}`);
}

// Explicit state machine - each state is mutually exclusive
type MessageState =
  | { status: "buffering"; content: string }
  | { status: "sending"; content: string; promise: Promise<Message>; pendingWhileSending: string }
  | { status: "sent"; content: string; discordMsg: Message; lastEditLength: number }
  | { status: "finalized" };

type SendPayload = string | MessageCreateOptions;
type EditPayload = string | MessageEditOptions;

/**
 * Manages a single Discord message's lifecycle with edit-in-place support.
 * Uses explicit state machine to prevent race conditions.
 */
export class DiscordMessageUnit {
  private state: MessageState = { status: "buffering", content: "" };
  private readonly channel: TextChannel | ThreadChannel | DMChannel;
  private readonly replyTo: Message;
  private readonly isReply: boolean;
  private readonly unitId: string;
  private readonly useComponentsV2: boolean;
  private _overflow: string = ""; // Content that didn't fit after a split

  constructor(
    channel: TextChannel | ThreadChannel | DMChannel,
    replyTo: Message,
    isReply: boolean,
    options?: MessageUnitOptions,
  ) {
    this.channel = channel;
    this.replyTo = replyTo;
    this.isReply = isReply;
    this.useComponentsV2 = options?.useComponentsV2 ?? false;
    this.unitId = Math.random().toString(36).slice(2, 8);
    logger.debug({ msg: "DiscordMessageUnit created", unitId: this.unitId, isReply });
  }

  get content(): string {
    if (this.state.status === "finalized") return "";
    return this.state.content;
  }

  get isFinalized(): boolean {
    return this.state.status === "finalized";
  }

  get discordMsg(): Message | null {
    if (this.state.status === "sent") return this.state.discordMsg;
    return null;
  }

  append(text: string): void {
    if (this.state.status === "finalized") {
      logger.debug({ msg: "Unit.append ignored - finalized", unitId: this.unitId, textLen: text.length });
      return;
    }
    if (this.state.status === "sending") {
      this.state = { ...this.state, pendingWhileSending: this.state.pendingWhileSending + text };
      logger.debug({
        msg: "Unit.append buffered - sending",
        unitId: this.unitId,
        textLen: text.length,
        bufferedLen: this.state.pendingWhileSending.length,
      });
      return;
    }
    const prevLen = this.state.content.length;
    this.state = { ...this.state, content: this.state.content + text };
    logger.debug({
      msg: "Unit.append",
      unitId: this.unitId,
      added: text.length,
      totalLen: this.state.content.length,
      prevLen,
    });
  }

  /**
   * Attempt to flush content to Discord.
   * Returns 'split' if content exceeded limit and needs continuation.
   */
  async flush(): Promise<"ok" | "split" | "skip"> {
    if (this.state.status === "finalized") {
      logger.debug({ msg: "Unit.flush skip - finalized", unitId: this.unitId });
      return "skip";
    }
    if (this.state.status === "sending") {
      logger.debug({ msg: "Unit.flush skip - sending", unitId: this.unitId });
      return "skip";
    }

    if (!this.state.content.trim()) {
      logger.debug({ msg: "Unit.flush skip - empty", unitId: this.unitId });
      return "skip";
    }

    const content = this.state.content;

    logger.debug({ msg: "Unit.flush", unitId: this.unitId, status: this.state.status, contentLen: content.length });

    // Handle overflow - need to split
    if (content.length > DISCORD_LIMIT) {
      logger.debug({ msg: "Unit.flush overflow", unitId: this.unitId, contentLen: content.length });
      return this.handleOverflow(content);
    }

    // In buffering state - send initial message (any content is enough)
    if (this.state.status === "buffering") {
      return this.sendInitial(content);
    }

    // In sent state - edit with new content
    if (this.state.status === "sent") {
      if (content.length === this.state.lastEditLength) {
        logger.debug({ msg: "Unit.flush skip - no new content", unitId: this.unitId });
        return "skip";
      }
      return this.editExisting(content);
    }

    return "skip";
  }

  private async sendInitial(content: string): Promise<"ok" | "split" | "skip"> {
    if (this.state.status !== "buffering") return "skip";

    logger.debug({ msg: "Unit.sendInitial", unitId: this.unitId, contentLen: content.length, isReply: this.isReply });

    const payload: SendPayload = this.useComponentsV2 ? textToComponentsV2(content) : content;
    const promise = withRateLimitRetry(
      () => (this.isReply ? this.replyTo.reply(payload) : this.channel.send(payload)) as Promise<Message>,
      `sendInitial:${this.unitId}`,
    );
    this.state = { status: "sending", content, promise, pendingWhileSending: "" };

    try {
      const discordMsg = await promise;
      const buffered = this.state.status === "sending" ? this.state.pendingWhileSending : "";
      const mergedContent = content + buffered;
      this.state = { status: "sent", content: mergedContent, discordMsg, lastEditLength: content.length };
      if (buffered) {
        logger.debug({
          msg: "Unit.sendInitial flushed buffered content",
          unitId: this.unitId,
          bufferedLen: buffered.length,
        });
      }
      logger.debug({ msg: "Unit.sendInitial success", unitId: this.unitId, msgId: discordMsg.id });
      return "ok";
    } catch (error) {
      const buffered = this.state.status === "sending" ? this.state.pendingWhileSending : "";
      this.state = { status: "buffering", content: content + buffered };
      logger.error({ msg: "Unit.sendInitial failed", unitId: this.unitId, error: String(error) });
      throw error;
    }
  }

  private async editExisting(content: string): Promise<"ok" | "split" | "skip"> {
    if (this.state.status !== "sent") return "skip";

    logger.debug({ msg: "Unit.editExisting", unitId: this.unitId, contentLen: content.length });
    const discordMsg = this.state.discordMsg;
    const payload: EditPayload = this.useComponentsV2 ? textToComponentsV2Edit(content) : content;
    await withRateLimitRetry(() => discordMsg.edit(payload), `editExisting:${this.unitId}`);
    this.state = { ...this.state, content, lastEditLength: content.length };
    logger.debug({ msg: "Unit.editExisting success", unitId: this.unitId });
    return "ok";
  }

  private async handleOverflow(content: string): Promise<"ok" | "split" | "skip"> {
    let splitAt = DISCORD_LIMIT;
    const lastSpace = content.lastIndexOf(" ", DISCORD_LIMIT);
    const lastNewline = content.lastIndexOf("\n", DISCORD_LIMIT);
    const bestBreak = Math.max(lastSpace, lastNewline);
    if (bestBreak > DISCORD_LIMIT * 0.75) {
      splitAt = bestBreak;
    }
    const toSend = content.slice(0, splitAt);
    let overflow = content.slice(splitAt).trimStart();
    logger.debug({
      msg: "Unit.handleOverflow",
      unitId: this.unitId,
      toSendLen: toSend.length,
      overflowLen: overflow.length,
      splitAt,
    });

    if (this.state.status === "buffering") {
      const sendPayload: SendPayload = this.useComponentsV2 ? textToComponentsV2(toSend) : toSend;
      const promise = withRateLimitRetry(
        () => (this.isReply ? this.replyTo.reply(sendPayload) : this.channel.send(sendPayload)) as Promise<Message>,
        `handleOverflow:send:${this.unitId}`,
      );
      this.state = { status: "sending", content: toSend, promise, pendingWhileSending: "" };

      try {
        await promise;
        const buffered = this.state.status === "sending" ? this.state.pendingWhileSending : "";
        this.state = { status: "finalized" };
        if (buffered) {
          overflow = overflow + buffered;
        }
        logger.debug({ msg: "Unit.handleOverflow sent and finalized", unitId: this.unitId });
      } catch (error) {
        const buffered = this.state.status === "sending" ? this.state.pendingWhileSending : "";
        this.state = { status: "buffering", content: content + buffered };
        logger.error({ msg: "Unit.handleOverflow failed", unitId: this.unitId, error: String(error) });
        throw error;
      }
    } else if (this.state.status === "sent") {
      const sentMsg = this.state.discordMsg;
      const editPayload: EditPayload = this.useComponentsV2 ? textToComponentsV2Edit(toSend) : toSend;
      await withRateLimitRetry(() => sentMsg.edit(editPayload), `handleOverflow:edit:${this.unitId}`);
      this.state = { status: "finalized" };
      logger.debug({ msg: "Unit.handleOverflow edited and finalized", unitId: this.unitId });
    }

    this._overflow = overflow;
    return "split";
  }

  /** Get the overflow content from the last split. */
  get overflow(): string {
    return this._overflow;
  }

  /**
   * Finalize this message - send/edit with final content.
   * Safe to call multiple times.
   */
  async finalize(): Promise<void> {
    logger.debug({
      msg: "Unit.finalize called",
      unitId: this.unitId,
      status: this.state.status,
      contentLen: this.state.status !== "finalized" ? this.state.content.length : 0,
    });

    if (this.state.status === "finalized") {
      logger.debug({ msg: "Unit.finalize skip - already finalized", unitId: this.unitId });
      return;
    }

    if (this.state.status === "sending") {
      logger.debug({ msg: "Unit.finalize waiting for send", unitId: this.unitId });
      try {
        const sendContent = this.state.content;
        const discordMsg = await this.state.promise;
        // Re-read state after the await — concurrent sendInitial or handleOverflow
        // may have updated this.state while the send was in-flight.
        // Cast through unknown to reset TypeScript's narrowing from the outer if.
        const stateAfterSend = this.state as unknown as MessageState;
        if (stateAfterSend.status === "sending") {
          // finalize won the race — read pendingWhileSending now, after the await
          const pendingText = stateAfterSend.pendingWhileSending;
          this.state = {
            status: "sent",
            content: sendContent + pendingText,
            discordMsg,
            lastEditLength: sendContent.length,
          };
          if (pendingText) {
            logger.debug({
              msg: "Unit.finalize flushed buffered content",
              unitId: this.unitId,
              bufferedLen: pendingText.length,
            });
          }
        } else if (stateAfterSend.status === "finalized") {
          // handleOverflow ran concurrently and already finalized this unit
          logger.debug({ msg: "Unit.finalize already finalized during send", unitId: this.unitId });
          return;
        }
        // else: sendInitial ran first and set state to "sent" — use that state below
        logger.debug({ msg: "Unit.finalize send completed", unitId: this.unitId, msgId: discordMsg.id });
      } catch (error) {
        logger.error({ msg: "Unit.finalize send failed", unitId: this.unitId, error: String(error) });
        this.state = { status: "finalized" };
        return;
      }
    }

    const content = this.state.content.trim();
    if (!content) {
      logger.debug({ msg: "Unit.finalize skip - empty content", unitId: this.unitId });
      this.state = { status: "finalized" };
      return;
    }

    const prevState = this.state;
    this.state = { status: "finalized" };

    try {
      if (prevState.status === "sent") {
        logger.debug({ msg: "Unit.finalize editing sent message", unitId: this.unitId, contentLen: content.length });
        const sentMsg = prevState.discordMsg;
        const finalContent = content.slice(0, DISCORD_LIMIT);
        const editPayload: EditPayload = this.useComponentsV2 ? textToComponentsV2Edit(finalContent) : finalContent;
        await withRateLimitRetry(() => sentMsg.edit(editPayload), `finalize:edit:${this.unitId}`);
        logger.debug({ msg: "Unit.finalize edit success", unitId: this.unitId });
      } else if (prevState.status === "buffering") {
        logger.debug({
          msg: "Unit.finalize sending buffered content",
          unitId: this.unitId,
          contentLen: content.length,
          isReply: this.isReply,
        });
        const finalContent = content.slice(0, DISCORD_LIMIT);
        const sendPayload: SendPayload = this.useComponentsV2 ? textToComponentsV2(finalContent) : finalContent;
        const msg = await withRateLimitRetry(
          () => (this.isReply ? this.replyTo.reply(sendPayload) : this.channel.send(sendPayload)) as Promise<Message>,
          `finalize:send:${this.unitId}`,
        );
        logger.debug({ msg: "Unit.finalize send success", unitId: this.unitId, msgId: msg.id });
      }
    } catch (error) {
      logger.error({ msg: "Unit.finalize failed", unitId: this.unitId, error: String(error) });
    }
  }
}

/**
 * Coordinates streaming of potentially multiple Discord messages.
 * Handles idle-split, overflow, and debounced flushing.
 */
export class DiscordMessageStream {
  private currentUnit: DiscordMessageUnit;
  private completedUnits: DiscordMessageUnit[] = [];
  private readonly channel: TextChannel | ThreadChannel | DMChannel;
  private readonly replyTo: Message;
  private readonly streamId: string;
  private readonly options: StreamOptions;

  private lastAppendTime = Date.now();
  private flushTimer: NodeJS.Timeout | null = null;
  private pendingContent: string[] = [];
  private processing = false;
  private finalized = false;

  constructor(channel: TextChannel | ThreadChannel | DMChannel, replyTo: Message, options?: StreamOptions) {
    this.channel = channel;
    this.replyTo = replyTo;
    this.options = options ?? {};
    this.streamId = Math.random().toString(36).slice(2, 8);
    this.currentUnit = new DiscordMessageUnit(channel, replyTo, true, {
      useComponentsV2: this.options.useComponentsV2,
    });
    logger.info({ msg: "Stream created", streamId: this.streamId, channelId: channel.id });

    this.flushTimer = setInterval(() => this.processPending(), EDIT_INTERVAL_MS);
  }

  private async refreshTyping(): Promise<void> {
    try {
      await this.channel.sendTyping();
    } catch (_) {
      /* channel gone, ignore */
    }
  }

  append(text: string): void {
    if (this.finalized) {
      logger.debug({ msg: "Stream.append ignored - finalized", streamId: this.streamId, textLen: text.length });
      return;
    }
    this.pendingContent.push(text);
    logger.debug({
      msg: "Stream.append",
      streamId: this.streamId,
      textLen: text.length,
      pendingCount: this.pendingContent.length,
    });
  }

  private async processPending(): Promise<void> {
    if (this.processing || this.finalized || this.pendingContent.length === 0) {
      return;
    }
    this.processing = true;

    try {
      const batch = this.pendingContent.splice(0, this.pendingContent.length).join("");
      if (!batch) return;

      const now = Date.now();
      const timeSinceLast = now - this.lastAppendTime;
      this.lastAppendTime = now;

      if (timeSinceLast > IDLE_SPLIT_MS && this.currentUnit.content.length > 0) {
        logger.info({
          msg: "Stream idle split",
          streamId: this.streamId,
          timeSinceLast,
          unitContent: this.currentUnit.content.length,
        });
        await this.currentUnit.finalize();
        this.completedUnits.push(this.currentUnit);
        this.currentUnit = new DiscordMessageUnit(this.channel, this.replyTo, false, {
          useComponentsV2: this.options.useComponentsV2,
        });
      }

      this.currentUnit.append(batch);
      await this.flushWithOverflowHandling();

      if (!this.finalized) {
        await this.refreshTyping();
      }

      logger.debug({ msg: "Stream.processPending complete", streamId: this.streamId, batchLen: batch.length });
    } catch (error) {
      logger.error({ msg: "Stream processing error", streamId: this.streamId, error: String(error) });
    } finally {
      this.processing = false;
    }
  }

  private async flushWithOverflowHandling(): Promise<void> {
    while (true) {
      const currentContent = this.currentUnit.content;
      const result = await this.currentUnit.flush();
      logger.debug({
        msg: "Stream.flushWithOverflowHandling result",
        streamId: this.streamId,
        result,
        contentLen: currentContent.length,
      });

      if (result === "split") {
        const overflow = this.currentUnit.overflow;
        logger.info({ msg: "Stream overflow split", streamId: this.streamId, overflowLen: overflow.length });
        this.completedUnits.push(this.currentUnit);
        this.currentUnit = new DiscordMessageUnit(this.channel, this.replyTo, false, {
          useComponentsV2: this.options.useComponentsV2,
        });

        if (overflow.length > 0) {
          this.currentUnit.append(overflow);
        } else {
          break;
        }
      } else {
        break;
      }
    }
  }

  async finalize(): Promise<void> {
    logger.info({
      msg: "Stream.finalize called",
      streamId: this.streamId,
      finalized: this.finalized,
      processing: this.processing,
      pendingCount: this.pendingContent.length,
    });

    if (this.finalized) {
      logger.debug({ msg: "Stream.finalize skip - already finalized", streamId: this.streamId });
      return;
    }

    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
      logger.debug({ msg: "Stream.finalize stopped flush interval", streamId: this.streamId });
    }

    if (this.processing) {
      logger.info({ msg: "Stream.finalize waiting for processing to complete", streamId: this.streamId });
      let waitCount = 0;
      while (this.processing && waitCount < 100) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        waitCount++;
      }
      if (this.processing) {
        logger.warn({ msg: "Stream.finalize timed out waiting for processing", streamId: this.streamId });
      } else {
        logger.debug({ msg: "Stream.finalize processing completed", streamId: this.streamId, waitCount });
      }
    }

    this.finalized = true;

    const remainingCount = this.pendingContent.length;
    if (remainingCount > 0) {
      const remaining = this.pendingContent.splice(0, this.pendingContent.length).join("");
      logger.debug({
        msg: "Stream.finalize processing remaining content",
        streamId: this.streamId,
        remainingCount,
        remainingLen: remaining.length,
      });
      if (remaining) {
        this.currentUnit.append(remaining);
        await this.flushWithOverflowHandling();
      }
    }

    logger.debug({
      msg: "Stream.finalize finalizing current unit",
      streamId: this.streamId,
      unitContent: this.currentUnit.content.length,
    });
    await this.currentUnit.finalize();
    logger.info({
      msg: "Stream.finalize complete",
      streamId: this.streamId,
      completedUnits: this.completedUnits.length + 1,
    });
  }

  getLastMessage(): Message | null {
    const msg = this.currentUnit.discordMsg;
    logger.debug({ msg: "Stream.getLastMessage", streamId: this.streamId, hasMsg: !!msg });
    return msg;
  }
}

// Stream registry - one stream per MESSAGE (not session) to prevent race conditions
// Key: Discord message ID that triggered the inject
export const streams = new Map<string, DiscordMessageStream>();

// Event bus streams - for non-Discord-originated injects (cron, sessions_send, CLI)
// Key: session name (e.g., "discord:misfits:#wopr-devops")
export const eventBusStreams = new Map<string, DiscordMessageStream>();

/**
 * Handle an incoming stream chunk.
 * @param msg - The stream message chunk
 * @param streamKey - The Discord message ID (NOT session key) to prevent cross-message races
 */
export async function handleChunk(msg: StreamMessage, streamKey: string): Promise<void> {
  const stream = streams.get(streamKey);
  if (!stream) {
    logger.warn({ msg: "handleChunk - no stream found", streamKey, msgType: msg.type });
    return;
  }

  // Handle system messages (including auto-compaction notifications)
  if (msg.type === "system" && msg.subtype === "compact_boundary") {
    const metadata = msg.metadata as { pre_tokens?: number; trigger?: string } | undefined;
    logger.info({ msg: "handleChunk - auto-compaction detected", streamKey, metadata });

    if (metadata?.trigger === "auto") {
      let notification = "\u{1f4e6} **Auto-Compaction**\n";
      if (metadata.pre_tokens) {
        notification += `Context compressed from ~${Math.round(metadata.pre_tokens / 1000)}k tokens`;
      } else {
        notification += "Context has been automatically compressed";
      }
      stream.append(`\n\n${notification}\n\n`);
    }
    return;
  }

  // Extract text content from various message formats
  let textContent = "";
  if (msg.type === "text" && msg.content) {
    textContent = msg.content;
    logger.debug({ msg: "handleChunk - text content", streamKey, contentLen: textContent.length });
  } else if ((msg.type as string) === "assistant" && (msg as { message?: { content?: unknown } }).message?.content) {
    const content = (msg as { message?: { content?: unknown } }).message?.content;
    if (Array.isArray(content)) {
      textContent = content.map((c: { text?: string }) => c.text || "").join("");
    } else if (typeof content === "string") {
      textContent = content;
    }
    logger.debug({ msg: "handleChunk - assistant content", streamKey, contentLen: textContent.length });
  } else {
    logger.debug({ msg: "handleChunk - skipping non-text", streamKey, msgType: msg.type });
  }

  if (textContent) {
    stream.append(textContent);
  }
}
