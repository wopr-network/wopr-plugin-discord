import { describe, it, expect, vi, beforeEach } from "vitest";

const mockStreams = vi.hoisted(() => {
  const backing = new Map<string, unknown>();
  return {
    set: vi.fn((k: string, v: unknown) => backing.set(k, v)),
    delete: vi.fn((k: string) => backing.delete(k)),
    has: vi.fn((k: string) => backing.has(k)),
    clear: vi.fn(() => backing.clear()),
  } as any;
});
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
import { logger } from "../src/logger.js";
import { setMessageReaction } from "../src/reaction-manager.js";
import { stopTyping } from "../src/typing-manager.js";

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
    mockStreams.set.mockClear();
    mockStreams.delete.mockClear();
    mockStreams.has.mockClear();
  });

  function makeStreamMock(finalizeResult: "resolve" | "reject") {
    const mockStream = {
      finalize:
        finalizeResult === "reject"
          ? vi.fn().mockRejectedValue(new Error("finalize failed"))
          : vi.fn().mockResolvedValue(undefined),
      append: vi.fn(),
    };
    (MockDiscordMessageStream as any)._mockInstance = mockStream;
    return mockStream;
  }

  function makeItem() {
    return {
      sessionKey: "discord:test",
      messageContent: "hello",
      authorDisplayName: "user",
      replyToMessage: mockReplyMessage as any,
      isBot: false,
      queuedAt: Date.now(),
    };
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

    await executeInjectInternal(makeItem(), cancelToken, mockCtx as any, mockQueueManager as any);

    expect(mockStreams.set).toHaveBeenCalledWith("msg1", expect.anything());
    expect(mockStreams.has("msg1")).toBe(false);
    expect(logger.debug).toHaveBeenCalledWith(
      expect.stringContaining("Stream cleanup error"),
      expect.objectContaining({ error: expect.anything(), sessionKey: "discord:test" }),
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

    await executeInjectInternal(makeItem(), cancelToken, mockCtx as any, mockQueueManager as any);

    expect(mockStreams.set).toHaveBeenCalledWith("msg1", expect.anything());
    expect(mockStreams.has("msg1")).toBe(false);
    expect(logger.debug).toHaveBeenCalledWith(
      expect.stringContaining("Stream cleanup error"),
      expect.objectContaining({ error: expect.anything(), sessionKey: "discord:test" }),
    );
  });

  it("should delete stream and continue cleanup when finalize() throws during success path", async () => {
    makeStreamMock("reject");

    const cancelToken = { cancelled: false };
    const mockCtx = {
      inject: vi.fn().mockResolvedValue(undefined),
      getConfig: vi.fn().mockReturnValue({}),
      logMessage: vi.fn(),
    };
    const mockQueueManager = {
      getSessionState: vi.fn().mockReturnValue({ messageCount: 0, thinkingLevel: "medium" }),
      clearBuffer: vi.fn(),
    };

    await executeInjectInternal(makeItem(), cancelToken, mockCtx as any, mockQueueManager as any);

    expect(mockStreams.set).toHaveBeenCalledWith("msg1", expect.anything());
    expect(mockStreams.has("msg1")).toBe(false);
    expect(logger.debug).toHaveBeenCalledWith(
      expect.stringContaining("Stream cleanup error"),
      expect.objectContaining({ error: expect.anything(), sessionKey: "discord:test" }),
    );
    // Cleanup should continue: stopTyping and setMessageReaction(REACTION_DONE) must still run
    expect(stopTyping).toHaveBeenCalled();
    expect(setMessageReaction).toHaveBeenCalledWith(mockReplyMessage, "done");
  });
});
