import type { DMChannel, Message, TextChannel, ThreadChannel } from "discord.js";
import { logger } from "./logger.js";
import type { StreamMessage } from "./types.js";

// Discord streaming message handler with explicit state machine
export const DISCORD_LIMIT = 2000;
export const EDIT_INTERVAL_MS = 1000; // Max 1 edit per second (Discord rate limit: 5 req/5s per channel)
export const IDLE_SPLIT_MS = 3500;

// Explicit state machine - each state is mutually exclusive
type MessageState =
  | { status: "buffering"; content: string }
  | { status: "sending"; content: string; promise: Promise<Message> }
  | { status: "sent"; content: string; discordMsg: Message; lastEditLength: number }
  | { status: "finalized" };

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
  private _overflow: string = ""; // Content that didn't fit after a split

  constructor(channel: TextChannel | ThreadChannel | DMChannel, replyTo: Message, isReply: boolean) {
    this.channel = channel;
    this.replyTo = replyTo;
    this.isReply = isReply;
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
      logger.debug({ msg: "Unit.append ignored - sending", unitId: this.unitId, textLen: text.length });
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

    const content = this.state.content.trim();
    if (!content) {
      logger.debug({ msg: "Unit.flush skip - empty", unitId: this.unitId });
      return "skip";
    }

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

    // Transition: buffering -> sending
    const promise = this.isReply ? this.replyTo.reply(content) : this.channel.send(content);
    this.state = { status: "sending", content, promise };

    try {
      const discordMsg = await promise;
      // Transition: sending -> sent
      this.state = { status: "sent", content, discordMsg, lastEditLength: content.length };
      logger.debug({ msg: "Unit.sendInitial success", unitId: this.unitId, msgId: discordMsg.id });
      return "ok";
    } catch (error) {
      // Rollback to buffering on failure
      this.state = { status: "buffering", content };
      logger.error({ msg: "Unit.sendInitial failed", unitId: this.unitId, error: String(error) });
      throw error;
    }
  }

  private async editExisting(content: string): Promise<"ok" | "split" | "skip"> {
    if (this.state.status !== "sent") return "skip";

    logger.debug({ msg: "Unit.editExisting", unitId: this.unitId, contentLen: content.length });
    await this.state.discordMsg.edit(content);
    this.state = { ...this.state, content, lastEditLength: content.length };
    logger.debug({ msg: "Unit.editExisting success", unitId: this.unitId });
    return "ok";
  }

  private async handleOverflow(content: string): Promise<"ok" | "split" | "skip"> {
    // Find a word boundary to split at (don't cut mid-word)
    let splitAt = DISCORD_LIMIT;
    const lastSpace = content.lastIndexOf(" ", DISCORD_LIMIT);
    const lastNewline = content.lastIndexOf("\n", DISCORD_LIMIT);
    const bestBreak = Math.max(lastSpace, lastNewline);
    if (bestBreak > DISCORD_LIMIT * 0.75) {
      splitAt = bestBreak;
    }
    const toSend = content.slice(0, splitAt);
    const overflow = content.slice(splitAt).trimStart();
    logger.debug({
      msg: "Unit.handleOverflow",
      unitId: this.unitId,
      toSendLen: toSend.length,
      overflowLen: overflow.length,
      splitAt,
    });

    if (this.state.status === "buffering") {
      // Send initial with truncated content
      const promise = this.isReply ? this.replyTo.reply(toSend) : this.channel.send(toSend);
      this.state = { status: "sending", content: toSend, promise };

      try {
        await promise;
        // Mark as finalized - overflow will be new message
        this.state = { status: "finalized" };
        logger.debug({ msg: "Unit.handleOverflow sent and finalized", unitId: this.unitId });
      } catch (error) {
        this.state = { status: "buffering", content };
        logger.error({ msg: "Unit.handleOverflow failed", unitId: this.unitId, error: String(error) });
        throw error;
      }
    } else if (this.state.status === "sent") {
      await this.state.discordMsg.edit(toSend);
      this.state = { status: "finalized" };
      logger.debug({ msg: "Unit.handleOverflow edited and finalized", unitId: this.unitId });
    }

    // Store overflow so the stream can retrieve it
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

    // Wait for any in-flight send to complete
    if (this.state.status === "sending") {
      logger.debug({ msg: "Unit.finalize waiting for send", unitId: this.unitId });
      try {
        const discordMsg = await this.state.promise;
        this.state = {
          status: "sent",
          content: this.state.content,
          discordMsg,
          lastEditLength: this.state.content.length,
        };
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

    // Immediately mark as finalized to prevent races
    const prevState = this.state;
    this.state = { status: "finalized" };

    try {
      if (prevState.status === "sent") {
        logger.debug({ msg: "Unit.finalize editing sent message", unitId: this.unitId, contentLen: content.length });
        await prevState.discordMsg.edit(content.slice(0, DISCORD_LIMIT));
        logger.debug({ msg: "Unit.finalize edit success", unitId: this.unitId });
      } else if (prevState.status === "buffering") {
        logger.debug({
          msg: "Unit.finalize sending buffered content",
          unitId: this.unitId,
          contentLen: content.length,
          isReply: this.isReply,
        });
        const msg = this.isReply
          ? await this.replyTo.reply(content.slice(0, DISCORD_LIMIT))
          : await this.channel.send(content.slice(0, DISCORD_LIMIT));
        // Already finalized, but store reference if needed
        (this as any)._finalMsg = msg;
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

  private lastAppendTime = Date.now();
  private flushTimer: NodeJS.Timeout | null = null;
  private pendingContent: string[] = [];
  private processing = false;
  private finalized = false;

  constructor(channel: TextChannel | ThreadChannel | DMChannel, replyTo: Message) {
    this.channel = channel;
    this.replyTo = replyTo;
    this.streamId = Math.random().toString(36).slice(2, 8);
    this.currentUnit = new DiscordMessageUnit(channel, replyTo, true); // First message is reply
    logger.info({ msg: "Stream created", streamId: this.streamId, channelId: channel.id });

    // Start the 1-second flush interval -- matches Discord's rate limit (5 req/5s per channel)
    this.flushTimer = setInterval(() => this.processPending(), EDIT_INTERVAL_MS);
  }

  /** Re-send typing indicator after each edit (edits clear the typing state in Discord) */
  private async refreshTyping(): Promise<void> {
    try {
      await this.channel.sendTyping();
    } catch (_) {
      /* channel gone, ignore */
    }
  }

  /**
   * Add content from a stream chunk.
   */
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
      // Drain all pending chunks into one batch, then flush ONCE
      const batch = this.pendingContent.splice(0, this.pendingContent.length).join("");
      if (!batch) return;

      const now = Date.now();
      const timeSinceLast = now - this.lastAppendTime;
      this.lastAppendTime = now;

      // Idle split: long pause with existing content -> start new message
      if (timeSinceLast > IDLE_SPLIT_MS && this.currentUnit.content.length > 0) {
        logger.info({
          msg: "Stream idle split",
          streamId: this.streamId,
          timeSinceLast,
          unitContent: this.currentUnit.content.length,
        });
        await this.currentUnit.finalize();
        this.completedUnits.push(this.currentUnit);
        this.currentUnit = new DiscordMessageUnit(this.channel, this.replyTo, false);
      }

      // Append entire batch at once, then flush once
      this.currentUnit.append(batch);
      await this.flushWithOverflowHandling();

      // Re-send typing indicator -- Discord clears it when we send/edit a message
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

  /**
   * Flush current unit, handling overflow by creating new units as needed.
   */
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
        // Unit split at a word boundary and finalized - get the overflow it stored
        const overflow = this.currentUnit.overflow;
        logger.info({ msg: "Stream overflow split", streamId: this.streamId, overflowLen: overflow.length });
        this.completedUnits.push(this.currentUnit);
        this.currentUnit = new DiscordMessageUnit(this.channel, this.replyTo, false);

        if (overflow.length > 0) {
          this.currentUnit.append(overflow);
          // Continue loop to handle if overflow itself exceeds limit
        } else {
          break;
        }
      } else {
        // 'ok' or 'skip' - no overflow, we're done
        break;
      }
    }
  }

  /**
   * Finalize the entire stream - flush any remaining content.
   */
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

    // Stop the flush interval (we'll process everything now)
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
      logger.debug({ msg: "Stream.finalize stopped flush interval", streamId: this.streamId });
    }

    // Wait for any ongoing processing to complete
    if (this.processing) {
      logger.info({ msg: "Stream.finalize waiting for processing to complete", streamId: this.streamId });
      // Poll until processing completes (processPending sets processing=false in finally block)
      let waitCount = 0;
      while (this.processing && waitCount < 100) {
        // Max 10 seconds
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

    // Process any remaining pending content -- batch into one append + flush
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

    // Finalize current unit
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

  /**
   * Get the last Discord message (for appending usage stats, etc.)
   */
  getLastMessage(): Message | null {
    const msg = this.currentUnit.discordMsg;
    logger.debug({ msg: "Stream.getLastMessage", streamId: this.streamId, hasMsg: !!msg });
    return msg;
  }
}

/**
 * Registry for managing active streams.
 * Separates per-message streams from event bus streams.
 */
export class StreamRegistry {
  // Per-message streams (keyed by Discord message ID)
  private streams = new Map<string, DiscordMessageStream>();
  // Event bus streams (keyed by session name, for cron/CLI/P2P injects)
  private eventBusStreams = new Map<string, DiscordMessageStream>();

  createStream(key: string, channel: TextChannel | ThreadChannel | DMChannel, replyTo: Message): DiscordMessageStream {
    const stream = new DiscordMessageStream(channel, replyTo);
    this.streams.set(key, stream);
    return stream;
  }

  getStream(key: string): DiscordMessageStream | undefined {
    return this.streams.get(key);
  }

  deleteStream(key: string): void {
    this.streams.delete(key);
  }

  createEventBusStream(
    sessionKey: string,
    channel: TextChannel | ThreadChannel | DMChannel,
    replyTo: Message,
  ): DiscordMessageStream {
    const stream = new DiscordMessageStream(channel, replyTo);
    this.eventBusStreams.set(sessionKey, stream);
    return stream;
  }

  getEventBusStream(sessionKey: string): DiscordMessageStream | undefined {
    return this.eventBusStreams.get(sessionKey);
  }

  deleteEventBusStream(sessionKey: string): void {
    this.eventBusStreams.delete(sessionKey);
  }

  /**
   * Handle an incoming stream chunk.
   * @param msg - The stream message chunk
   * @param streamKey - The Discord message ID (NOT session key) to prevent cross-message races
   */
  async handleChunk(msg: StreamMessage, streamKey: string): Promise<void> {
    const stream = this.streams.get(streamKey);
    if (!stream) {
      logger.warn({ msg: "handleChunk - no stream found", streamKey, msgType: msg.type });
      return;
    }

    // Handle system messages (including auto-compaction notifications)
    if (msg.type === "system" && msg.subtype === "compact_boundary") {
      const metadata = msg.metadata as { pre_tokens?: number; trigger?: string } | undefined;
      logger.info({ msg: "handleChunk - auto-compaction detected", streamKey, metadata });

      // Only notify for auto-compaction (not manual /compact which has its own handler)
      if (metadata?.trigger === "auto") {
        // Send a notification about auto-compaction
        let notification = "\u{1F4E6} **Auto-Compaction**\n";
        if (metadata.pre_tokens) {
          notification += `Context compressed from ~${Math.round(metadata.pre_tokens / 1000)}k tokens`;
        } else {
          notification += "Context has been automatically compressed";
        }

        // Append notification to the stream so it appears inline with the response
        stream.append(`\n\n${notification}\n\n`);
      }
      return;
    }

    // Extract text content from various message formats
    let textContent = "";
    if (msg.type === "text" && msg.content) {
      textContent = msg.content;
      logger.debug({ msg: "handleChunk - text content", streamKey, contentLen: textContent.length });
    } else if (msg.type === "assistant" && (msg as any).message?.content) {
      const content = (msg as any).message.content;
      if (Array.isArray(content)) {
        textContent = content.map((c: any) => c.text || "").join("");
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
}
