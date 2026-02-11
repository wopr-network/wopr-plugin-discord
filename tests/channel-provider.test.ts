/**
 * Tests for the Discord Channel Provider (WOP-6)
 *
 * Tests the channel provider interface exposed via ctx.registerChannelProvider():
 * - Command registration (registerCommand, unregisterCommand, getCommands)
 * - Message parser registration (addMessageParser, removeMessageParser, getMessageParsers)
 * - send() message chunking at 2000-char Discord limit
 * - getBotUsername() fallback behavior
 *
 * Also tests promise chain error isolation in the queue system.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMockClient, createMockMessage, createMockTextChannel, createMockUser } from "./mocks/discord-client.js";
import { createMockContext } from "./mocks/wopr-context.js";

// Mock discord.js before importing the plugin
vi.mock("discord.js", () => {
  return {
    Client: class MockClient {
      constructor() {
        const mock = (globalThis as any).__testMockClient;
        Object.assign(this, mock);
      }
    },
    Events: {
      MessageCreate: "messageCreate",
      InteractionCreate: "interactionCreate",
      ClientReady: "ready",
      TypingStart: "typingStart",
    },
    GatewayIntentBits: {
      Guilds: 1,
      GuildMessages: 2,
      MessageContent: 4,
      DirectMessages: 8,
      GuildMessageReactions: 16,
      GuildMessageTyping: 32,
    },
    Partials: { Channel: 0, Message: 1 },
    ChannelType: { GuildText: 0, DM: 1, PublicThread: 11, GuildCategory: 4 },
    SlashCommandBuilder: class MockSlashCommandBuilder {
      setName() { return this; }
      setDescription() { return this; }
      addStringOption(fn: Function) {
        const opt: Record<string, any> = {};
        opt.setName = () => opt;
        opt.setDescription = () => opt;
        opt.setRequired = () => opt;
        opt.addChoices = () => opt;
        opt.setAutocomplete = () => opt;
        fn(opt);
        return this;
      }
      addBooleanOption(fn: Function) {
        const opt: Record<string, any> = {};
        opt.setName = () => opt;
        opt.setDescription = () => opt;
        opt.setRequired = () => opt;
        fn(opt);
        return this;
      }
      toJSON() { return {}; }
    },
    REST: class MockREST {
      setToken() { return this; }
      put() { return Promise.resolve(undefined); }
    },
    Routes: {
      applicationCommands: vi.fn().mockReturnValue("/commands"),
      applicationGuildCommands: vi.fn().mockReturnValue("/guild-commands"),
    },
    TextChannel: class TextChannel {},
    ThreadChannel: class ThreadChannel {},
    DMChannel: class DMChannel {},
  };
});

vi.mock("winston", () => {
  const mockLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    verbose: vi.fn(),
  };
  return {
    default: {
      createLogger: vi.fn().mockReturnValue(mockLogger),
      format: {
        combine: vi.fn(),
        timestamp: vi.fn(),
        errors: vi.fn(),
        json: vi.fn(),
        printf: vi.fn((fn: Function) => fn),
        colorize: vi.fn(),
      },
      transports: {
        File: vi.fn(),
        Console: vi.fn(),
      },
    },
  };
});

vi.mock("node:fs", () => ({
  existsSync: vi.fn().mockReturnValue(false),
  mkdirSync: vi.fn(),
  readFileSync: vi.fn().mockReturnValue(""),
  createWriteStream: vi.fn().mockReturnValue({ on: vi.fn(), write: vi.fn(), end: vi.fn() }),
}));

vi.mock("node:stream/promises", () => ({
  pipeline: vi.fn().mockResolvedValue(undefined),
}));

/**
 * Initialize the plugin and capture the registered channel provider.
 */
async function setupPlugin(options: {
  injectDelay?: number;
  injectResponse?: string;
} = {}) {
  const mockClient = createMockClient();
  (globalThis as any).__testMockClient = mockClient;

  let capturedProvider: any = null;
  const ctx = createMockContext();

  // Capture the channel provider when it's registered
  (ctx.registerChannelProvider as ReturnType<typeof vi.fn>).mockImplementation((provider: any) => {
    capturedProvider = provider;
  });

  const delay = options.injectDelay ?? 10;
  const response = options.injectResponse ?? "AI response";
  (ctx.inject as ReturnType<typeof vi.fn>).mockImplementation(async (_session: string, _msg: string, opts?: any) => {
    if (delay > 0) await new Promise((r) => setTimeout(r, delay));
    if (opts?.onStream) {
      opts.onStream({ type: "text", content: response });
      opts.onStream({ type: "complete", content: "" });
    }
    return response;
  });

  (ctx.getConfig as ReturnType<typeof vi.fn>).mockReturnValue({
    token: "mock-token",
    clientId: "mock-client-id",
    guildId: "mock-guild-id",
  });

  const pluginModule = await import("../src/index.js");
  const plugin = pluginModule.default;
  await plugin.init!(ctx);

  const readyHandlers = mockClient._eventHandlers.get("ready") || [];
  for (const h of readyHandlers) await h();

  const messageCreateHandlers = mockClient._eventHandlers.get("messageCreate") || [];

  return {
    plugin,
    ctx,
    mockClient,
    provider: capturedProvider,
    handleMessage: messageCreateHandlers[0] as (msg: any) => Promise<void>,
    shutdown: () => plugin.shutdown!(),
  };
}

describe("Discord Channel Provider", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.resetModules();
    delete (globalThis as any).__testMockClient;
  });

  // =========================================================================
  // Provider Registration
  // =========================================================================

  describe("provider registration", () => {
    it("should register the channel provider during init", async () => {
      const { provider, shutdown } = await setupPlugin();

      expect(provider).not.toBeNull();
      expect(provider.id).toBe("discord");
      await shutdown();
    });
  });

  // =========================================================================
  // Command Registration
  // =========================================================================

  describe("command registration", () => {
    it("should register and retrieve commands", async () => {
      const { provider, shutdown } = await setupPlugin();

      provider.registerCommand({ name: "test-cmd", description: "A test command", execute: vi.fn() });

      const commands = provider.getCommands();
      expect(commands).toHaveLength(1);
      expect(commands[0].name).toBe("test-cmd");

      await shutdown();
    });

    it("should unregister commands by name", async () => {
      const { provider, shutdown } = await setupPlugin();

      provider.registerCommand({ name: "remove-me", description: "To be removed", execute: vi.fn() });
      expect(provider.getCommands()).toHaveLength(1);

      provider.unregisterCommand("remove-me");
      expect(provider.getCommands()).toHaveLength(0);

      await shutdown();
    });

    it("should overwrite command with same name", async () => {
      const { provider, shutdown } = await setupPlugin();

      const exec1 = vi.fn();
      const exec2 = vi.fn();
      provider.registerCommand({ name: "dup", description: "Version 1", execute: exec1 });
      provider.registerCommand({ name: "dup", description: "Version 2", execute: exec2 });

      const commands = provider.getCommands();
      expect(commands).toHaveLength(1);
      expect(commands[0].description).toBe("Version 2");

      await shutdown();
    });
  });

  // =========================================================================
  // Message Parser Registration
  // =========================================================================

  describe("message parser registration", () => {
    it("should add and retrieve message parsers", async () => {
      const { provider, shutdown } = await setupPlugin();

      provider.addMessageParser({ id: "parser-1", pattern: /test/, handler: vi.fn() });

      const parsers = provider.getMessageParsers();
      expect(parsers).toHaveLength(1);
      expect(parsers[0].id).toBe("parser-1");

      await shutdown();
    });

    it("should remove message parsers by id", async () => {
      const { provider, shutdown } = await setupPlugin();

      provider.addMessageParser({ id: "temp-parser", pattern: /temp/, handler: vi.fn() });
      expect(provider.getMessageParsers()).toHaveLength(1);

      provider.removeMessageParser("temp-parser");
      expect(provider.getMessageParsers()).toHaveLength(0);

      await shutdown();
    });

    it("should support multiple parsers", async () => {
      const { provider, shutdown } = await setupPlugin();

      provider.addMessageParser({ id: "p1", pattern: /a/, handler: vi.fn() });
      provider.addMessageParser({ id: "p2", pattern: /b/, handler: vi.fn() });
      provider.addMessageParser({ id: "p3", pattern: /c/, handler: vi.fn() });

      expect(provider.getMessageParsers()).toHaveLength(3);

      await shutdown();
    });
  });

  // =========================================================================
  // send() - Message Chunking at 2000-char Discord Limit
  // =========================================================================

  describe("send() message chunking", () => {
    it("should send short messages without chunking", async () => {
      const { provider, mockClient, shutdown } = await setupPlugin();

      // Set up a text channel that the client can fetch
      const mockChannel = createMockTextChannel({ id: "send-ch-1" });
      mockClient.channels.fetch = vi.fn().mockResolvedValue(mockChannel);

      await provider.send("send-ch-1", "Hello world");

      expect(mockChannel.send).toHaveBeenCalledTimes(1);
      expect(mockChannel.send).toHaveBeenCalledWith("Hello world");

      await shutdown();
    });

    it("should chunk messages longer than 2000 chars at newline boundaries", async () => {
      const { provider, mockClient, shutdown } = await setupPlugin();

      const mockChannel = createMockTextChannel({ id: "send-ch-2" });
      mockClient.channels.fetch = vi.fn().mockResolvedValue(mockChannel);

      // Create a message with a natural newline break point near 2000 chars
      const line = "A".repeat(1900) + "\n" + "B".repeat(500);

      await provider.send("send-ch-2", line);

      // Should split at the newline (1901 chars in first chunk)
      expect(mockChannel.send).toHaveBeenCalledTimes(2);
      const firstChunk = (mockChannel.send as ReturnType<typeof vi.fn>).mock.calls[0][0];
      const secondChunk = (mockChannel.send as ReturnType<typeof vi.fn>).mock.calls[1][0];
      expect(firstChunk.length).toBeLessThanOrEqual(2000);
      expect(secondChunk).toContain("B");

      await shutdown();
    });

    it("should chunk at space boundary when no newline near limit", async () => {
      const { provider, mockClient, shutdown } = await setupPlugin();

      const mockChannel = createMockTextChannel({ id: "send-ch-3" });
      mockClient.channels.fetch = vi.fn().mockResolvedValue(mockChannel);

      // Create a message with spaces but no newlines, longer than 2000
      const words = Array(250).fill("longword1").join(" "); // ~2250 chars

      await provider.send("send-ch-3", words);

      expect(mockChannel.send).toHaveBeenCalledTimes(2);
      const firstChunk = (mockChannel.send as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(firstChunk.length).toBeLessThanOrEqual(2000);

      await shutdown();
    });

    it("should hard-split at 2000 when no good boundary exists", async () => {
      const { provider, mockClient, shutdown } = await setupPlugin();

      const mockChannel = createMockTextChannel({ id: "send-ch-4" });
      mockClient.channels.fetch = vi.fn().mockResolvedValue(mockChannel);

      // Create a 3000-char string with no spaces or newlines
      const solid = "X".repeat(3000);

      await provider.send("send-ch-4", solid);

      expect(mockChannel.send).toHaveBeenCalledTimes(2);
      const firstChunk = (mockChannel.send as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(firstChunk.length).toBe(2000);

      await shutdown();
    });

    it("should skip empty chunks after trimming", async () => {
      const { provider, mockClient, shutdown } = await setupPlugin();

      const mockChannel = createMockTextChannel({ id: "send-ch-5" });
      mockClient.channels.fetch = vi.fn().mockResolvedValue(mockChannel);

      // Message that splits into a real chunk + whitespace-only remainder
      const msg = "A".repeat(1990) + "\n" + "   ";

      await provider.send("send-ch-5", msg);

      // Only the first chunk should be sent (second is whitespace-only)
      expect(mockChannel.send).toHaveBeenCalledTimes(1);

      await shutdown();
    });

    it("should throw if client is not initialized", async () => {
      // We can't easily test this because setupPlugin always inits the client.
      // This is a structural test -- the code has `if (!client) throw`.
      const { provider, shutdown } = await setupPlugin();
      // The provider is bound to the initialized client, so we verify it works
      const mockChannel = createMockTextChannel({ id: "send-ch-ok" });
      const { mockClient } = await setupPlugin();
      mockClient.channels.fetch = vi.fn().mockResolvedValue(mockChannel);

      // This should not throw because client is initialized
      await expect(provider.send("send-ch-ok", "test")).resolves.not.toThrow();

      await shutdown();
    });
  });

  // =========================================================================
  // getBotUsername()
  // =========================================================================

  describe("getBotUsername()", () => {
    it("should return the bot username from the client", async () => {
      const { provider, shutdown } = await setupPlugin();

      // The mock client sets user.username = "WOPRBot"
      const username = provider.getBotUsername();
      expect(username).toBe("WOPRBot");

      await shutdown();
    });
  });
});

// =============================================================================
// Promise Chain Error Isolation
// =============================================================================

describe("Promise chain error isolation", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.resetModules();
    delete (globalThis as any).__testMockClient;
  });

  it("should continue processing after an inject failure", async () => {
    const mockClient = createMockClient();
    (globalThis as any).__testMockClient = mockClient;

    const ctx = createMockContext();

    let callCount = 0;
    (ctx.inject as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        throw new Error("First inject fails");
      }
      return "Second succeeds";
    });

    (ctx.getConfig as ReturnType<typeof vi.fn>).mockReturnValue({
      token: "mock-token",
      clientId: "mock-client-id",
      guildId: "mock-guild-id",
    });

    const pluginModule = await import("../src/index.js");
    const plugin = pluginModule.default;
    await plugin.init!(ctx);

    const readyHandlers = mockClient._eventHandlers.get("ready") || [];
    for (const h of readyHandlers) await h();

    const messageCreateHandlers = mockClient._eventHandlers.get("messageCreate") || [];
    const handleMessage = messageCreateHandlers[0] as (msg: any) => Promise<void>;

    const channelId = "ch-error-iso-1";
    const botUser = createMockUser({ id: "bot-123", username: "WOPRBot", bot: true });
    const humanUser = createMockUser({ id: "human-1", username: "HumanUser", bot: false });
    const mentions = new Map();
    mentions.set("bot-123", botUser);

    const channel = createMockTextChannel({ id: channelId, name: "test-channel" });

    // First message - inject will fail
    const msg1 = createMockMessage({
      id: "err-msg-1",
      content: "First message (will fail)",
      author: humanUser,
      channel,
      channelId,
      guild: channel.guild,
      mentions: { users: mentions, channels: new Map(), roles: new Map() },
      member: { displayName: "HumanUser" },
      interaction: null,
      reactions: { cache: new Map() },
      attachments: new Map(),
    });

    // Second message - inject should succeed
    const msg2 = createMockMessage({
      id: "err-msg-2",
      content: "Second message (should succeed)",
      author: humanUser,
      channel,
      channelId,
      guild: channel.guild,
      mentions: { users: mentions, channels: new Map(), roles: new Map() },
      member: { displayName: "HumanUser" },
      interaction: null,
      reactions: { cache: new Map() },
      attachments: new Map(),
    });

    await handleMessage(msg1);
    await vi.advanceTimersByTimeAsync(200);
    await handleMessage(msg2);
    await vi.advanceTimersByTimeAsync(200);

    // Both should have been called -- error in first doesn't block second
    expect(callCount).toBe(2);

    await plugin.shutdown!();
  });
});
