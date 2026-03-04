import { describe, it, expect, vi, beforeEach } from "vitest";

const mockStreams = vi.hoisted(() => new Map());
const MockDiscordMessageStream = vi.hoisted(() => {
  const ctor = vi.fn().mockImplementation(function (this: unknown) {
    return (ctor as any)._mockInstance;
  });
  (ctor as any)._mockInstance = { finalize: vi.fn(), append: vi.fn() };
  return ctor;
});

vi.mock("../src/message-streaming.js", () => ({
  streams: mockStreams,
  handleChunk: vi.fn(),
  DiscordMessageStream: MockDiscordMessageStream,
  eventBusStreams: new Map(),
}));

vi.mock("../src/logger.js", () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
  },
}));
vi.mock("../src/reaction-manager.js", () => ({
  setMessageReaction: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../src/typing-manager.js", () => ({
  startTyping: vi.fn().mockResolvedValue(undefined),
  stopTyping: vi.fn(),
  tickTyping: vi.fn(),
}));
vi.mock("../src/attachments.js", () => ({ saveAttachments: vi.fn().mockResolvedValue([]) }));
vi.mock("../src/channel-provider.js", () => ({
  discordChannelProvider: {},
  handleRegisteredCommand: vi.fn().mockResolvedValue(false),
  handleRegisteredParsers: vi.fn().mockResolvedValue(false),
}));
vi.mock("../src/pairing.js", () => ({
  buildPairingMessage: vi.fn(),
  createPairingRequest: vi.fn(),
  hasOwner: vi.fn().mockReturnValue(true),
}));
vi.mock("../src/discord-utils.js", () => ({
  getSessionKey: vi.fn().mockReturnValue("discord:test"),
  resolveMentions: vi.fn().mockReturnValue("hello"),
}));
vi.mock("../src/identity-manager.js", () => ({
  REACTION_ACTIVE: "active",
  REACTION_CANCELLED: "cancelled",
  REACTION_DONE: "done",
  REACTION_ERROR: "error",
}));

import { executeInjectInternal } from "../src/event-handlers.js";
import { DiscordMessageStream } from "../src/message-streaming.js";
import { logger } from "../src/logger.js";

describe("executeInjectInternal stream cleanup", () => {
  const mockChannel = { id: "ch1", name: "test" };
  const mockReplyMessage = {
    id: "msg1",
    channel: mockChannel,
    mentions: { users: { has: vi.fn().mockReturnValue(false) } },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockStreams.clear();
  });

  function makeStreamMock(finalizeResult: "resolve" | "reject") {
    const mockStream = {
      finalize: finalizeResult === "reject"
        ? vi.fn().mockRejectedValue(new Error("finalize failed"))
        : vi.fn().mockResolvedValue(undefined),
      append: vi.fn(),
    };
    (MockDiscordMessageStream as any)._mockInstance = mockStream;
    return mockStream;
  }

  it("should delete stream even when finalize() throws during cancel path", async () => {
    makeStreamMock("reject");

    const cancelToken = { cancelled: false };
    const mockCtx = {
      inject: vi.fn().mockRejectedValue(new Error("cancelled")),
      getConfig: vi.fn().mockReturnValue({}),
      logMessage: vi.fn(),
    };
    const mockQueueManager = {
      getSessionState: vi.fn().mockReturnValue({ messageCount: 0, thinkingLevel: "medium" }),
      clearBuffer: vi.fn(),
    };

    await executeInjectInternal(
      {
        sessionKey: "discord:test",
        messageContent: "hello",
        authorDisplayName: "user",
        replyToMessage: mockReplyMessage as any,
        isBot: false,
        queuedAt: Date.now(),
      },
      cancelToken,
      mockCtx as any,
      mockQueueManager as any,
    );

    expect(mockStreams.has("msg1")).toBe(false);
    expect(logger.debug).toHaveBeenCalledWith(
      expect.stringContaining("Stream cleanup error"),
      expect.objectContaining({ error: expect.anything() }),
    );
  });

  it("should delete stream even when finalize() throws during error path", async () => {
    makeStreamMock("reject");

    const cancelToken = { cancelled: false };
    const mockCtx = {
      inject: vi.fn().mockRejectedValue(new Error("something broke")),
      getConfig: vi.fn().mockReturnValue({}),
      logMessage: vi.fn(),
    };
    const mockQueueManager = {
      getSessionState: vi.fn().mockReturnValue({ messageCount: 0, thinkingLevel: "medium" }),
      clearBuffer: vi.fn(),
    };

    await executeInjectInternal(
      {
        sessionKey: "discord:test",
        messageContent: "hello",
        authorDisplayName: "user",
        replyToMessage: mockReplyMessage as any,
        isBot: false,
        queuedAt: Date.now(),
      },
      cancelToken,
      mockCtx as any,
      mockQueueManager as any,
    );

    expect(mockStreams.has("msg1")).toBe(false);
    expect(logger.debug).toHaveBeenCalledWith(
      expect.stringContaining("Stream cleanup error"),
      expect.objectContaining({ error: expect.anything() }),
    );
  });
});
