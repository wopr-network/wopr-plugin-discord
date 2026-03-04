/**
 * DiscordMessageUnit state machine tests.
 *
 * The DiscordMessageUnit class manages a single Discord message's lifecycle
 * with states: buffering → sending → sent → finalized.
 *
 * Since the class is private to src/index.ts, we re-implement the same state
 * machine logic here and validate the behavioral contracts using mocks.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockTextChannel, createMockMessage } from "./mocks/discord-client.js";

// --------------------------------------------------------------------------
// Constants (mirrored from src/index.ts)
// --------------------------------------------------------------------------
const DISCORD_LIMIT = 2000;

// --------------------------------------------------------------------------
// Minimal re-implementation of DiscordMessageUnit for testing
// --------------------------------------------------------------------------
type MessageState =
  | { status: "buffering"; content: string }
  | { status: "sending"; content: string; promise: Promise<any>; pendingWhileSending: string }
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

  get isFinalized(): boolean {
    return this.state.status === "finalized";
  }

  get discordMsg(): any | null {
    if (this.state.status === "sent") return this.state.discordMsg;
    return null;
  }

  get overflow(): string {
    return this._overflow;
  }

  /** Expose state status for test assertions */
  get status(): string {
    return this.state.status;
  }

  append(text: string): void {
    if (this.state.status === "finalized") return;
    if (this.state.status === "sending") {
      this.state = { ...this.state, pendingWhileSending: this.state.pendingWhileSending + text };
      return;
    }
    this.state = { ...this.state, content: this.state.content + text };
  }

  async flush(): Promise<"ok" | "split" | "skip"> {
    if (this.state.status === "finalized") return "skip";
    if (this.state.status === "sending") return "skip";

    const content = this.state.content.trim();
    if (!content) return "skip";

    if (content.length > DISCORD_LIMIT) {
      return this.handleOverflow(content);
    }

    if (this.state.status === "buffering") {
      return this.sendInitial(content);
    }

    if (this.state.status === "sent") {
      if (content.length === this.state.lastEditLength) return "skip";
      return this.editExisting(content);
    }

    return "skip";
  }

  private async sendInitial(content: string): Promise<"ok" | "split" | "skip"> {
    if (this.state.status !== "buffering") return "skip";

    const promise = this.isReply ? this.replyTo.reply(content) : this.channel.send(content);
    this.state = { status: "sending", content, promise, pendingWhileSending: "" };

    try {
      const discordMsg = await promise;
      const buffered = this.state.status === "sending" ? this.state.pendingWhileSending : "";
      this.state = { status: "sent", content: content + buffered, discordMsg, lastEditLength: content.length };
      return "ok";
    } catch (error) {
      const buffered = this.state.status === "sending" ? this.state.pendingWhileSending : "";
      this.state = { status: "buffering", content: content + buffered };
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
    if (bestBreak > DISCORD_LIMIT * 0.75) {
      splitAt = bestBreak;
    }
    const toSend = content.slice(0, splitAt);
    let overflow = content.slice(splitAt).trimStart();

    if (this.state.status === "buffering") {
      const promise = this.isReply ? this.replyTo.reply(toSend) : this.channel.send(toSend);
      this.state = { status: "sending", content: toSend, promise, pendingWhileSending: "" };

      try {
        await promise;
        const buffered = this.state.status === "sending" ? this.state.pendingWhileSending : "";
        this.state = { status: "finalized" };
        if (buffered) {
          overflow = overflow + buffered;
        }
      } catch (error) {
        const buffered = this.state.status === "sending" ? this.state.pendingWhileSending : "";
        this.state = { status: "buffering", content: content + buffered };
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
        const sendContent = this.state.content;
        const discordMsg = await this.state.promise;
        if (this.state.status === "sending") {
          // finalize won the race — read pendingWhileSending now, after the await
          const pendingText = this.state.pendingWhileSending;
          this.state = {
            status: "sent",
            content: sendContent + pendingText,
            discordMsg,
            lastEditLength: sendContent.length,
          };
        } else if (this.state.status === "finalized") {
          return;
        }
        // else: sendInitial ran first and set state to "sent" — use that state below
      } catch {
        this.state = { status: "finalized" };
        return;
      }
    }

    const content = this.state.content.trim();
    if (!content) {
      this.state = { status: "finalized" };
      return;
    }

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

// ==========================================================================
// Tests
// ==========================================================================

describe("DiscordMessageUnit - State Machine", () => {
  let channel: ReturnType<typeof createMockTextChannel>;
  let replyTo: ReturnType<typeof createMockMessage>;
  let sentMsg: ReturnType<typeof createMockMessage>;

  beforeEach(() => {
    channel = createMockTextChannel();
    sentMsg = createMockMessage({ id: "sent-msg-001", edit: vi.fn().mockResolvedValue(undefined) });
    replyTo = createMockMessage({
      id: "trigger-msg",
      channel,
      reply: vi.fn().mockResolvedValue(sentMsg),
    });
    // channel.send also returns sentMsg by default
    channel.send = vi.fn().mockResolvedValue(sentMsg);
  });

  // -----------------------------------------------------------------------
  // Initial state
  // -----------------------------------------------------------------------
  it("should start in buffering state with empty content", () => {
    const unit = new DiscordMessageUnit(channel, replyTo, true);
    expect(unit.status).toBe("buffering");
    expect(unit.content).toBe("");
    expect(unit.isFinalized).toBe(false);
    expect(unit.discordMsg).toBeNull();
  });

  // -----------------------------------------------------------------------
  // Append behavior
  // -----------------------------------------------------------------------
  it("should accumulate text via append in buffering state", () => {
    const unit = new DiscordMessageUnit(channel, replyTo, true);
    unit.append("Hello ");
    unit.append("world!");
    expect(unit.content).toBe("Hello world!");
  });

  it("should buffer text appended during sending state and flush after send completes", async () => {
    let resolveSend: (msg: any) => void;
    const sendPromise = new Promise<any>((r) => { resolveSend = r; });
    replyTo.reply = vi.fn().mockReturnValue(sendPromise);

    const unit = new DiscordMessageUnit(channel, replyTo, true);
    unit.append("Hello");

    // Start flush - enters sending state
    const flushPromise = unit.flush();

    // Append while sending - should be buffered, not dropped
    unit.append(" world");
    unit.append("!");

    // Resolve the send
    resolveSend!(sentMsg);
    await flushPromise;

    // Buffered content should be merged
    expect(unit.content).toBe("Hello world!");
    expect(unit.status).toBe("sent");
  });

  it("should flush buffered content through finalize when sending", async () => {
    let resolveSend: (msg: any) => void;
    const sendPromise = new Promise<any>((r) => { resolveSend = r; });
    replyTo.reply = vi.fn().mockReturnValue(sendPromise);

    const unit = new DiscordMessageUnit(channel, replyTo, true);
    unit.append("start");

    const flushPromise = unit.flush();

    // Append while sending
    unit.append(" end");

    const finalizePromise = unit.finalize();

    resolveSend!(sentMsg);
    await flushPromise;
    await finalizePromise;

    expect(unit.isFinalized).toBe(true);
    // The finalize should have edited with the merged content
    expect(sentMsg.edit).toHaveBeenCalledWith("start end");
  });

  it("should ignore append when finalized", async () => {
    const unit = new DiscordMessageUnit(channel, replyTo, true);
    unit.append("some text");
    await unit.finalize();
    unit.append("more text");
    expect(unit.content).toBe(""); // finalized returns ""
    expect(unit.isFinalized).toBe(true);
  });

  // -----------------------------------------------------------------------
  // flush: buffering → sending → sent
  // -----------------------------------------------------------------------
  it("should transition buffering → sent on flush (reply mode)", async () => {
    const unit = new DiscordMessageUnit(channel, replyTo, true);
    unit.append("Hello!");
    const result = await unit.flush();

    expect(result).toBe("ok");
    expect(unit.status).toBe("sent");
    expect(replyTo.reply).toHaveBeenCalledWith("Hello!");
    expect(channel.send).not.toHaveBeenCalled();
  });

  it("should transition buffering → sent on flush (channel send mode)", async () => {
    const unit = new DiscordMessageUnit(channel, replyTo, false);
    unit.append("Hello!");
    const result = await unit.flush();

    expect(result).toBe("ok");
    expect(unit.status).toBe("sent");
    expect(channel.send).toHaveBeenCalledWith("Hello!");
    expect(replyTo.reply).not.toHaveBeenCalled();
  });

  it("should skip flush when content is empty", async () => {
    const unit = new DiscordMessageUnit(channel, replyTo, true);
    const result = await unit.flush();
    expect(result).toBe("skip");
  });

  it("should skip flush when content is only whitespace", async () => {
    const unit = new DiscordMessageUnit(channel, replyTo, true);
    unit.append("   \n  ");
    const result = await unit.flush();
    expect(result).toBe("skip");
  });

  // -----------------------------------------------------------------------
  // flush: sent → edit existing
  // -----------------------------------------------------------------------
  it("should edit existing message on subsequent flush", async () => {
    const unit = new DiscordMessageUnit(channel, replyTo, true);
    unit.append("Hello");
    await unit.flush();

    unit.append(" world!");
    const result = await unit.flush();

    expect(result).toBe("ok");
    expect(sentMsg.edit).toHaveBeenCalledWith("Hello world!");
  });

  it("should skip edit when content has not changed", async () => {
    const unit = new DiscordMessageUnit(channel, replyTo, true);
    unit.append("Hello");
    await unit.flush();

    const result = await unit.flush();
    expect(result).toBe("skip");
    expect(sentMsg.edit).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // flush: overflow handling (content > 2000 chars)
  // -----------------------------------------------------------------------
  it("should split content at word boundary when exceeding DISCORD_LIMIT", async () => {
    const unit = new DiscordMessageUnit(channel, replyTo, true);
    // Create content that exceeds 2000 chars with a space near the boundary
    const filler = "word ".repeat(400); // 2000 chars
    const overflow = "overflow text here";
    unit.append(filler + overflow);

    const result = await unit.flush();

    expect(result).toBe("split");
    expect(unit.isFinalized).toBe(true);
    expect(unit.overflow.length).toBeGreaterThan(0);
  });

  it("should finalize after handling overflow in buffering state", async () => {
    const unit = new DiscordMessageUnit(channel, replyTo, false);
    unit.append("x".repeat(2001));

    const result = await unit.flush();

    expect(result).toBe("split");
    expect(unit.isFinalized).toBe(true);
    expect(channel.send).toHaveBeenCalled();
  });

  it("should finalize after handling overflow in sent state", async () => {
    const unit = new DiscordMessageUnit(channel, replyTo, true);
    unit.append("initial");
    await unit.flush(); // now in sent state

    // Replace content to exceed limit
    // We need to append enough to go over 2000
    unit.append("x".repeat(2000));
    const result = await unit.flush();

    expect(result).toBe("split");
    expect(unit.isFinalized).toBe(true);
  });

  // -----------------------------------------------------------------------
  // flush: error recovery
  // -----------------------------------------------------------------------
  it("should rollback to buffering on send failure", async () => {
    replyTo.reply = vi.fn().mockRejectedValue(new Error("Discord API error"));
    const unit = new DiscordMessageUnit(channel, replyTo, true);
    unit.append("Hello");

    await expect(unit.flush()).rejects.toThrow("Discord API error");
    expect(unit.status).toBe("buffering");
    expect(unit.content).toBe("Hello");
  });

  // -----------------------------------------------------------------------
  // finalize
  // -----------------------------------------------------------------------
  it("should do nothing when already finalized", async () => {
    const unit = new DiscordMessageUnit(channel, replyTo, true);
    unit.append("text");
    await unit.finalize();
    // Second finalize should be a no-op
    await unit.finalize();
    expect(unit.isFinalized).toBe(true);
  });

  it("should send buffered content on finalize", async () => {
    const unit = new DiscordMessageUnit(channel, replyTo, true);
    unit.append("Final text");
    await unit.finalize();

    expect(unit.isFinalized).toBe(true);
    expect(replyTo.reply).toHaveBeenCalledWith("Final text");
  });

  it("should edit sent message with final content on finalize", async () => {
    const unit = new DiscordMessageUnit(channel, replyTo, true);
    unit.append("partial");
    await unit.flush(); // now sent
    unit.append(" complete");
    await unit.finalize();

    expect(unit.isFinalized).toBe(true);
    expect(sentMsg.edit).toHaveBeenCalledWith("partial complete");
  });

  it("should wait for in-flight send before finalizing", async () => {
    let resolveSend: (msg: any) => void;
    const sendPromise = new Promise<any>((r) => { resolveSend = r; });
    replyTo.reply = vi.fn().mockReturnValue(sendPromise);

    const unit = new DiscordMessageUnit(channel, replyTo, true);
    unit.append("inflight");

    // Start flush (will be in sending state)
    const flushPromise = unit.flush();

    // Start finalize while sending
    const finalizePromise = unit.finalize();

    // Resolve the send
    resolveSend!(sentMsg);

    await flushPromise;
    await finalizePromise;

    expect(unit.isFinalized).toBe(true);
  });

  it("should finalize gracefully when in-flight send fails", async () => {
    let rejectSend: (err: Error) => void;
    const sendPromise = new Promise<any>((_, r) => { rejectSend = r; });
    replyTo.reply = vi.fn().mockReturnValue(sendPromise);

    const unit = new DiscordMessageUnit(channel, replyTo, true);
    unit.append("will fail");

    const flushPromise = unit.flush();
    const finalizePromise = unit.finalize();

    rejectSend!(new Error("Network error"));

    await flushPromise.catch(() => {}); // swallow the flush error
    await finalizePromise;

    expect(unit.isFinalized).toBe(true);
  });

  it("should skip finalize for empty content", async () => {
    const unit = new DiscordMessageUnit(channel, replyTo, true);
    await unit.finalize();

    expect(unit.isFinalized).toBe(true);
    expect(replyTo.reply).not.toHaveBeenCalled();
    expect(channel.send).not.toHaveBeenCalled();
  });

  it("should buffer text appended during handleOverflow send and merge in correct chronological order", async () => {
    let resolveSend: (msg: any) => void;
    const sendPromise = new Promise<any>((r) => { resolveSend = r; });
    replyTo.reply = vi.fn().mockReturnValue(sendPromise);

    const unit = new DiscordMessageUnit(channel, replyTo, true);
    // 2000 'A' chars + 5 overflow chars
    unit.append("A".repeat(DISCORD_LIMIT) + "EXTRA");

    // Start flush — triggers handleOverflow, enters sending state
    const flushPromise = unit.flush();

    // Append while sending — should be buffered in pendingWhileSending
    unit.append("PENDING");

    // Resolve the send
    resolveSend!(sentMsg);
    const result = await flushPromise;

    // handleOverflow returns "split"
    expect(result).toBe("split");
    // Unit is finalized after overflow handling
    expect(unit.isFinalized).toBe(true);
    // overflow must preserve chronological order: original tail first, then text appended during send
    expect(unit.overflow).toBe("EXTRA" + "PENDING");
  });

  it("should truncate to DISCORD_LIMIT on finalize", async () => {
    const unit = new DiscordMessageUnit(channel, replyTo, true);
    unit.append("x".repeat(3000));
    // Get to sent state first with a flush (which will split)
    // Instead, test finalize from buffering with long content
    const unit2 = new DiscordMessageUnit(channel, replyTo, false);
    unit2.append("a".repeat(2500));
    await unit2.finalize();

    const sendCall = channel.send.mock.calls[channel.send.mock.calls.length - 1];
    expect(sendCall[0].length).toBeLessThanOrEqual(DISCORD_LIMIT);
  });
});
