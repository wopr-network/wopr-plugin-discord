import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createMockContext } from "./mocks/wopr-context.js";
import { createMockClient } from "./mocks/discord-client.js";

const mockClient = createMockClient();

vi.mock("discord.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("discord.js")>();
  return {
    ...actual,
    Client: vi.fn(() => mockClient),
  };
});

vi.mock("../src/identity-manager.js", () => ({
  refreshIdentity: vi.fn().mockResolvedValue(undefined),
  REACTION_ACTIVE: "zap",
  REACTION_CANCELLED: "stop",
  REACTION_DONE: "check",
  REACTION_ERROR: "x",
}));
vi.mock("../src/channel-provider.js", () => ({
  discordChannelProvider: {},
  getRegisteredCommand: vi.fn(),
  setChannelProviderClient: vi.fn(),
}));
vi.mock("../src/reaction-manager.js", () => ({
  setReactionClient: vi.fn(),
}));
vi.mock("../src/event-handlers.js", () => ({
  executeInjectInternal: vi.fn().mockResolvedValue(undefined),
  handleMessage: vi.fn().mockResolvedValue(undefined),
  handleTypingStart: vi.fn(),
  subscribeSessionEvents: vi.fn(() => vi.fn()),
  subscribeStreamEvents: vi.fn(() => vi.fn()),
  subscribeSessionCreateEvent: vi.fn(() => vi.fn()),
}));
vi.mock("../src/slash-commands.js", () => {
  const SlashCommandHandler = vi.fn(function (this: any) {
    this.handle = vi.fn();
    this.handleAutocomplete = vi.fn();
  });
  return {
    registerSlashCommands: vi.fn().mockResolvedValue(undefined),
    SlashCommandHandler,
  };
});
vi.mock("../src/pairing.js", () => ({
  cleanupExpiredPairings: vi.fn(),
  hasOwner: vi.fn().mockReturnValue(false),
  buildPairingMessage: vi.fn(),
  createPairingRequest: vi.fn(),
}));
vi.mock("../src/friend-buttons.js", () => ({
  cleanupExpiredButtonRequests: vi.fn(),
  getPendingButtonRequest: vi.fn(),
  handleFriendButtonInteraction: vi.fn(),
  isFriendRequestButton: vi.fn().mockReturnValue(false),
}));
vi.mock("../src/discord-extension.js", () => ({
  createDiscordExtension: vi.fn(() => ({
    claimOwnership: vi.fn(),
  })),
}));
vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("../src/channel-queue.js", () => {
  const ChannelQueueManager = vi.fn(function (this: any) {
    this.startProcessing = vi.fn();
    this.stopProcessing = vi.fn();
    this.enqueue = vi.fn();
  });
  return { ChannelQueueManager };
});

import plugin from "../src/index.js";
import { setReactionClient } from "../src/reaction-manager.js";
import { setChannelProviderClient } from "../src/channel-provider.js";
import { subscribeSessionEvents, subscribeStreamEvents } from "../src/event-handlers.js";

describe("plugin lifecycle", () => {
  beforeEach(async () => {
    const { Client } = await import("discord.js");
    vi.mocked(Client as any).mockImplementation(function () { return mockClient; });
  });

  afterEach(async () => {
    await plugin.shutdown();
    vi.clearAllMocks();
  });

  it("exports init and shutdown functions", () => {
    expect(typeof plugin.init).toBe("function");
    expect(typeof plugin.shutdown).toBe("function");
  });

  it("init() creates client and subscribes Discord events", async () => {
    const ctx = createMockContext({
      getConfig: vi.fn().mockReturnValue({ token: "test-token", clientId: "app-123", guildId: "guild-123" }),
    });

    await plugin.init(ctx);

    const { Client } = await import("discord.js");
    expect(Client).toHaveBeenCalledOnce();

    expect(mockClient.on).toHaveBeenCalled();
    const eventNames = mockClient.on.mock.calls.map((c: any) => c[0]);
    expect(eventNames).toContain("messageCreate");
    expect(eventNames).toContain("interactionCreate");

    expect(subscribeSessionEvents).toHaveBeenCalledWith(ctx, mockClient);
    expect(subscribeStreamEvents).toHaveBeenCalledWith(ctx);

    expect(mockClient.login).toHaveBeenCalledWith("test-token");
    expect(setChannelProviderClient).toHaveBeenCalledWith(mockClient);
    expect(setReactionClient).toHaveBeenCalledWith(mockClient);

    expect(ctx.registerConfigSchema).toHaveBeenCalledWith("wopr-plugin-discord", expect.any(Object));
    expect(ctx.registerChannelProvider).toHaveBeenCalled();
    expect(ctx.registerExtension).toHaveBeenCalledWith("discord", expect.any(Object));
  });

  it("init() with no token returns early without creating client", async () => {
    const ctx = createMockContext({
      getConfig: vi.fn().mockReturnValue({}),
      getMainConfig: vi.fn().mockReturnValue({}),
    });

    await plugin.init(ctx);

    const { Client } = await import("discord.js");
    expect(Client).not.toHaveBeenCalled();
    expect(mockClient.login).not.toHaveBeenCalled();
  });

  it("init() with invalid token propagates login error", async () => {
    const ctx = createMockContext({
      getConfig: vi.fn().mockReturnValue({ token: "bad-token" }),
    });

    mockClient.login.mockRejectedValueOnce(new Error("Invalid token"));

    await expect(plugin.init(ctx)).rejects.toThrow("Invalid token");
  });

  it("shutdown() calls cleanups and disconnects client", async () => {
    const ctx = createMockContext({
      getConfig: vi.fn().mockReturnValue({ token: "test-token" }),
    });

    const cleanupSession = vi.fn();
    const cleanupStream = vi.fn();
    vi.mocked(subscribeSessionEvents).mockReturnValue(cleanupSession);
    vi.mocked(subscribeStreamEvents).mockReturnValue(cleanupStream);

    await plugin.init(ctx);
    await plugin.shutdown();

    expect(cleanupSession).toHaveBeenCalledOnce();
    expect(cleanupStream).toHaveBeenCalledOnce();
    expect(mockClient.destroy).toHaveBeenCalled();
    expect(setReactionClient).toHaveBeenCalledWith(null);
    expect(setChannelProviderClient).toHaveBeenCalledWith(null);
    expect(ctx.unregisterChannelProvider).toHaveBeenCalledWith("discord");
    expect(ctx.unregisterExtension).toHaveBeenCalledWith("discord");
  });

  it("double init() calls login twice", async () => {
    const ctx = createMockContext({
      getConfig: vi.fn().mockReturnValue({ token: "test-token" }),
    });

    await plugin.init(ctx);
    const firstLoginCalls = mockClient.login.mock.calls.length;

    await plugin.init(ctx);
    expect(mockClient.login).toHaveBeenCalledTimes(firstLoginCalls + 1);
  });

  it("shutdown() before init() does not throw", async () => {
    await expect(plugin.shutdown()).resolves.toBeUndefined();
  });

  it("init() falls back to mainConfig for token", async () => {
    const ctx = createMockContext({
      getConfig: vi.fn().mockReturnValue({}),
      getMainConfig: vi.fn().mockReturnValue({ token: "main-config-token", clientId: "main-app-id" }),
    });

    await plugin.init(ctx);

    expect(mockClient.login).toHaveBeenCalledWith("main-config-token");
  });
});
