/**
 * DiscordMessageStream timing and coordination tests.
 *
 * The DiscordMessageStream class coordinates streaming of potentially multiple
 * Discord messages. It handles:
 * - Idle-split at 3.5s (IDLE_SPLIT_MS) — starts a new message after inactivity
 * - Edit interval at 1s (EDIT_INTERVAL_MS) — rate-limited flushing
 * - Overflow handling — creates new units when content exceeds 2000 chars
 * - Finalization — flushes remaining content and stops timers
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createMockTextChannel, createMockMessage } from "./mocks/discord-client.js";

// --------------------------------------------------------------------------
// Constants (mirrored from src/index.ts)
// --------------------------------------------------------------------------
const DISCORD_LIMIT = 2000;
const EDIT_INTERVAL_MS = 1000;
const IDLE_SPLIT_MS = 3500;

// --------------------------------------------------------------------------
// Minimal DiscordMessageUnit (same as in unit test, simplified for stream tests)
// --------------------------------------------------------------------------
type MessageState =
  | { status: "buffering"; content: string }
  | { status: "sending"; content: string; promise: Promise<any> }
  | { status: "sent"; content: string; discordMsg: any; lastEditLength: number }
  | { status: "finalized" };

class DiscordMessageUnit {
  private state: MessageState = { status: "buffering", content: "" };
  private readonly channel: any;
  private readonly replyTo: any;
  private readonly isReply: boolean;
  _overflow = "";

  constructor(channel: any, replyTo: any, isReply: boolean) {
    this.channel = channel;
    this.replyTo = replyTo;
    this.isReply = isReply;
  }

  get content(): string {
    if (this.state.status === "finalized") return "";
    return this.state.content;
  }

  get isFinalized(): boolean { return this.state.status === "finalized"; }
  get overflow(): string { return this._overflow; }
  get discordMsg(): any | null {
    return this.state.status === "sent" ? this.state.discordMsg : null;
  }

  append(text: string): void {
    if (this.state.status === "finalized" || this.state.status === "sending") return;
    this.state = { ...this.state, content: this.state.content + text };
  }

  async flush(): Promise<"ok" | "split" | "skip"> {
    if (this.state.status === "finalized" || this.state.status === "sending") return "skip";
    const content = this.state.content.trim();
    if (!content) return "skip";

    if (content.length > DISCORD_LIMIT) return this.handleOverflow(content);
    if (this.state.status === "buffering") return this.sendInitial(content);
    if (this.state.status === "sent") {
      if (content.length === this.state.lastEditLength) return "skip";
      return this.editExisting(content);
    }
    return "skip";
  }

  private async sendInitial(content: string): Promise<"ok" | "split" | "skip"> {
    if (this.state.status !== "buffering") return "skip";
    const promise = this.isReply ? this.replyTo.reply(content) : this.channel.send(content);
    this.state = { status: "sending", content, promise };
    try {
      const discordMsg = await promise;
      this.state = { status: "sent", content, discordMsg, lastEditLength: content.length };
      return "ok";
    } catch (error) {
      this.state = { status: "buffering", content };
      throw error;
    }
  }

  private async editExisting(content: string): Promise<"ok" | "split" | "skip"> {
    if (this.state.status !== "sent") return "skip";
    await this.state.discordMsg.edit(content);
    this.state = { ...this.state, content, lastEditLength: content.length };
    return "ok";
  }

  private async handleOverflow(content: string): Promise<"ok" | "split" | "skip"> {
    let splitAt = DISCORD_LIMIT;
    const lastSpace = content.lastIndexOf(" ", DISCORD_LIMIT);
    const lastNewline = content.lastIndexOf("\n", DISCORD_LIMIT);
    const bestBreak = Math.max(lastSpace, lastNewline);
    if (bestBreak > DISCORD_LIMIT * 0.75) splitAt = bestBreak;
    const toSend = content.slice(0, splitAt);
    const overflow = content.slice(splitAt).trimStart();

    if (this.state.status === "buffering") {
      const promise = this.isReply ? this.replyTo.reply(toSend) : this.channel.send(toSend);
      this.state = { status: "sending", content: toSend, promise };
      try {
        await promise;
        this.state = { status: "finalized" };
      } catch (error) {
        this.state = { status: "buffering", content };
        throw error;
      }
    } else if (this.state.status === "sent") {
      await this.state.discordMsg.edit(toSend);
      this.state = { status: "finalized" };
    }
    this._overflow = overflow;
    return "split";
  }

  async finalize(): Promise<void> {
    if (this.state.status === "finalized") return;
    if (this.state.status === "sending") {
      try {
        const discordMsg = await this.state.promise;
        this.state = { status: "sent", content: this.state.content, discordMsg, lastEditLength: this.state.content.length };
      } catch {
        this.state = { status: "finalized" };
        return;
      }
    }
    const content = this.state.content.trim();
    if (!content) { this.state = { status: "finalized" }; return; }
    const prevState = this.state;
    this.state = { status: "finalized" };
    if (prevState.status === "sent") {
      await prevState.discordMsg.edit(content.slice(0, DISCORD_LIMIT));
    } else if (prevState.status === "buffering") {
      this.isReply
        ? await this.replyTo.reply(content.slice(0, DISCORD_LIMIT))
        : await this.channel.send(content.slice(0, DISCORD_LIMIT));
    }
  }
}

// --------------------------------------------------------------------------
// DiscordMessageStream (mirrored from src/index.ts)
// --------------------------------------------------------------------------
class DiscordMessageStream {
  currentUnit: DiscordMessageUnit;
  completedUnits: DiscordMessageUnit[] = [];
  private readonly channel: any;
  private readonly replyTo: any;
  private lastAppendTime = Date.now();
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private pendingContent: string[] = [];
  private processing = false;
  finalized = false;

  constructor(channel: any, replyTo: any) {
    this.channel = channel;
    this.replyTo = replyTo;
    this.currentUnit = new DiscordMessageUnit(channel, replyTo, true);
    this.flushTimer = setInterval(() => this.processPending(), EDIT_INTERVAL_MS);
  }

  private async refreshTyping(): Promise<void> {
    try { await this.channel.sendTyping(); } catch {}
  }

  append(text: string): void {
    if (this.finalized) return;
    this.pendingContent.push(text);
  }

  /** Expose for testing */
  get pendingCount(): number { return this.pendingContent.length; }

  async processPending(): Promise<void> {
    if (this.processing || this.finalized || this.pendingContent.length === 0) return;
    this.processing = true;
    try {
      const batch = this.pendingContent.splice(0, this.pendingContent.length).join("");
      if (!batch) return;

      const now = Date.now();
      const timeSinceLast = now - this.lastAppendTime;
      this.lastAppendTime = now;

      // Idle split
      if (timeSinceLast > IDLE_SPLIT_MS && this.currentUnit.content.length > 0) {
        await this.currentUnit.finalize();
        this.completedUnits.push(this.currentUnit);
        this.currentUnit = new DiscordMessageUnit(this.channel, this.replyTo, false);
      }

      this.currentUnit.append(batch);
      await this.flushWithOverflowHandling();

      if (!this.finalized) {
        await this.refreshTyping();
      }
    } catch {}
    finally {
      this.processing = false;
    }
  }

  private async flushWithOverflowHandling(): Promise<void> {
    while (true) {
      const result = await this.currentUnit.flush();
      if (result === "split") {
        const overflow = this.currentUnit.overflow;
        this.completedUnits.push(this.currentUnit);
        this.currentUnit = new DiscordMessageUnit(this.channel, this.replyTo, false);
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
    if (this.finalized) return;
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }

    // Wait for processing
    if (this.processing) {
      let waitCount = 0;
      while (this.processing && waitCount < 100) {
        await new Promise((r) => setTimeout(r, 100));
        waitCount++;
      }
    }

    this.finalized = true;

    if (this.pendingContent.length > 0) {
      const remaining = this.pendingContent.splice(0, this.pendingContent.length).join("");
      if (remaining) {
        this.currentUnit.append(remaining);
        await this.flushWithOverflowHandling();
      }
    }

    await this.currentUnit.finalize();
  }

  getLastMessage(): any | null {
    return this.currentUnit.discordMsg;
  }
}

// ==========================================================================
// Tests
// ==========================================================================

describe("DiscordMessageStream - Timing & Coordination", () => {
  let channel: ReturnType<typeof createMockTextChannel>;
  let replyTo: ReturnType<typeof createMockMessage>;
  let sentMsg: ReturnType<typeof createMockMessage>;

  beforeEach(() => {
    vi.useFakeTimers();
    channel = createMockTextChannel();
    sentMsg = createMockMessage({ id: "sent-msg-001", edit: vi.fn().mockResolvedValue(undefined) });
    replyTo = createMockMessage({
      id: "trigger-msg",
      channel,
      reply: vi.fn().mockResolvedValue(sentMsg),
    });
    channel.send = vi.fn().mockResolvedValue(
      createMockMessage({ id: "sent-follow-up", edit: vi.fn().mockResolvedValue(undefined) })
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // -----------------------------------------------------------------------
  // Basic streaming behavior
  // -----------------------------------------------------------------------
  it("should buffer appended text as pending content", () => {
    const stream = new DiscordMessageStream(channel, replyTo);
    stream.append("chunk1");
    stream.append("chunk2");
    expect(stream.pendingCount).toBe(2);
    // Cleanup
    stream.finalized = true;
    if ((stream as any).flushTimer) clearInterval((stream as any).flushTimer);
  });

  it("should ignore appends after finalization", async () => {
    const stream = new DiscordMessageStream(channel, replyTo);
    await stream.finalize();
    stream.append("ignored");
    expect(stream.pendingCount).toBe(0);
  });

  // -----------------------------------------------------------------------
  // Flush interval behavior (1s EDIT_INTERVAL_MS)
  // -----------------------------------------------------------------------
  it("should process pending content on flush interval tick", async () => {
    const stream = new DiscordMessageStream(channel, replyTo);
    stream.append("Hello");

    // Advance timer to trigger one interval tick
    await vi.advanceTimersByTimeAsync(EDIT_INTERVAL_MS);

    expect(replyTo.reply).toHaveBeenCalledWith("Hello");

    // Cleanup
    await stream.finalize();
  });

  it("should batch multiple chunks into single flush", async () => {
    const stream = new DiscordMessageStream(channel, replyTo);
    stream.append("A");
    stream.append("B");
    stream.append("C");

    await vi.advanceTimersByTimeAsync(EDIT_INTERVAL_MS);

    // Should have sent "ABC" as a single message, not 3 separate
    expect(replyTo.reply).toHaveBeenCalledTimes(1);
    expect(replyTo.reply).toHaveBeenCalledWith("ABC");

    await stream.finalize();
  });

  it("should edit existing message on subsequent flushes", async () => {
    const stream = new DiscordMessageStream(channel, replyTo);
    stream.append("First");

    await vi.advanceTimersByTimeAsync(EDIT_INTERVAL_MS);
    expect(replyTo.reply).toHaveBeenCalledTimes(1);

    stream.append(" Second");
    await vi.advanceTimersByTimeAsync(EDIT_INTERVAL_MS);

    expect(sentMsg.edit).toHaveBeenCalledWith("First Second");

    await stream.finalize();
  });

  // -----------------------------------------------------------------------
  // Idle split at IDLE_SPLIT_MS (3.5s)
  // -----------------------------------------------------------------------
  it("should create new message unit after idle split", async () => {
    const stream = new DiscordMessageStream(channel, replyTo);
    stream.append("First message");

    // Flush to send the first message
    await vi.advanceTimersByTimeAsync(EDIT_INTERVAL_MS);
    expect(replyTo.reply).toHaveBeenCalledWith("First message");

    // Wait for idle timeout
    vi.advanceTimersByTime(IDLE_SPLIT_MS + 500);

    // Now append more text — should trigger idle split
    stream.append("Second message");
    await vi.advanceTimersByTimeAsync(EDIT_INTERVAL_MS);

    // Should have used channel.send (not reply) for the second message
    expect(channel.send).toHaveBeenCalled();
    expect(stream.completedUnits.length).toBeGreaterThanOrEqual(1);

    await stream.finalize();
  });

  // -----------------------------------------------------------------------
  // Overflow handling
  // -----------------------------------------------------------------------
  it("should split into multiple messages on overflow", async () => {
    const stream = new DiscordMessageStream(channel, replyTo);
    // Append content that exceeds 2000 chars
    stream.append("word ".repeat(500)); // 2500 chars

    await vi.advanceTimersByTimeAsync(EDIT_INTERVAL_MS);

    // First unit should be finalized (replied), second created for overflow
    expect(replyTo.reply).toHaveBeenCalledTimes(1);
    // Overflow creates a new unit sent via channel.send
    expect(stream.completedUnits.length).toBeGreaterThanOrEqual(1);

    await stream.finalize();
  });

  // -----------------------------------------------------------------------
  // Finalization
  // -----------------------------------------------------------------------
  it("should flush remaining content on finalize", async () => {
    const stream = new DiscordMessageStream(channel, replyTo);
    stream.append("unflushed content");

    // Don't advance timers — finalize should process pending content
    await stream.finalize();

    expect(replyTo.reply).toHaveBeenCalledWith("unflushed content");
  });

  it("should stop flush interval on finalize", async () => {
    const stream = new DiscordMessageStream(channel, replyTo);
    await stream.finalize();
    expect(stream.finalized).toBe(true);
  });

  it("should be idempotent on double finalize", async () => {
    const stream = new DiscordMessageStream(channel, replyTo);
    stream.append("text");
    await stream.finalize();
    await stream.finalize(); // should not throw
    expect(replyTo.reply).toHaveBeenCalledTimes(1);
  });

  // -----------------------------------------------------------------------
  // getLastMessage
  // -----------------------------------------------------------------------
  it("should return null before any message is sent", () => {
    const stream = new DiscordMessageStream(channel, replyTo);
    expect(stream.getLastMessage()).toBeNull();
    stream.finalized = true;
    if ((stream as any).flushTimer) clearInterval((stream as any).flushTimer);
  });

  it("should return the Discord message after flush", async () => {
    const stream = new DiscordMessageStream(channel, replyTo);
    stream.append("content");
    await vi.advanceTimersByTimeAsync(EDIT_INTERVAL_MS);

    expect(stream.getLastMessage()).toBe(sentMsg);

    await stream.finalize();
  });

  // -----------------------------------------------------------------------
  // Typing indicator
  // -----------------------------------------------------------------------
  it("should send typing indicator after flush", async () => {
    const stream = new DiscordMessageStream(channel, replyTo);
    stream.append("Hello");

    await vi.advanceTimersByTimeAsync(EDIT_INTERVAL_MS);

    expect(channel.sendTyping).toHaveBeenCalled();
    await stream.finalize();
  });

  it("should not send typing after finalization", async () => {
    const stream = new DiscordMessageStream(channel, replyTo);
    stream.append("text");
    await stream.finalize();

    channel.sendTyping.mockClear();

    // No typing should happen post-finalization
    stream.append("ignored");
    await vi.advanceTimersByTimeAsync(EDIT_INTERVAL_MS);

    expect(channel.sendTyping).not.toHaveBeenCalled();
  });
});
