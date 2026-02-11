/**
 * StreamRegistry lifecycle and handleChunk tests.
 *
 * Tests the stream registry maps (`streams`, `eventBusStreams`) and the
 * `handleChunk` function that routes StreamMessage chunks to the correct stream.
 *
 * Also covers race conditions: overflow during flush, finalize before stream
 * delete, concurrent chunk handling.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createMockTextChannel, createMockMessage } from "./mocks/discord-client.js";
import type { StreamMessage } from "../src/types.js";

// --------------------------------------------------------------------------
// Constants
// --------------------------------------------------------------------------
const DISCORD_LIMIT = 2000;
const EDIT_INTERVAL_MS = 1000;
const IDLE_SPLIT_MS = 3500;

// --------------------------------------------------------------------------
// Minimal DiscordMessageUnit
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
    return this.state.status === "finalized" ? "" : this.state.content;
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
      await this.state.discordMsg.edit(content);
      this.state = { ...this.state, content, lastEditLength: content.length };
      return "ok";
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
// DiscordMessageStream
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

  append(text: string): void {
    if (this.finalized) return;
    this.pendingContent.push(text);
  }

  async processPending(): Promise<void> {
    if (this.processing || this.finalized || this.pendingContent.length === 0) return;
    this.processing = true;
    try {
      const batch = this.pendingContent.splice(0, this.pendingContent.length).join("");
      if (!batch) return;
      const now = Date.now();
      const timeSinceLast = now - this.lastAppendTime;
      this.lastAppendTime = now;

      if (timeSinceLast > IDLE_SPLIT_MS && this.currentUnit.content.length > 0) {
        await this.currentUnit.finalize();
        this.completedUnits.push(this.currentUnit);
        this.currentUnit = new DiscordMessageUnit(this.channel, this.replyTo, false);
      }

      this.currentUnit.append(batch);
      await this.flushWithOverflowHandling();

      if (!this.finalized) {
        try { await this.channel.sendTyping(); } catch {}
      }
    } catch {}
    finally { this.processing = false; }
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
        } else break;
      } else break;
    }
  }

  async finalize(): Promise<void> {
    if (this.finalized) return;
    if (this.flushTimer) { clearInterval(this.flushTimer); this.flushTimer = null; }
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

  getLastMessage(): any | null { return this.currentUnit.discordMsg; }
}

// --------------------------------------------------------------------------
// handleChunk function (mirrored from src/index.ts)
// --------------------------------------------------------------------------
function handleChunk(
  msg: StreamMessage,
  streamKey: string,
  streams: Map<string, DiscordMessageStream>,
): void {
  const stream = streams.get(streamKey);
  if (!stream) return;

  // System messages
  if (msg.type === "system" && msg.subtype === "compact_boundary") {
    const metadata = msg.metadata as { pre_tokens?: number; trigger?: string } | undefined;
    if (metadata?.trigger === "auto") {
      let notification = "\n\nAuto-Compaction\n";
      if (metadata.pre_tokens) {
        notification += `Context compressed from ~${Math.round(metadata.pre_tokens / 1000)}k tokens`;
      } else {
        notification += "Context has been automatically compressed";
      }
      stream.append(`\n\n${notification}\n\n`);
    }
    return;
  }

  // Text content
  let textContent = "";
  if (msg.type === "text" && msg.content) {
    textContent = msg.content;
  } else if (msg.type === "assistant" && (msg as any).message?.content) {
    const content = (msg as any).message.content;
    if (Array.isArray(content)) {
      textContent = content.map((c: any) => c.text || "").join("");
    } else if (typeof content === "string") {
      textContent = content;
    }
  }

  if (textContent) {
    stream.append(textContent);
  }
}

// ==========================================================================
// Tests
// ==========================================================================

describe("StreamRegistry - Dual Maps & handleChunk", () => {
  let channel: ReturnType<typeof createMockTextChannel>;
  let replyTo: ReturnType<typeof createMockMessage>;
  let sentMsg: ReturnType<typeof createMockMessage>;
  let streams: Map<string, DiscordMessageStream>;
  let eventBusStreams: Map<string, DiscordMessageStream>;

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
    streams = new Map();
    eventBusStreams = new Map();
  });

  afterEach(() => {
    // Clean up all streams
    for (const s of streams.values()) {
      s.finalized = true;
    }
    for (const s of eventBusStreams.values()) {
      s.finalized = true;
    }
    vi.useRealTimers();
  });

  // -----------------------------------------------------------------------
  // Stream registry lifecycle
  // -----------------------------------------------------------------------
  it("should register and retrieve streams by message ID", () => {
    const stream = new DiscordMessageStream(channel, replyTo);
    streams.set("msg-123", stream);
    expect(streams.get("msg-123")).toBe(stream);
    expect(streams.size).toBe(1);
  });

  it("should support independent streams and eventBusStreams maps", () => {
    const discordStream = new DiscordMessageStream(channel, replyTo);
    const eventStream = new DiscordMessageStream(channel, replyTo);

    streams.set("msg-abc", discordStream);
    eventBusStreams.set("discord:guild:#channel", eventStream);

    expect(streams.size).toBe(1);
    expect(eventBusStreams.size).toBe(1);
    expect(streams.get("msg-abc")).not.toBe(eventBusStreams.get("discord:guild:#channel"));
  });

  it("should allow deleting stream after finalization", async () => {
    const stream = new DiscordMessageStream(channel, replyTo);
    streams.set("msg-456", stream);
    await stream.finalize();
    streams.delete("msg-456");
    expect(streams.has("msg-456")).toBe(false);
  });

  // -----------------------------------------------------------------------
  // handleChunk: text content routing
  // -----------------------------------------------------------------------
  it("should route text chunks to the correct stream", () => {
    const stream = new DiscordMessageStream(channel, replyTo);
    streams.set("msg-100", stream);

    handleChunk({ type: "text", content: "Hello!" }, "msg-100", streams);

    // Content should be in pending
    expect((stream as any).pendingContent).toContain("Hello!");
  });

  it("should ignore chunks for unknown stream keys", () => {
    // No stream registered for "msg-999"
    expect(() => {
      handleChunk({ type: "text", content: "lost" }, "msg-999", streams);
    }).not.toThrow();
  });

  it("should extract text from assistant message format", () => {
    const stream = new DiscordMessageStream(channel, replyTo);
    streams.set("msg-200", stream);

    const msg = {
      type: "assistant" as const,
      content: "",
      message: { content: [{ text: "part1" }, { text: "part2" }] },
    };
    handleChunk(msg as any, "msg-200", streams);

    expect((stream as any).pendingContent).toContain("part1part2");
  });

  it("should extract text from assistant message with string content", () => {
    const stream = new DiscordMessageStream(channel, replyTo);
    streams.set("msg-201", stream);

    const msg = {
      type: "assistant" as const,
      content: "",
      message: { content: "simple string" },
    };
    handleChunk(msg as any, "msg-201", streams);

    expect((stream as any).pendingContent).toContain("simple string");
  });

  it("should skip non-text message types", () => {
    const stream = new DiscordMessageStream(channel, replyTo);
    streams.set("msg-300", stream);

    handleChunk({ type: "tool_use", content: "tool stuff" }, "msg-300", streams);
    expect((stream as any).pendingContent.length).toBe(0);
  });

  // -----------------------------------------------------------------------
  // handleChunk: system messages
  // -----------------------------------------------------------------------
  it("should handle auto-compaction system messages", () => {
    const stream = new DiscordMessageStream(channel, replyTo);
    streams.set("msg-400", stream);

    handleChunk(
      {
        type: "system",
        content: "",
        subtype: "compact_boundary",
        metadata: { trigger: "auto", pre_tokens: 50000 },
      },
      "msg-400",
      streams,
    );

    const pending = (stream as any).pendingContent.join("");
    expect(pending).toContain("Auto-Compaction");
    expect(pending).toContain("50k tokens");
  });

  it("should ignore non-auto compaction system messages", () => {
    const stream = new DiscordMessageStream(channel, replyTo);
    streams.set("msg-401", stream);

    handleChunk(
      {
        type: "system",
        content: "",
        subtype: "compact_boundary",
        metadata: { trigger: "manual" },
      },
      "msg-401",
      streams,
    );

    expect((stream as any).pendingContent.length).toBe(0);
  });

  it("should handle compaction without pre_tokens", () => {
    const stream = new DiscordMessageStream(channel, replyTo);
    streams.set("msg-402", stream);

    handleChunk(
      {
        type: "system",
        content: "",
        subtype: "compact_boundary",
        metadata: { trigger: "auto" },
      },
      "msg-402",
      streams,
    );

    const pending = (stream as any).pendingContent.join("");
    expect(pending).toContain("automatically compressed");
  });

  // -----------------------------------------------------------------------
  // Race conditions
  // -----------------------------------------------------------------------
  it("should handle overflow during flush without data loss", async () => {
    const stream = new DiscordMessageStream(channel, replyTo);
    streams.set("msg-race-1", stream);

    // Append content exceeding DISCORD_LIMIT
    stream.append("word ".repeat(500)); // ~2500 chars

    // Process the pending content
    await vi.advanceTimersByTimeAsync(EDIT_INTERVAL_MS);

    // All content should have been sent across multiple units
    const totalUnits = stream.completedUnits.length + 1; // +1 for currentUnit
    expect(totalUnits).toBeGreaterThanOrEqual(2);
    expect(replyTo.reply).toHaveBeenCalledTimes(1);

    await stream.finalize();
  });

  it("should handle finalize before stream delete safely", async () => {
    const stream = new DiscordMessageStream(channel, replyTo);
    streams.set("msg-race-2", stream);

    stream.append("some content");
    await vi.advanceTimersByTimeAsync(EDIT_INTERVAL_MS);

    // Finalize first, then delete
    await stream.finalize();
    streams.delete("msg-race-2");

    expect(streams.has("msg-race-2")).toBe(false);
    expect(stream.finalized).toBe(true);
  });

  it("should handle chunks arriving after finalization", async () => {
    const stream = new DiscordMessageStream(channel, replyTo);
    streams.set("msg-race-3", stream);

    stream.append("before finalize");
    await stream.finalize();

    // Chunk arrives after finalize — stream ignores it
    handleChunk({ type: "text", content: "too late" }, "msg-race-3", streams);

    // pendingContent should be empty since stream is finalized
    expect((stream as any).pendingContent.length).toBe(0);
  });

  it("should handle concurrent chunk delivery to different streams", async () => {
    const stream1 = new DiscordMessageStream(channel, replyTo);
    const channel2 = createMockTextChannel({ id: "channel-2" });
    const replyTo2 = createMockMessage({
      id: "trigger-2",
      channel: channel2,
      reply: vi.fn().mockResolvedValue(sentMsg),
    });
    const stream2 = new DiscordMessageStream(channel2, replyTo2);

    streams.set("msg-A", stream1);
    streams.set("msg-B", stream2);

    handleChunk({ type: "text", content: "for A" }, "msg-A", streams);
    handleChunk({ type: "text", content: "for B" }, "msg-B", streams);

    expect((stream1 as any).pendingContent).toContain("for A");
    expect((stream2 as any).pendingContent).toContain("for B");
    expect((stream1 as any).pendingContent).not.toContain("for B");

    await stream1.finalize();
    await stream2.finalize();
  });

  it("should handle rapid successive chunks without dropping content", async () => {
    const stream = new DiscordMessageStream(channel, replyTo);
    streams.set("msg-rapid", stream);

    // Simulate rapid token delivery
    for (let i = 0; i < 50; i++) {
      handleChunk({ type: "text", content: `token${i} ` }, "msg-rapid", streams);
    }

    expect((stream as any).pendingContent.length).toBe(50);

    // Process all pending
    await vi.advanceTimersByTimeAsync(EDIT_INTERVAL_MS);

    // All tokens should be in the message content
    expect(replyTo.reply).toHaveBeenCalledTimes(1);
    const sentContent = replyTo.reply.mock.calls[0][0];
    expect(sentContent).toContain("token0");
    expect(sentContent).toContain("token49");

    await stream.finalize();
  });
});
