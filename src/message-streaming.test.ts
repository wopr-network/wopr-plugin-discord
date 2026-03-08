import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock logger before importing module under test
vi.mock("./logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { createMockChannel, createMockMessage } from "./__test-utils__/mocks.js";
import {
  DISCORD_LIMIT,
  DiscordMessageStream,
  DiscordMessageUnit,
  eventBusStreams,
  handleChunk,
  streams,
} from "./message-streaming.js";

describe("DiscordMessageUnit", () => {
  let channel: any;
  let replyTo: any;

  beforeEach(() => {
    vi.useFakeTimers();
    channel = createMockChannel();
    replyTo = createMockMessage();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("append", () => {
    it("should accumulate content in buffering state", () => {
      const unit = new DiscordMessageUnit(channel, replyTo, false);
      unit.append("Hello ");
      unit.append("World");
      expect(unit.content).toBe("Hello World");
    });

    it("should ignore append after finalization", async () => {
      const unit = new DiscordMessageUnit(channel, replyTo, false);
      await unit.finalize();
      unit.append("ignored");
      expect(unit.isFinalized).toBe(true);
    });
  });

  describe("flush", () => {
    it("should return 'skip' when content is empty", async () => {
      const unit = new DiscordMessageUnit(channel, replyTo, false);
      const result = await unit.flush();
      expect(result).toBe("skip");
    });

    it("should return 'skip' when finalized", async () => {
      const unit = new DiscordMessageUnit(channel, replyTo, false);
      await unit.finalize();
      const result = await unit.flush();
      expect(result).toBe("skip");
    });

    it("should send initial message via channel.send when not a reply", async () => {
      const unit = new DiscordMessageUnit(channel, replyTo, false);
      unit.append("Hello");
      const result = await unit.flush();
      expect(result).toBe("ok");
      expect(channel.send).toHaveBeenCalledWith("Hello");
    });

    it("should send initial message via replyTo.reply when isReply=true", async () => {
      const unit = new DiscordMessageUnit(channel, replyTo, true);
      unit.append("Hello");
      const result = await unit.flush();
      expect(result).toBe("ok");
      expect(replyTo.reply).toHaveBeenCalledWith("Hello");
    });

    it("should edit existing message on subsequent flushes", async () => {
      const sentMsg = { id: "sent-1", edit: vi.fn().mockResolvedValue(undefined) };
      channel.send.mockResolvedValueOnce(sentMsg);
      const unit = new DiscordMessageUnit(channel, replyTo, false);
      unit.append("Hello");
      await unit.flush();
      unit.append(" World");
      const result = await unit.flush();
      expect(result).toBe("ok");
      expect(sentMsg.edit).toHaveBeenCalledWith("Hello World");
    });

    it("should return 'skip' when content has not changed since last edit", async () => {
      const sentMsg = { id: "sent-1", edit: vi.fn().mockResolvedValue(undefined) };
      channel.send.mockResolvedValueOnce(sentMsg);
      const unit = new DiscordMessageUnit(channel, replyTo, false);
      unit.append("Hello");
      await unit.flush();
      const result = await unit.flush();
      expect(result).toBe("skip");
    });

    it("should return 'split' when content exceeds DISCORD_LIMIT", async () => {
      const sentMsg = { id: "sent-1", edit: vi.fn().mockResolvedValue(undefined) };
      channel.send.mockResolvedValueOnce(sentMsg);
      const unit = new DiscordMessageUnit(channel, replyTo, false);
      const longContent = "a".repeat(DISCORD_LIMIT + 100);
      unit.append(longContent);
      const result = await unit.flush();
      expect(result).toBe("split");
      expect(unit.overflow.length).toBeGreaterThan(0);
      expect(unit.isFinalized).toBe(true);
    });
  });

  describe("rate-limit retry (via flush/finalize)", () => {
    it("should retry on 429 and succeed on second attempt", async () => {
      const rateLimitError: any = new Error("Rate limited");
      rateLimitError.httpStatus = 429;
      rateLimitError.retryAfter = 1; // 1ms (retryAfter is already in ms per @discordjs/rest)
      const sentMsg = { id: "sent-1", edit: vi.fn() };
      channel.send.mockRejectedValueOnce(rateLimitError).mockResolvedValueOnce(sentMsg);

      const unit = new DiscordMessageUnit(channel, replyTo, false);
      unit.append("Hello");

      const flushPromise = unit.flush();
      // The retry waits retryAfter ms = 1ms
      await vi.advanceTimersByTimeAsync(10);
      const result = await flushPromise;

      expect(result).toBe("ok");
      expect(channel.send).toHaveBeenCalledTimes(2);
    });

    it("should throw after max retries exhausted on persistent 429", async () => {
      const rateLimitError: any = new Error("Rate limited");
      rateLimitError.httpStatus = 429;
      rateLimitError.retryAfter = 1; // 1ms (retryAfter is already in ms per @discordjs/rest)

      channel.send.mockRejectedValue(rateLimitError);

      const unit = new DiscordMessageUnit(channel, replyTo, false);
      unit.append("Hello");

      // Wrap in a promise that we can control timing on
      let caughtError: unknown;
      const flushPromise = unit.flush().catch((err) => {
        caughtError = err;
      });
      // Advance enough for all retries (3 retries x small delays)
      await vi.advanceTimersByTimeAsync(100);
      await flushPromise;

      expect(caughtError).toBeDefined();
      expect(String(caughtError)).toContain("Rate limited");
    });

    it("should use retry-after header value from error", async () => {
      const rateLimitError: any = new Error("Rate limited");
      rateLimitError.httpStatus = 429;
      rateLimitError.retryAfter = 500; // 500ms (retryAfter is already in ms per @discordjs/rest)

      const sentMsg = { id: "sent-1", edit: vi.fn() };
      channel.send.mockRejectedValueOnce(rateLimitError).mockResolvedValueOnce(sentMsg);

      const unit = new DiscordMessageUnit(channel, replyTo, false);
      unit.append("Hello");

      const flushPromise = unit.flush();
      // retryAfterMs = 500ms
      await vi.advanceTimersByTimeAsync(600);
      const result = await flushPromise;

      expect(result).toBe("ok");
      expect(channel.send).toHaveBeenCalledTimes(2);
    });

    it("should re-throw non-rate-limit errors immediately", async () => {
      const otherError = new Error("Permission denied");
      channel.send.mockRejectedValueOnce(otherError);

      const unit = new DiscordMessageUnit(channel, replyTo, false);
      unit.append("Hello");

      await expect(unit.flush()).rejects.toThrow("Permission denied");
      expect(channel.send).toHaveBeenCalledTimes(1);
    });
  });

  describe("finalize", () => {
    it("should send buffered content on finalize if never flushed", async () => {
      const unit = new DiscordMessageUnit(channel, replyTo, false);
      unit.append("Final content");
      await unit.finalize();
      expect(channel.send).toHaveBeenCalledWith("Final content");
      expect(unit.isFinalized).toBe(true);
    });

    it("should edit sent message on finalize with latest content", async () => {
      const sentMsg = { id: "sent-1", edit: vi.fn().mockResolvedValue(undefined) };
      channel.send.mockResolvedValueOnce(sentMsg);
      const unit = new DiscordMessageUnit(channel, replyTo, false);
      unit.append("Hello");
      await unit.flush();
      unit.append(" final");
      await unit.finalize();
      expect(sentMsg.edit).toHaveBeenCalledWith("Hello final");
    });

    it("should be safe to call finalize multiple times", async () => {
      const unit = new DiscordMessageUnit(channel, replyTo, false);
      unit.append("content");
      await unit.finalize();
      await unit.finalize(); // should not throw
      expect(unit.isFinalized).toBe(true);
    });

    it("should truncate to DISCORD_LIMIT on finalize", async () => {
      const sentMsg = { id: "sent-1", edit: vi.fn().mockResolvedValue(undefined) };
      channel.send.mockResolvedValueOnce(sentMsg);
      const unit = new DiscordMessageUnit(channel, replyTo, false);
      // First flush to get into "sent" state
      unit.append("a");
      await unit.flush();
      // Now append a lot then finalize
      unit.append("b".repeat(DISCORD_LIMIT + 500));
      await unit.finalize();
      const editCall = sentMsg.edit.mock.calls[sentMsg.edit.mock.calls.length - 1][0];
      expect(editCall.length).toBeLessThanOrEqual(DISCORD_LIMIT);
    });
  });

  describe("overflow splitting", () => {
    it("should prefer splitting at word boundary", async () => {
      channel.send.mockResolvedValue({ id: "sent-1", edit: vi.fn() });
      const unit = new DiscordMessageUnit(channel, replyTo, false);
      // Create content just over limit with a space near the boundary
      const prefix = "word ".repeat(399); // ~1995 chars
      const suffix = "x".repeat(100); // push over 2000
      unit.append(prefix + suffix);
      const result = await unit.flush();
      expect(result).toBe("split");
      // Overflow should exist
      expect(unit.overflow.length).toBeGreaterThan(0);
    });
  });
});

describe("DiscordMessageStream", () => {
  let channel: any;
  let replyTo: any;

  beforeEach(() => {
    vi.useFakeTimers();
    streams.clear();
    eventBusStreams.clear();
    channel = createMockChannel();
    replyTo = createMockMessage();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("should buffer appended content and flush on interval", async () => {
    const sentMsg = { id: "sent-1", edit: vi.fn().mockResolvedValue(undefined) };
    replyTo.reply.mockResolvedValue(sentMsg);

    const stream = new DiscordMessageStream(channel, replyTo);
    stream.append("Hello World");

    // Trigger the interval (EDIT_INTERVAL_MS = 1000)
    await vi.advanceTimersByTimeAsync(1100);

    expect(replyTo.reply).toHaveBeenCalledWith("Hello World");

    await stream.finalize();
  });

  it("should handle multiple appends batched into one flush", async () => {
    const sentMsg = { id: "sent-1", edit: vi.fn().mockResolvedValue(undefined) };
    replyTo.reply.mockResolvedValue(sentMsg);

    const stream = new DiscordMessageStream(channel, replyTo);
    stream.append("Hello ");
    stream.append("World");

    await vi.advanceTimersByTimeAsync(1100);

    expect(replyTo.reply).toHaveBeenCalledWith("Hello World");

    await stream.finalize();
  });

  it("should ignore appends after finalization", async () => {
    const stream = new DiscordMessageStream(channel, replyTo);
    await stream.finalize();
    stream.append("ignored");
    // No assertion needed — just verify no error
  });

  it("should process remaining content on finalize", async () => {
    const sentMsg = { id: "sent-1", edit: vi.fn().mockResolvedValue(undefined) };
    replyTo.reply.mockResolvedValue(sentMsg);

    const stream = new DiscordMessageStream(channel, replyTo);
    stream.append("Final content");
    await stream.finalize();

    expect(replyTo.reply).toHaveBeenCalledWith("Final content");
  });

  it("should return null from getLastMessage before any send", async () => {
    const stream = new DiscordMessageStream(channel, replyTo);
    expect(stream.getLastMessage()).toBeNull();
    await stream.finalize();
  });
});

describe("handleChunk", () => {
  let channel: any;
  let replyTo: any;

  beforeEach(() => {
    vi.useFakeTimers();
    streams.clear();
    eventBusStreams.clear();
    channel = createMockChannel();
    replyTo = createMockMessage();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("should do nothing if no stream exists for the key", async () => {
    await handleChunk({ type: "text", content: "Hello" }, "nonexistent");
    // No error thrown
  });

  it("should append text content to the stream", async () => {
    const sentMsg = { id: "sent-1", edit: vi.fn().mockResolvedValue(undefined) };
    replyTo.reply.mockResolvedValue(sentMsg);

    const stream = new DiscordMessageStream(channel, replyTo);
    streams.set("key-1", stream);

    await handleChunk({ type: "text", content: "Hello" }, "key-1");

    // Verify content was appended by finalizing and checking the send
    await vi.advanceTimersByTimeAsync(1100);
    await stream.finalize();
    expect(replyTo.reply).toHaveBeenCalled();
    const callArg = replyTo.reply.mock.calls[0][0];
    expect(callArg).toContain("Hello");
  });

  it("should handle system compact_boundary messages with auto trigger", async () => {
    const stream = new DiscordMessageStream(channel, replyTo);
    streams.set("key-1", stream);

    await handleChunk(
      {
        type: "system",
        content: "",
        subtype: "compact_boundary",
        metadata: { trigger: "auto", pre_tokens: 50000 },
      } as any,
      "key-1",
    );

    // Should have appended a compaction notification
    replyTo.reply.mockResolvedValue({ id: "sent-1", edit: vi.fn() });
    await vi.advanceTimersByTimeAsync(1100);
    await stream.finalize();
    const callArg = replyTo.reply.mock.calls[0]?.[0] ?? "";
    expect(callArg).toContain("Auto-Compaction");
  });

  it("should skip non-text message types", async () => {
    const stream = new DiscordMessageStream(channel, replyTo);
    streams.set("key-1", stream);

    await handleChunk({ type: "tool_use" as any, content: "some tool" }, "key-1");

    await stream.finalize();
    // reply should not be called (empty content)
    expect(replyTo.reply).not.toHaveBeenCalled();
  });

  it("should extract text from assistant-type messages", async () => {
    const sentMsg = { id: "sent-1", edit: vi.fn().mockResolvedValue(undefined) };
    replyTo.reply.mockResolvedValue(sentMsg);

    const stream = new DiscordMessageStream(channel, replyTo);
    streams.set("key-1", stream);

    await handleChunk(
      {
        type: "assistant" as any,
        content: "",
        message: { content: [{ text: "AI says" }] },
      } as any,
      "key-1",
    );

    await vi.advanceTimersByTimeAsync(1100);
    await stream.finalize();
    const callArg = replyTo.reply.mock.calls[0]?.[0];
    expect(callArg).toContain("AI says");
  });
});
