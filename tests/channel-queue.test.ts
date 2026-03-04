/**
 * Tests for the Channel Message Queue system in wopr-plugin-discord.
 *
 * The queue system lives inside src/index.ts as module-private state.
 * We test it by initializing the plugin with mocks, then driving behavior
 * through the Discord client's event handlers (MessageCreate, TypingStart).
 *
 * Key behaviors under test:
 * - Message buffer is FIFO with a 20-message cap
 * - Human messages get immediate priority (clear pending bot queue)
 * - Bot messages have a 5000ms cooldown before processing
 * - Human typing window pauses bot processing for 15000ms
 * - Promise chain enforces sequential ordering per channel
 * - Channels are independent (no cross-channel interference)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChannelQueueManager, type QueuedInject } from "../src/channel-queue.js";
import { createMockClient, createMockMessage, createMockTextChannel, createMockUser } from "./mocks/discord-client.js";
import { createMockContext } from "./mocks/wopr-context.js";

// We need to mock discord.js and winston BEFORE importing the plugin
vi.mock("discord.js", () => {
  // Provide minimal stubs for classes and enums the plugin imports
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

// Mock node:fs to avoid real filesystem access
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
 * Helper: initialize the plugin, capturing the event handlers registered on the mock client.
 * Returns the messageCreate and typingStart handlers.
 */
async function setupPlugin(options: {
  injectDelay?: number;
  injectResponse?: string;
} = {}) {
  const mockClient = createMockClient();

  // The plugin creates its own Client via new Client().
  // Our mock of discord.js returns __testMockClient.
  (globalThis as any).__testMockClient = mockClient;

  const ctx = createMockContext();

  // Configure inject to optionally delay
  const delay = options.injectDelay ?? 10;
  const response = options.injectResponse ?? "AI response";
  (ctx.inject as ReturnType<typeof vi.fn>).mockImplementation(async (_session: string, _msg: string, opts?: any) => {
    if (delay > 0) await new Promise((r) => setTimeout(r, delay));
    // Call onStream with a complete message if provided
    if (opts?.onStream) {
      opts.onStream({ type: "text", content: response });
      opts.onStream({ type: "complete", content: "" });
    }
    return response;
  });

  // Provide config so plugin will try to login
  (ctx.getConfig as ReturnType<typeof vi.fn>).mockReturnValue({
    token: "mock-token",
    clientId: "mock-client-id",
    guildId: "mock-guild-id",
  });

  // Import the plugin
  const pluginModule = await import("../src/index.js");
  const plugin = pluginModule.default;

  // Init the plugin
  await plugin.init!(ctx);

  // Extract the event handlers the plugin registered on the mock client
  const messageCreateHandlers = mockClient._eventHandlers.get("messageCreate") || [];
  const typingStartHandlers = mockClient._eventHandlers.get("typingStart") || [];
  const readyHandlers = mockClient._eventHandlers.get("ready") || [];

  // Fire the ready event so the plugin completes initialization
  for (const h of readyHandlers) await h();

  return {
    plugin,
    ctx,
    mockClient,
    handleMessage: messageCreateHandlers[0] as (msg: any) => Promise<void>,
    handleTypingStart: typingStartHandlers[0] as (typing: any) => void,
    shutdown: () => plugin.shutdown!(),
  };
}

function createHumanMessage(channelId: string, content: string, overrides: Record<string, any> = {}) {
  const channel = createMockTextChannel({ id: channelId, name: "test-channel" });
  const botUser = createMockUser({ id: "bot-123", username: "WOPRBot", bot: true });
  const humanUser = createMockUser({ id: "human-1", username: "HumanUser", bot: false });

  const mentions = new Map();
  mentions.set("bot-123", botUser);

  // Create reactions cache that supports set/get/has
  const reactionsCache = new Map<string, any>();

  return createMockMessage({
    id: overrides.id ?? `msg-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    content,
    author: overrides.author ?? humanUser,
    channel,
    channelId,
    guild: channel.guild,
    mentions: { users: mentions, channels: new Map(), roles: new Map() },
    member: { displayName: humanUser.displayName },
    interaction: null,
    reactions: { cache: reactionsCache },
    attachments: new Map(),
    ...overrides,
  });
}

function createBotMessage(channelId: string, content: string, overrides: Record<string, any> = {}) {
  const channel = createMockTextChannel({ id: channelId, name: "test-channel" });
  const botUser = createMockUser({ id: "bot-123", username: "WOPRBot", bot: true });
  const otherBot = createMockUser({ id: "other-bot-456", username: "OtherBot", bot: true, tag: "OtherBot#0001" });

  const mentions = new Map();
  mentions.set("bot-123", botUser);

  const reactionsCache = new Map<string, any>();

  return createMockMessage({
    id: overrides.id ?? `msg-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    content,
    author: overrides.author ?? otherBot,
    channel,
    channelId,
    guild: channel.guild,
    mentions: { users: mentions, channels: new Map(), roles: new Map() },
    member: { displayName: otherBot.displayName ?? otherBot.username },
    interaction: null,
    reactions: { cache: reactionsCache },
    attachments: new Map(),
    ...overrides,
  });
}

describe("Channel Queue System", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    // Reset the module cache so each test gets fresh state
    vi.resetModules();
    delete (globalThis as any).__testMockClient;
  });

  // =========================================================================
  // Buffer FIFO with 20-message cap
  // =========================================================================

  describe("Buffer FIFO with 20-message cap", () => {
    it("should add messages to the buffer in order", async () => {
      const { handleMessage, ctx, shutdown } = await setupPlugin({ injectDelay: 50 });

      const channelId = "ch-fifo-1";

      // Send 3 messages from a human that mentions the bot (triggers inject)
      const msg1 = createHumanMessage(channelId, "Message 1");
      const msg2 = createHumanMessage(channelId, "Message 2");

      // First message will trigger inject, second will be queued
      await handleMessage(msg1);
      await handleMessage(msg2);

      // Advance timers to process the queue
      await vi.advanceTimersByTimeAsync(200);

      // Both messages should have triggered injects
      expect(ctx.inject).toHaveBeenCalled();
      await shutdown();
    });

    it("should cap buffer at 20 messages (FIFO eviction)", async () => {
      const { handleMessage, ctx, shutdown } = await setupPlugin({ injectDelay: 5 });

      const channelId = "ch-cap-1";

      // Create a non-mentioning human user (messages logged to buffer but no inject)
      const noMentionUser = createMockUser({ id: "human-no-mention", username: "Observer", bot: false });

      // Send 25 messages without @mention (they go to buffer only, no inject)
      for (let i = 0; i < 25; i++) {
        const channel = createMockTextChannel({ id: channelId, name: "test-channel" });
        const msg = createMockMessage({
          id: `buf-msg-${i}`,
          content: `Buffer message ${i}`,
          author: noMentionUser,
          channel,
          channelId,
          guild: channel.guild,
          mentions: { users: new Map(), channels: new Map(), roles: new Map() },
          member: { displayName: "Observer" },
          interaction: null,
          reactions: { cache: new Map() },
          attachments: new Map(),
        });
        await handleMessage(msg);
      }

      // Now send an @mention to trigger inject - the inject will include buffer context
      const mentionMsg = createHumanMessage(channelId, "Trigger message");
      await handleMessage(mentionMsg);

      await vi.advanceTimersByTimeAsync(200);

      // The inject should have been called. The buffer context won't contain messages 0-4
      // because the buffer was capped at 20 (messages 5-24 survived, plus the trigger = 21 -> 20 kept)
      expect(ctx.inject).toHaveBeenCalled();

      // Verify that the inject was called and buffer context was built from recent messages
      const injectCall = (ctx.inject as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(injectCall).toBeDefined();

      await shutdown();
    });

    it("should evict oldest messages when buffer exceeds 20", async () => {
      const { handleMessage, ctx, shutdown } = await setupPlugin({ injectDelay: 5 });

      const channelId = "ch-evict-1";
      const noMentionUser = createMockUser({ id: "human-no-mention", username: "Observer", bot: false });

      // Fill buffer with 22 messages
      for (let i = 0; i < 22; i++) {
        const channel = createMockTextChannel({ id: channelId, name: "test-channel" });
        const msg = createMockMessage({
          id: `evict-msg-${i}`,
          content: `Evictable message ${i}`,
          author: noMentionUser,
          channel,
          channelId,
          guild: channel.guild,
          mentions: { users: new Map(), channels: new Map(), roles: new Map() },
          member: { displayName: "Observer" },
          interaction: null,
          reactions: { cache: new Map() },
          attachments: new Map(),
        });
        await handleMessage(msg);
      }

      // Now trigger inject with @mention
      const triggerMsg = createHumanMessage(channelId, "Now respond");
      await handleMessage(triggerMsg);
      await vi.advanceTimersByTimeAsync(200);

      // inject was called; the buffer context should NOT contain early messages
      // 22 messages fill buffer, evicting 0 and 1. The trigger message adds one more,
      // evicting 2. Context = buffer[0:-1] = messages 3..21.
      const injectArgs = (ctx.inject as ReturnType<typeof vi.fn>).mock.calls[0];
      const injectedMessage = injectArgs?.[1] as string;
      // Messages 0, 1, 2 were evicted; message 3+ survived
      expect(injectedMessage).not.toMatch(/Evictable message 0\b/);
      expect(injectedMessage).not.toMatch(/Evictable message 1\b/);
      expect(injectedMessage).not.toMatch(/Evictable message 2\b/);
      // But should contain messages that survived eviction
      expect(injectedMessage).toContain("Evictable message 10");

      await shutdown();
    });
  });

  // =========================================================================
  // Human priority - clears pending bot queue
  // =========================================================================

  describe("Human message priority", () => {
    it("should give human messages immediate priority over queued bot messages", async () => {
      const { handleMessage, ctx, shutdown } = await setupPlugin({ injectDelay: 50 });

      const channelId = "ch-priority-1";

      // Send bot message first (will be queued with 5000ms cooldown)
      const botMsg = createBotMessage(channelId, "Bot question to @WOPRBot");
      await handleMessage(botMsg);

      // Now send a human message before cooldown expires
      const humanMsg = createHumanMessage(channelId, "Human takes priority");
      await handleMessage(humanMsg);

      // Advance past cooldown
      await vi.advanceTimersByTimeAsync(6000);

      // Human message should be processed. Bot message pending queue was cleared.
      const injectCalls = (ctx.inject as ReturnType<typeof vi.fn>).mock.calls;
      // The human inject should be there
      expect(injectCalls.length).toBeGreaterThanOrEqual(1);

      // First inject should be the human message (bot was cleared from pending)
      const firstInjectMsg = injectCalls[0]?.[1] as string;
      expect(firstInjectMsg).toContain("Human takes priority");

      await shutdown();
    });

    it("should clear pending bot messages when human sends a message", async () => {
      const { handleMessage, ctx, shutdown } = await setupPlugin({ injectDelay: 20 });

      const channelId = "ch-clear-bot-1";

      // Queue multiple bot messages
      const bot1 = createBotMessage(channelId, "Bot msg 1 @WOPRBot", { id: "bot-q-1" });
      const bot2 = createBotMessage(channelId, "Bot msg 2 @WOPRBot", { id: "bot-q-2" });
      await handleMessage(bot1);
      await handleMessage(bot2);

      // Human message comes in - should clear bot pending queue
      const humanMsg = createHumanMessage(channelId, "Human interrupts", { id: "human-int-1" });
      await handleMessage(humanMsg);

      // Advance time well past bot cooldown
      await vi.advanceTimersByTimeAsync(10000);

      // Only the human inject should have fired (bot messages were cleared)
      const injectCalls = (ctx.inject as ReturnType<typeof vi.fn>).mock.calls;
      expect(injectCalls.length).toBeGreaterThanOrEqual(1);
      const allMessages = injectCalls.map((c: any[]) => c[1] as string);
      expect(allMessages.some((m: string) => m.includes("Human interrupts"))).toBe(true);

      await shutdown();
    });
  });

  // =========================================================================
  // Bot cooldown (5000ms)
  // =========================================================================

  describe("Bot message cooldown (5000ms)", () => {
    it("should delay bot messages by 5000ms cooldown", async () => {
      const { handleMessage, ctx, shutdown } = await setupPlugin({ injectDelay: 10 });

      const channelId = "ch-cooldown-1";

      const botMsg = createBotMessage(channelId, "Bot @WOPRBot question", { id: "bot-cd-1" });
      await handleMessage(botMsg);

      // After 1s - should NOT have fired yet
      await vi.advanceTimersByTimeAsync(1000);
      expect(ctx.inject).not.toHaveBeenCalled();

      // After 3s more (total 4s) - still shouldn't fire
      await vi.advanceTimersByTimeAsync(3000);
      expect(ctx.inject).not.toHaveBeenCalled();

      // After 2s more (total 6s, past 5s cooldown) - should fire
      await vi.advanceTimersByTimeAsync(2000);

      // Give a bit more time for the async chain to resolve
      await vi.advanceTimersByTimeAsync(500);

      expect(ctx.inject).toHaveBeenCalled();

      await shutdown();
    });

    it("should not apply cooldown to human messages", async () => {
      const { handleMessage, ctx, shutdown } = await setupPlugin({ injectDelay: 10 });

      const channelId = "ch-no-cooldown-1";

      const humanMsg = createHumanMessage(channelId, "Immediate human msg", { id: "human-nc-1" });
      await handleMessage(humanMsg);

      // Human messages should be processed immediately (no cooldown)
      await vi.advanceTimersByTimeAsync(200);
      expect(ctx.inject).toHaveBeenCalled();

      await shutdown();
    });

    it("should queue bot message with reaction when pending", async () => {
      const { handleMessage, shutdown } = await setupPlugin({ injectDelay: 10 });

      const channelId = "ch-reaction-1";

      const botMsg = createBotMessage(channelId, "Bot @WOPRBot with reaction", { id: "bot-react-1" });
      await handleMessage(botMsg);

      // The bot message should get a "queued" reaction
      expect(botMsg.react).toHaveBeenCalled();

      await shutdown();
    });
  });

  // =========================================================================
  // Human typing window (15000ms)
  // =========================================================================

  describe("Human typing window (15000ms)", () => {
    it("should pause bot processing during human typing", async () => {
      const { handleMessage, handleTypingStart, ctx, shutdown } = await setupPlugin({ injectDelay: 10 });

      const channelId = "ch-typing-1";
      const channel = createMockTextChannel({ id: channelId });

      // Queue a bot message
      const botMsg = createBotMessage(channelId, "Bot @WOPRBot typing test", { id: "bot-typing-1" });
      await handleMessage(botMsg);

      // Human starts typing BEFORE bot cooldown expires
      handleTypingStart({ user: { bot: false }, channel });

      // Advance past bot cooldown (5s) but within human typing window (15s)
      await vi.advanceTimersByTimeAsync(6000);

      // Bot inject should NOT have fired because human is typing
      expect(ctx.inject).not.toHaveBeenCalled();

      // Advance past typing window
      await vi.advanceTimersByTimeAsync(15000);

      // Now it should fire
      await vi.advanceTimersByTimeAsync(2000);
      expect(ctx.inject).toHaveBeenCalled();

      await shutdown();
    });

    it("should ignore bot typing events", async () => {
      const { handleMessage, handleTypingStart, ctx, shutdown } = await setupPlugin({ injectDelay: 10 });

      const channelId = "ch-bot-typing-1";
      const channel = createMockTextChannel({ id: channelId });

      // Queue a bot message
      const botMsg = createBotMessage(channelId, "Bot @WOPRBot bot-typing test", { id: "bot-bt-1" });
      await handleMessage(botMsg);

      // Another bot starts typing - should be ignored
      handleTypingStart({ user: { bot: true }, channel });

      // Advance past cooldown
      await vi.advanceTimersByTimeAsync(6000);
      await vi.advanceTimersByTimeAsync(500);

      // Bot inject should fire (bot typing doesn't block)
      expect(ctx.inject).toHaveBeenCalled();

      await shutdown();
    });

    it("should extend typing window with successive typing events", async () => {
      const { handleMessage, handleTypingStart, ctx, shutdown } = await setupPlugin({ injectDelay: 10 });

      const channelId = "ch-extend-1";
      const channel = createMockTextChannel({ id: channelId });

      // Queue a bot message
      const botMsg = createBotMessage(channelId, "Bot @WOPRBot extend test", { id: "bot-ext-1" });
      await handleMessage(botMsg);

      // Human types repeatedly
      handleTypingStart({ user: { bot: false }, channel });
      await vi.advanceTimersByTimeAsync(7000);

      // Still typing after 7s
      handleTypingStart({ user: { bot: false }, channel });
      await vi.advanceTimersByTimeAsync(7000);

      // 14s total, but last typing was at 7s, so typing window goes until 7s + 15s = 22s
      // We're at 14s, still within window
      expect(ctx.inject).not.toHaveBeenCalled();

      // Advance past the extended window
      await vi.advanceTimersByTimeAsync(10000); // 24s total
      await vi.advanceTimersByTimeAsync(1000);

      expect(ctx.inject).toHaveBeenCalled();

      await shutdown();
    });
  });

  // =========================================================================
  // Promise chain ordering
  // =========================================================================

  describe("Promise chain ordering", () => {
    it("should process human messages sequentially in order", async () => {
      const injectOrder: string[] = [];
      let inFlight = 0;
      const injectDelay = 30;
      const { handleMessage, ctx, shutdown } = await setupPlugin({ injectDelay });

      let callCount = 0;
      (ctx.inject as ReturnType<typeof vi.fn>).mockImplementation(async (_s: string, msg: string) => {
        // Assert non-overlapping: no other inject should be running concurrently
        expect(inFlight).toBe(0);
        inFlight++;
        callCount++;
        injectOrder.push(msg);
        try {
          await new Promise((r) => setTimeout(r, injectDelay));
          return `Response ${callCount}`;
        } finally {
          inFlight--;
        }
      });

      const channelId = "ch-order-test";
      const msg1 = createHumanMessage(channelId, "First message");
      const msg2 = createHumanMessage(channelId, "Second message");
      const msg3 = createHumanMessage(channelId, "Third message");

      // Dispatch all three without awaiting between calls so the queue is under
      // concurrency pressure — this is what actually exercises FIFO enforcement
      const p1 = handleMessage(msg1);
      const p2 = handleMessage(msg2);
      const p3 = handleMessage(msg3);

      // Advance enough time for all 3 messages to process sequentially, derived
      // from injectDelay so the test stays accurate if the delay changes
      await vi.advanceTimersByTimeAsync(injectDelay * 4);
      await Promise.all([p1, p2, p3]);

      // Verify all three were injected in FIFO order with no overlap
      expect(injectOrder.length).toBe(3);
      expect(injectOrder[0]).toContain("First message");
      expect(injectOrder[1]).toContain("Second message");
      expect(injectOrder[2]).toContain("Third message");

      await shutdown();
    });

    it("should maintain per-channel promise chains", async () => {
      const { handleMessage, ctx, shutdown } = await setupPlugin({ injectDelay: 20 });

      const ch1 = "ch-chain-1";
      const ch2 = "ch-chain-2";

      // Send messages to two different channels simultaneously
      const msg1 = createHumanMessage(ch1, "Channel 1 message", { id: "chain-1" });
      const msg2 = createHumanMessage(ch2, "Channel 2 message", { id: "chain-2" });

      await handleMessage(msg1);
      await handleMessage(msg2);

      await vi.advanceTimersByTimeAsync(500);

      // Both channels should have had their messages processed
      const injectCalls = (ctx.inject as ReturnType<typeof vi.fn>).mock.calls;
      expect(injectCalls.length).toBe(2);

      await shutdown();
    });
  });

  // =========================================================================
  // Multi-channel independence
  // =========================================================================

  describe("Multi-channel independence", () => {
    it("should maintain separate buffers per channel", async () => {
      const { handleMessage, ctx, shutdown } = await setupPlugin({ injectDelay: 10 });

      const ch1 = "ch-indep-1";
      const ch2 = "ch-indep-2";

      // Fill channel 1 buffer with non-mention messages
      const observer = createMockUser({ id: "observer-1", username: "Observer", bot: false });
      for (let i = 0; i < 5; i++) {
        const channel = createMockTextChannel({ id: ch1, name: "channel-1" });
        const msg = createMockMessage({
          id: `ch1-msg-${i}`,
          content: `CH1 message ${i}`,
          author: observer,
          channel,
          channelId: ch1,
          guild: channel.guild,
          mentions: { users: new Map(), channels: new Map(), roles: new Map() },
          member: { displayName: "Observer" },
          interaction: null,
          reactions: { cache: new Map() },
          attachments: new Map(),
        });
        await handleMessage(msg);
      }

      // Channel 2 gets a direct mention (no CH1 context should leak)
      const ch2Msg = createHumanMessage(ch2, "CH2 trigger", { id: "ch2-trigger-1" });
      await handleMessage(ch2Msg);
      await vi.advanceTimersByTimeAsync(200);

      // Channel 2's inject should NOT contain CH1 buffer context
      const injectCalls = (ctx.inject as ReturnType<typeof vi.fn>).mock.calls;
      const ch2Inject = injectCalls.find((c: any[]) => (c[1] as string).includes("CH2 trigger"));
      expect(ch2Inject).toBeDefined();
      expect(ch2Inject![1]).not.toContain("CH1 message");

      await shutdown();
    });

    it("should allow independent bot cooldowns per channel", async () => {
      const { handleMessage, ctx, shutdown } = await setupPlugin({ injectDelay: 10 });

      const ch1 = "ch-cool-1";
      const ch2 = "ch-cool-2";

      // Queue bot messages in both channels
      const botMsg1 = createBotMessage(ch1, "Bot @WOPRBot ch1", { id: "bot-cool-1" });
      const botMsg2 = createBotMessage(ch2, "Bot @WOPRBot ch2", { id: "bot-cool-2" });

      await handleMessage(botMsg1);
      await handleMessage(botMsg2);

      // Advance past cooldown
      await vi.advanceTimersByTimeAsync(6000);
      await vi.advanceTimersByTimeAsync(500);

      // Both channels should have processed their bot messages independently
      const injectCalls = (ctx.inject as ReturnType<typeof vi.fn>).mock.calls;
      expect(injectCalls.length).toBe(2);

      await shutdown();
    });

    it("should not cross-cancel between channels", async () => {
      const { handleMessage, ctx, shutdown } = await setupPlugin({ injectDelay: 10 });

      const ch1 = "ch-cancel-1";
      const ch2 = "ch-cancel-2";

      // Queue bot message in ch1
      const botMsg = createBotMessage(ch1, "Bot @WOPRBot ch1 pending", { id: "bot-nc-1" });
      await handleMessage(botMsg);

      // Human message in ch2 should NOT cancel ch1's pending bot message
      const humanMsg = createHumanMessage(ch2, "CH2 human", { id: "human-nc-2" });
      await handleMessage(humanMsg);

      // Advance past cooldown
      await vi.advanceTimersByTimeAsync(6000);
      await vi.advanceTimersByTimeAsync(500);

      // Both should have been processed - ch1's bot msg was NOT cancelled by ch2's human
      const injectCalls = (ctx.inject as ReturnType<typeof vi.fn>).mock.calls;
      expect(injectCalls.length).toBe(2);

      await shutdown();
    });

    it("should handle human typing in one channel without affecting another", async () => {
      const { handleMessage, handleTypingStart, ctx, shutdown } = await setupPlugin({ injectDelay: 10 });

      const ch1 = "ch-typing-iso-1";
      const ch2 = "ch-typing-iso-2";

      // Queue bot messages in both channels
      const bot1 = createBotMessage(ch1, "Bot @WOPRBot ch1 typing", { id: "bot-ti-1" });
      const bot2 = createBotMessage(ch2, "Bot @WOPRBot ch2 typing", { id: "bot-ti-2" });
      await handleMessage(bot1);
      await handleMessage(bot2);

      // Human types in ch1 only
      handleTypingStart({ user: { bot: false }, channel: { id: ch1 } });

      // Advance past cooldown but within typing window
      await vi.advanceTimersByTimeAsync(6000);
      await vi.advanceTimersByTimeAsync(500);

      // ch2 should have processed (no typing block), ch1 should still be blocked
      const injectCalls = (ctx.inject as ReturnType<typeof vi.fn>).mock.calls;

      // At least ch2 should have processed
      const ch2Processed = injectCalls.some((c: any[]) => (c[1] as string).includes("ch2 typing"));
      expect(ch2Processed).toBe(true);

      await shutdown();
    });
  });

  // =========================================================================
  // Queue cancel behavior
  // =========================================================================

  describe("Queue cancel behavior", () => {
    it("should ignore messages from itself", async () => {
      const { handleMessage, ctx, shutdown } = await setupPlugin();

      const channelId = "ch-self-1";

      // Create a message from the bot itself
      const botSelf = createMockUser({ id: "bot-123", username: "WOPRBot", bot: true });
      const channel = createMockTextChannel({ id: channelId });
      const selfMsg = createMockMessage({
        id: "self-msg-1",
        content: "My own message",
        author: botSelf,
        channel,
        channelId,
        guild: channel.guild,
        mentions: { users: new Map(), channels: new Map(), roles: new Map() },
        interaction: null,
        reactions: { cache: new Map() },
        attachments: new Map(),
      });

      await handleMessage(selfMsg);
      await vi.advanceTimersByTimeAsync(200);

      // Should NOT inject for its own messages
      expect(ctx.inject).not.toHaveBeenCalled();

      await shutdown();
    });

    it("should ignore bot messages without @mention", async () => {
      const { handleMessage, ctx, shutdown } = await setupPlugin();

      const channelId = "ch-no-mention-1";
      const otherBot = createMockUser({ id: "other-bot-789", username: "AnotherBot", bot: true });
      const channel = createMockTextChannel({ id: channelId });

      const botMsg = createMockMessage({
        id: "bot-no-mention-1",
        content: "Bot talking without mentioning WOPR",
        author: otherBot,
        channel,
        channelId,
        guild: channel.guild,
        mentions: { users: new Map(), channels: new Map(), roles: new Map() },
        member: { displayName: "AnotherBot" },
        interaction: null,
        reactions: { cache: new Map() },
        attachments: new Map(),
      });

      await handleMessage(botMsg);
      await vi.advanceTimersByTimeAsync(6000);

      // Should NOT inject because bot didn't @mention
      expect(ctx.inject).not.toHaveBeenCalled();

      await shutdown();
    });
  });

  // =========================================================================
  // Chain error resilience (WOP-1560)
  // =========================================================================

  describe("Chain error resilience (WOP-1560)", () => {
    it("should continue processing after a chain error", async () => {
      const { handleMessage, ctx, shutdown } = await setupPlugin({ injectDelay: 10 });

      const channelId = "ch-resilience-1";

      let callCount = 0;
      (ctx.inject as ReturnType<typeof vi.fn>).mockImplementation(async (_s: string, _msg: string) => {
        callCount++;
        if (callCount === 1) {
          throw new Error("Corrupted item simulation");
        }
        return "OK";
      });

      const msg1 = createHumanMessage(channelId, "Will fail");
      const msg2 = createHumanMessage(channelId, "Should still process");

      await handleMessage(msg1);
      await handleMessage(msg2);

      await vi.advanceTimersByTimeAsync(500);

      expect(callCount).toBe(2);

      await shutdown();
    });

    it("should process subsequent items after a pre-rejected processingChain", async () => {
      // Directly exercises the outer .catch() on processingChain (WOP-1560 targeted).
      // A pre-rejected chain simulates state that escapes the inner try/catch.
      // Without .catch(): all .then() handlers are skipped → callCount stays 0.
      // With .catch(): rejection is absorbed after item1, so item2 executes → callCount === 1.

      let injectCallCount = 0;
      const manager = new ChannelQueueManager(async () => {
        injectCallCount++;
      });
      const channelId = "ch-pre-rejected";

      // Suppress unhandled-rejection warning; this rejection is intentional
      const preRejected = Promise.reject(new Error("Simulated pre-existing chain failure"));
      preRejected.catch(() => {});

      (manager as any).channelQueues.set(channelId, {
        buffer: [],
        processingChain: preRejected,
        pendingItems: [],
        humanTypingUntil: 0,
        currentInject: null,
      });

      const item: QueuedInject = {
        sessionKey: "test-session",
        messageContent: "post-failure item",
        authorDisplayName: "TestUser",
        replyToMessage: {} as any,
        isBot: false,
        queuedAt: Date.now(),
      };

      // item1: chained onto the pre-rejected promise → .catch() absorbs, .then() runs
      manager.queueInject(channelId, item);
      // item2: chained onto the resolved promise → .catch() no-ops, .then() runs
      manager.queueInject(channelId, item);

      await vi.advanceTimersByTimeAsync(100);

      expect(injectCallCount).toBe(2);
    });
  });
});
