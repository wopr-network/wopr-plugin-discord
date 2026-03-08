import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock all external dependencies
vi.mock("./logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("./attachments.js", () => ({
  saveAttachments: vi.fn().mockResolvedValue([]),
}));

vi.mock("./channel-provider.js", () => ({
  discordChannelProvider: { send: vi.fn().mockResolvedValue(undefined) },
  handleRegisteredCommand: vi.fn().mockResolvedValue(false),
  handleRegisteredParsers: vi.fn().mockResolvedValue(false),
}));

vi.mock("./discord-utils.js", () => ({
  getSessionKey: vi.fn(() => "discord:test-guild:#general"),
  getSessionKeyFromInteraction: vi.fn(() => "discord:test-guild:#general"),
  resolveMentions: vi.fn((msg: any) => msg.content),
}));

vi.mock("./identity-manager.js", () => ({
  REACTION_ACTIVE: vi.fn(() => "active-emoji"),
  REACTION_CANCELLED: vi.fn(() => "cancelled-emoji"),
  REACTION_DONE: vi.fn(() => "done-emoji"),
  REACTION_ERROR: vi.fn(() => "error-emoji"),
  REACTION_QUEUED: vi.fn(() => "queued-emoji"),
}));

vi.mock("./reaction-manager.js", () => ({
  setMessageReaction: vi.fn().mockResolvedValue(undefined),
  clearMessageReactions: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./typing-manager.js", () => ({
  startTyping: vi.fn().mockResolvedValue(undefined),
  stopTyping: vi.fn(),
  tickTyping: vi.fn(),
}));

vi.mock("./pairing.js", () => ({
  hasOwner: vi.fn().mockReturnValue(true),
  createPairingRequest: vi.fn().mockReturnValue("ABCD2345"),
  buildPairingMessage: vi.fn().mockReturnValue("Pairing message"),
}));

const { mockStreams, mockEventBusStreams } = vi.hoisted(() => {
  const mockStreams = new Map();
  const mockEventBusStreams = new Map();
  return { mockStreams, mockEventBusStreams };
});

vi.mock("./message-streaming.js", () => {
  class MockDiscordMessageStream {
    append = vi.fn();
    finalize = vi.fn().mockResolvedValue(undefined);
    getLastMessage = vi.fn().mockReturnValue(null);
  }
  return {
    DiscordMessageStream: MockDiscordMessageStream,
    streams: mockStreams,
    eventBusStreams: mockEventBusStreams,
    handleChunk: vi.fn().mockResolvedValue(undefined),
    DISCORD_LIMIT: 2000,
  };
});

import { createMockClient, createMockContext, createMockMessage } from "./__test-utils__/mocks.js";
import { handleRegisteredCommand, handleRegisteredParsers } from "./channel-provider.js";
import { ChannelQueueManager } from "./channel-queue.js";
import {
  executeInjectInternal,
  findChannelIdFromSession,
  handleMessage,
  handleTypingStart,
  subscribeSessionCreateEvent,
  subscribeSessionEvents,
  subscribeStreamEvents,
} from "./event-handlers.js";
import { logger } from "./logger.js";
import { hasOwner } from "./pairing.js";
import { RateLimiter } from "./rate-limiter.js";
import { setMessageReaction } from "./reaction-manager.js";
import { startTyping, stopTyping } from "./typing-manager.js";

describe("executeInjectInternal", () => {
  let ctx: any;
  let queueManager: ChannelQueueManager;

  beforeEach(() => {
    mockStreams.clear();
    mockEventBusStreams.clear();
    ctx = createMockContext();
    queueManager = new ChannelQueueManager(vi.fn().mockResolvedValue(undefined));
  });

  afterEach(() => {
    queueManager?.stopProcessing();
  });

  it("should set active reaction, start typing, inject, finalize, and set done reaction", async () => {
    const message = createMockMessage();
    const cancelToken = { cancelled: false };

    await executeInjectInternal(
      {
        sessionKey: "discord:test:#general",
        messageContent: "Hello AI",
        authorDisplayName: "testuser",
        replyToMessage: message,
        isBot: false,
        queuedAt: Date.now(),
      },
      cancelToken,
      ctx,
      queueManager,
    );

    expect(setMessageReaction).toHaveBeenCalledWith(message, expect.any(Function)); // REACTION_ACTIVE
    expect(startTyping).toHaveBeenCalled();
    expect(ctx.inject).toHaveBeenCalledWith(
      "discord:test:#general",
      "Hello AI",
      expect.objectContaining({ from: "testuser" }),
    );
    expect(stopTyping).toHaveBeenCalled();
  });

  it("should skip execution if cancelToken.cancelled is true before start", async () => {
    const message = createMockMessage();
    const cancelToken = { cancelled: true };

    await executeInjectInternal(
      {
        sessionKey: "discord:test:#general",
        messageContent: "Hello",
        authorDisplayName: "testuser",
        replyToMessage: message,
        isBot: false,
        queuedAt: Date.now(),
      },
      cancelToken,
      ctx,
      queueManager,
    );

    expect(ctx.inject).not.toHaveBeenCalled();
    expect(setMessageReaction).toHaveBeenCalledWith(message, expect.any(Function)); // REACTION_CANCELLED
  });

  it("should set error reaction on inject failure", async () => {
    ctx.inject.mockRejectedValueOnce(new Error("API error"));
    const message = createMockMessage();
    const cancelToken = { cancelled: false };

    await executeInjectInternal(
      {
        sessionKey: "discord:test:#general",
        messageContent: "Hello",
        authorDisplayName: "testuser",
        replyToMessage: message,
        isBot: false,
        queuedAt: Date.now(),
      },
      cancelToken,
      ctx,
      queueManager,
    );

    expect(stopTyping).toHaveBeenCalled();
    // Should have set error reaction (last setMessageReaction call)
    const lastCall = (setMessageReaction as any).mock.calls;
    const lastReaction = lastCall[lastCall.length - 1][1];
    expect(typeof lastReaction).toBe("function");
  });

  it("should set cancelled reaction when inject throws cancelled error", async () => {
    ctx.inject.mockRejectedValueOnce(new Error("Operation cancelled"));
    const message = createMockMessage();
    const cancelToken = { cancelled: false };

    await executeInjectInternal(
      {
        sessionKey: "discord:test:#general",
        messageContent: "Hello",
        authorDisplayName: "testuser",
        replyToMessage: message,
        isBot: false,
        queuedAt: Date.now(),
      },
      cancelToken,
      ctx,
      queueManager,
    );

    expect(stopTyping).toHaveBeenCalled();
    // The error string contains "cancelled" so it should call REACTION_CANCELLED
    const allCalls = (setMessageReaction as any).mock.calls;
    expect(allCalls.length).toBeGreaterThanOrEqual(2);
  });

  it("should prepend thinking level when not medium", async () => {
    const message = createMockMessage();
    const cancelToken = { cancelled: false };
    const state = queueManager.getSessionState("discord:test:#general");
    state.thinkingLevel = "high";

    await executeInjectInternal(
      {
        sessionKey: "discord:test:#general",
        messageContent: "Hello",
        authorDisplayName: "testuser",
        replyToMessage: message,
        isBot: false,
        queuedAt: Date.now(),
      },
      cancelToken,
      ctx,
      queueManager,
    );

    expect(ctx.inject).toHaveBeenCalledWith(
      "discord:test:#general",
      "[Thinking level: high] Hello",
      expect.any(Object),
    );
  });
});

describe("handleMessage", () => {
  let client: any;
  let ctx: any;
  let queueManager: ChannelQueueManager;

  beforeEach(() => {
    // Reset individual mocks
    (handleRegisteredParsers as any).mockReset();
    (handleRegisteredParsers as any).mockResolvedValue(false);
    (handleRegisteredCommand as any).mockReset();
    (handleRegisteredCommand as any).mockResolvedValue(false);
    (hasOwner as any).mockReset();
    (hasOwner as any).mockReturnValue(true);
    client = createMockClient();
    ctx = createMockContext();
  });

  afterEach(() => {
    queueManager?.stopProcessing();
  });

  it("should ignore messages from the bot itself", async () => {
    queueManager = new ChannelQueueManager(vi.fn().mockResolvedValue(undefined));
    const message = createMockMessage({ authorId: "bot-1" }); // same as client.user.id
    await handleMessage(message, client, ctx, queueManager);
    expect(ctx.logMessage).not.toHaveBeenCalled();
  });

  it("should return early if client.user is null", async () => {
    queueManager = new ChannelQueueManager(vi.fn().mockResolvedValue(undefined));
    client.user = null;
    const message = createMockMessage();
    await handleMessage(message, client, ctx, queueManager);
    expect(ctx.logMessage).not.toHaveBeenCalled();
  });

  it("should return early if registered parser handles the message", async () => {
    queueManager = new ChannelQueueManager(vi.fn().mockResolvedValue(undefined));
    (handleRegisteredParsers as any).mockResolvedValueOnce(true);
    const message = createMockMessage({ authorId: "user-2" });
    await handleMessage(message, client, ctx, queueManager);
    expect(ctx.logMessage).not.toHaveBeenCalled();
  });

  it("should return early for interaction-based messages", async () => {
    queueManager = new ChannelQueueManager(vi.fn().mockResolvedValue(undefined));
    const message = createMockMessage({ authorId: "user-2" });
    message.interaction = { id: "int-1" };
    await handleMessage(message, client, ctx, queueManager);
    expect(ctx.logMessage).not.toHaveBeenCalled();
  });

  it("should log the message and buffer for non-mention guild messages", async () => {
    queueManager = new ChannelQueueManager(vi.fn().mockResolvedValue(undefined));
    const message = createMockMessage({ authorId: "user-2" });
    await handleMessage(message, client, ctx, queueManager);
    expect(ctx.logMessage).toHaveBeenCalled();
  });

  it("should queue inject for @mention messages from humans", async () => {
    queueManager = new ChannelQueueManager(vi.fn().mockResolvedValue(undefined));
    const message = createMockMessage({
      authorId: "user-2",
      mentionedUserIds: ["bot-1"], // mentions the bot
      content: "@WOPR hello",
    });
    const queueInjectSpy = vi.spyOn(queueManager, "queueInject");
    await handleMessage(message, client, ctx, queueManager);
    expect(queueInjectSpy).toHaveBeenCalled();
  });

  it("should handle DM messages and queue inject for owner", async () => {
    queueManager = new ChannelQueueManager(vi.fn().mockResolvedValue(undefined));
    const message = createMockMessage({
      authorId: "user-2",
      channelType: 1,
      content: "Hello in DM",
    });
    message.channel.type = 1;
    message.channel.isDMBased = () => true;
    const queueInjectSpy = vi.spyOn(queueManager, "queueInject");
    await handleMessage(message, client, ctx, queueManager);
    expect(queueInjectSpy).toHaveBeenCalled();
  });

  it("should generate pairing code for DM when no owner exists", async () => {
    queueManager = new ChannelQueueManager(vi.fn().mockResolvedValue(undefined));
    (hasOwner as any).mockReturnValueOnce(false);
    const message = createMockMessage({
      authorId: "user-2",
      channelType: 1,
    });
    message.channel.type = 1;
    await handleMessage(message, client, ctx, queueManager);
    expect(message.reply).toHaveBeenCalledWith("Pairing message");
  });

  it("should ignore bot messages that are not @mentions", async () => {
    queueManager = new ChannelQueueManager(vi.fn().mockResolvedValue(undefined));
    const message = createMockMessage({
      authorId: "other-bot",
      authorBot: true,
      content: "Bot message without mention",
    });
    message.author.bot = true;
    await handleMessage(message, client, ctx, queueManager);
    // Should log but NOT queue inject
    expect(ctx.logMessage).toHaveBeenCalled();
  });

  it("should queue inject for bot @mention with content", async () => {
    queueManager = new ChannelQueueManager(vi.fn().mockResolvedValue(undefined));
    const message = createMockMessage({
      authorId: "other-bot",
      authorBot: true,
      mentionedUserIds: ["bot-1"],
      content: "@WOPR help me",
    });
    message.author.bot = true;
    const queueInjectSpy = vi.spyOn(queueManager, "queueInject");
    await handleMessage(message, client, ctx, queueManager);
    expect(queueInjectSpy).toHaveBeenCalled();
  });

  it("should drop inject and DM user when rate-limited", async () => {
    const rateLimiter = new RateLimiter({ maxRequests: 1, windowMs: 60000 });
    queueManager = new ChannelQueueManager(vi.fn().mockResolvedValue(undefined));
    const queueInjectSpy = vi.spyOn(queueManager, "queueInject");

    // First message — should go through
    const msg1 = createMockMessage({
      authorId: "user-2",
      mentionedUserIds: ["bot-1"],
      content: "@WOPR hello",
    });
    await handleMessage(msg1, client, ctx, queueManager, rateLimiter);
    expect(queueInjectSpy).toHaveBeenCalledTimes(1);

    // Second message — should be rate-limited
    const msg2 = createMockMessage({
      authorId: "user-2",
      mentionedUserIds: ["bot-1"],
      content: "@WOPR hello again",
    });
    await handleMessage(msg2, client, ctx, queueManager, rateLimiter);
    expect(queueInjectSpy).toHaveBeenCalledTimes(1); // NOT called again
    // Rate limit notice sent as DM (not channel reply) to avoid channel noise
    expect(msg2.author.send).toHaveBeenCalledWith(expect.stringContaining("rate limit"));
    expect(msg2.reply).not.toHaveBeenCalled();
  });

  it("should not fetch attachments for rate-limited users", async () => {
    const { saveAttachments } = await import("./attachments.js");
    const saveAttachmentsMock = vi.mocked(saveAttachments);
    saveAttachmentsMock.mockClear();

    const rateLimiter = new RateLimiter({ maxRequests: 1, windowMs: 60000 });
    queueManager = new ChannelQueueManager(vi.fn().mockResolvedValue(undefined));

    // Exhaust the limit
    const msg1 = createMockMessage({ authorId: "user-3", mentionedUserIds: ["bot-1"], content: "@WOPR first" });
    await handleMessage(msg1, client, ctx, queueManager, rateLimiter);

    // Rate-limited message with attachments — attachments must NOT be fetched
    const msg2 = createMockMessage({ authorId: "user-3", mentionedUserIds: ["bot-1"], content: "@WOPR second" });
    msg2.attachments = new Map([["att-1", { url: "https://cdn.discord.com/file.txt", name: "file.txt" }]]);
    await handleMessage(msg2, client, ctx, queueManager, rateLimiter);
    expect(saveAttachmentsMock).not.toHaveBeenCalled();
  });

  it("should not rate-limit bot messages", async () => {
    const rateLimiter = new RateLimiter({ maxRequests: 1, windowMs: 60000 });
    queueManager = new ChannelQueueManager(vi.fn().mockResolvedValue(undefined));
    const queueInjectSpy = vi.spyOn(queueManager, "queueInject");

    // First bot message
    const msg1 = createMockMessage({
      authorId: "other-bot",
      authorBot: true,
      mentionedUserIds: ["bot-1"],
      content: "@WOPR help",
    });
    msg1.author.bot = true;
    await handleMessage(msg1, client, ctx, queueManager, rateLimiter);

    // Second bot message — should still go through (bots not rate-limited)
    const msg2 = createMockMessage({
      authorId: "other-bot",
      authorBot: true,
      mentionedUserIds: ["bot-1"],
      content: "@WOPR help again",
    });
    msg2.author.bot = true;
    await handleMessage(msg2, client, ctx, queueManager, rateLimiter);
    expect(queueInjectSpy).toHaveBeenCalledTimes(2);
  });

  it("should work without rate limiter (backwards compatible)", async () => {
    queueManager = new ChannelQueueManager(vi.fn().mockResolvedValue(undefined));
    const queueInjectSpy = vi.spyOn(queueManager, "queueInject");
    const message = createMockMessage({
      authorId: "user-2",
      mentionedUserIds: ["bot-1"],
      content: "@WOPR hello",
    });
    // No rateLimiter passed — should work as before
    await handleMessage(message, client, ctx, queueManager);
    expect(queueInjectSpy).toHaveBeenCalled();
  });
});

describe("handleTypingStart", () => {
  it("should set human typing for non-bot users", () => {
    const queueManager = new ChannelQueueManager(vi.fn().mockResolvedValue(undefined));
    const setHumanTypingSpy = vi.spyOn(queueManager, "setHumanTyping");
    const typing = {
      user: { bot: false },
      channel: { id: "ch-1" },
    };
    handleTypingStart(typing, createMockClient(), queueManager);
    expect(setHumanTypingSpy).toHaveBeenCalledWith("ch-1");
    queueManager.stopProcessing();
  });

  it("should ignore typing from bots", () => {
    const queueManager = new ChannelQueueManager(vi.fn().mockResolvedValue(undefined));
    const setHumanTypingSpy = vi.spyOn(queueManager, "setHumanTyping");
    const typing = {
      user: { bot: true },
      channel: { id: "ch-1" },
    };
    handleTypingStart(typing, createMockClient(), queueManager);
    expect(setHumanTypingSpy).not.toHaveBeenCalled();
    queueManager.stopProcessing();
  });
});

describe("subscribeSessionEvents", () => {
  it("should subscribe to session:beforeInject and session:afterInject", () => {
    const ctx = createMockContext();
    const client = createMockClient();
    subscribeSessionEvents(ctx, client);
    expect(ctx.events.on).toHaveBeenCalledWith("session:beforeInject", expect.any(Function));
    expect(ctx.events.on).toHaveBeenCalledWith("session:afterInject", expect.any(Function));
  });

  it("should do nothing if ctx.events is null", () => {
    const ctx = createMockContext();
    ctx.events = null as any;
    const client = createMockClient();
    subscribeSessionEvents(ctx, client);
    // No error thrown
  });
});

describe("subscribeStreamEvents", () => {
  it("should subscribe to stream event if ctx.on is available", () => {
    const ctx = createMockContext();
    (ctx as any).on = vi.fn();
    subscribeStreamEvents(ctx);
    expect((ctx as any).on).toHaveBeenCalledWith("stream", expect.any(Function));
  });

  it("should do nothing if ctx.on is not a function", () => {
    const ctx = createMockContext();
    subscribeStreamEvents(ctx);
    // No error thrown
  });
});

describe("subscribeSessionCreateEvent", () => {
  it("should subscribe to session:create event", () => {
    const ctx = createMockContext();
    const client = createMockClient();
    subscribeSessionCreateEvent(ctx, client);
    expect(ctx.events.on).toHaveBeenCalledWith("session:create", expect.any(Function));
  });

  it("should do nothing if ctx.events is null", () => {
    const ctx = createMockContext();
    ctx.events = null as any;
    const client = createMockClient();
    subscribeSessionCreateEvent(ctx, client);
    // No error thrown
  });
});

describe("findChannelIdFromSession", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should return channel ID from most recent discord entry", async () => {
    const ctx = createMockContext();
    (ctx as any).session.readConversationLog = vi.fn().mockResolvedValue([
      { ts: 1000, from: "user", content: "old", type: "message", channel: { id: "ch-old", type: "discord" } },
      { ts: 2000, from: "user", content: "new", type: "message", channel: { id: "ch-new", type: "discord" } },
    ]);
    const result = await findChannelIdFromSession(ctx, "discord:test:#general");
    expect(result).toBe("ch-new");
  });

  it("should return null when no discord channel entries exist", async () => {
    const ctx = createMockContext();
    (ctx as any).session.readConversationLog = vi
      .fn()
      .mockResolvedValue([{ ts: 1000, from: "user", content: "msg", type: "message" }]);
    const result = await findChannelIdFromSession(ctx, "discord:test:#general");
    expect(result).toBeNull();
  });

  it("should return null when session has no messages", async () => {
    const ctx = createMockContext();
    (ctx as any).session.readConversationLog = vi.fn().mockResolvedValue([]);
    const result = await findChannelIdFromSession(ctx, "discord:test:#general");
    expect(result).toBeNull();
  });

  it("should return null and log warning when ctx.session is unavailable", async () => {
    const ctx = createMockContext();
    (ctx as any).session = undefined;
    const result = await findChannelIdFromSession(ctx, "discord:test:#general");
    expect(result).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ sessionName: "discord:test:#general" }));
  });

  it("should return null and log error when readConversationLog throws", async () => {
    const ctx = createMockContext();
    (ctx as any).session.readConversationLog = vi.fn().mockRejectedValue(new Error("DB error"));
    const result = await findChannelIdFromSession(ctx, "discord:test:#general");
    expect(result).toBeNull();
    expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ sessionName: "discord:test:#general" }));
  });

  it("should return null for session name containing path traversal (../)", async () => {
    const ctx = createMockContext();
    (ctx as any).session.readConversationLog = vi
      .fn()
      .mockResolvedValue([{ channel: { id: "ch-1", type: "discord" } }]);
    const result = await findChannelIdFromSession(ctx, "../../etc/passwd");
    expect(result).toBeNull();
    expect((ctx as any).session.readConversationLog).not.toHaveBeenCalled();
  });

  it("should return null for session name containing backslash", async () => {
    const ctx = createMockContext();
    (ctx as any).session.readConversationLog = vi.fn().mockResolvedValue([]);
    const result = await findChannelIdFromSession(ctx, "test\\..\\secret");
    expect(result).toBeNull();
    expect((ctx as any).session.readConversationLog).not.toHaveBeenCalled();
  });

  it("should return null for session name containing null byte", async () => {
    const ctx = createMockContext();
    (ctx as any).session.readConversationLog = vi.fn().mockResolvedValue([]);
    const result = await findChannelIdFromSession(ctx, "test\x00evil");
    expect(result).toBeNull();
    expect((ctx as any).session.readConversationLog).not.toHaveBeenCalled();
  });

  it("should allow valid session keys with colons and hashes", async () => {
    const ctx = createMockContext();
    (ctx as any).session.readConversationLog = vi
      .fn()
      .mockResolvedValue([{ channel: { id: "ch-valid", type: "discord" } }]);
    const result = await findChannelIdFromSession(ctx, "discord:my-guild:#general");
    expect(result).toBe("ch-valid");
    expect((ctx as any).session.readConversationLog).toHaveBeenCalledWith("discord:my-guild:#general");
  });

  it("should allow valid thread session keys containing '/'", async () => {
    const ctx = createMockContext();
    (ctx as any).session.readConversationLog = vi
      .fn()
      .mockResolvedValue([{ channel: { id: "ch-thread", type: "discord" } }]);
    const result = await findChannelIdFromSession(ctx, "discord:my-guild:#general/my-thread");
    expect(result).toBe("ch-thread");
    expect((ctx as any).session.readConversationLog).toHaveBeenCalledWith("discord:my-guild:#general/my-thread");
  });
});
