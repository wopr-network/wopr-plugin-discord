/**
 * Tests for the Slash Command system in wopr-plugin-discord.
 *
 * Covers:
 * - All 13 built-in commands (status, new, reset, compact, think, verbose,
 *   usage, session, wopr, help, claim, cancel, model)
 * - Model resolution cascade (exact -> partial -> name, case-insensitive)
 * - Dynamic handler delegation for registered channel commands
 * - Autocomplete with 25-choice limit
 * - Session override persistence (thinkingLevel, verbose, usageMode, model)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createMockClient,
  createMockInteraction,
  createMockTextChannel,
} from "./mocks/discord-client.js";
import { createMockContext } from "./mocks/wopr-context.js";

// ---------------------------------------------------------------------------
// Mock discord.js
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// Setup helper
// ---------------------------------------------------------------------------
async function setupPlugin(options: {
  injectDelay?: number;
  injectResponse?: string;
  providerModels?: { provider: string; id: string; name: string }[];
} = {}) {
  const mockClient = createMockClient();
  (globalThis as any).__testMockClient = mockClient;

  const ctx = createMockContext();

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

  // Provide config
  (ctx.getConfig as ReturnType<typeof vi.fn>).mockReturnValue({
    token: "mock-token",
    clientId: "mock-client-id",
    guildId: "mock-guild-id",
  });

  // Set up provider/model resolution if models provided
  if (options.providerModels) {
    const models = options.providerModels;
    // The plugin calls ctx.getProvider for each known provider ID
    (ctx as any).getProvider = vi.fn((pid: string) => {
      const providerModels = models.filter((m) => m.provider === pid);
      if (providerModels.length === 0) return null;
      return { supportedModels: providerModels.map((m) => m.id) };
    });
  }

  const pluginModule = await import("../src/index.js");
  const plugin = pluginModule.default;
  await plugin.init!(ctx);

  // Extract event handlers
  const interactionHandlers = mockClient._eventHandlers.get("interactionCreate") || [];
  const readyHandlers = mockClient._eventHandlers.get("ready") || [];

  // Fire ready
  for (const h of readyHandlers) await h();

  return {
    plugin,
    ctx,
    mockClient,
    handleInteraction: interactionHandlers[0] as (interaction: any) => Promise<void>,
    shutdown: () => plugin.shutdown!(),
  };
}

function createSlashInteraction(commandName: string, optionsData: Record<string, any> = {}, overrides: Record<string, any> = {}) {
  const channel = createMockTextChannel({ id: "cmd-channel-123", name: "general" });
  return createMockInteraction({
    commandName,
    optionsData,
    channel,
    channelId: channel.id,
    ...overrides,
  });
}

describe("Slash Command System", () => {
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
  // Built-in commands
  // =========================================================================

  describe("Built-in commands", () => {
    it("/status should reply with session info", async () => {
      const { handleInteraction, shutdown } = await setupPlugin();

      const interaction = createSlashInteraction("status");
      await handleInteraction(interaction);

      expect(interaction.reply).toHaveBeenCalledWith(
        expect.objectContaining({
          content: expect.stringContaining("Session Status"),
          ephemeral: true,
        }),
      );

      await shutdown();
    });

    it("/new should reset session state", async () => {
      const { handleInteraction, shutdown } = await setupPlugin();

      const interaction = createSlashInteraction("new");
      await handleInteraction(interaction);

      expect(interaction.reply).toHaveBeenCalledWith(
        expect.objectContaining({
          content: expect.stringContaining("Session Reset"),
        }),
      );

      await shutdown();
    });

    it("/reset should reset session state (alias for /new)", async () => {
      const { handleInteraction, shutdown } = await setupPlugin();

      const interaction = createSlashInteraction("reset");
      await handleInteraction(interaction);

      expect(interaction.reply).toHaveBeenCalledWith(
        expect.objectContaining({
          content: expect.stringContaining("Session Reset"),
        }),
      );

      await shutdown();
    });

    it("/compact should trigger context compaction", async () => {
      const { handleInteraction, ctx, shutdown } = await setupPlugin();

      const interaction = createSlashInteraction("compact");
      await handleInteraction(interaction);

      // Should reply initially then call inject with /compact
      expect(interaction.reply).toHaveBeenCalledWith(
        expect.objectContaining({
          content: expect.stringContaining("Compacting Session"),
        }),
      );

      // inject should be called with "/compact"
      await vi.advanceTimersByTimeAsync(100);
      expect(ctx.inject).toHaveBeenCalledWith(
        expect.any(String),
        "/compact",
        expect.objectContaining({ silent: true }),
      );

      await shutdown();
    });

    it("/think should update thinking level", async () => {
      const { handleInteraction, shutdown } = await setupPlugin();

      const interaction = createSlashInteraction("think", { level: "high" });
      await handleInteraction(interaction);

      expect(interaction.reply).toHaveBeenCalledWith(
        expect.objectContaining({
          content: expect.stringContaining("high"),
          ephemeral: true,
        }),
      );

      await shutdown();
    });

    it("/verbose should toggle verbose mode on", async () => {
      const { handleInteraction, shutdown } = await setupPlugin();

      const interaction = createSlashInteraction("verbose", { enabled: true });
      await handleInteraction(interaction);

      expect(interaction.reply).toHaveBeenCalledWith(
        expect.objectContaining({
          content: expect.stringContaining("Verbose mode enabled"),
          ephemeral: true,
        }),
      );

      await shutdown();
    });

    it("/verbose should toggle verbose mode off", async () => {
      const { handleInteraction, shutdown } = await setupPlugin();

      const interaction = createSlashInteraction("verbose", { enabled: false });
      await handleInteraction(interaction);

      expect(interaction.reply).toHaveBeenCalledWith(
        expect.objectContaining({
          content: expect.stringContaining("Verbose mode disabled"),
          ephemeral: true,
        }),
      );

      await shutdown();
    });

    it("/usage should update usage tracking mode", async () => {
      const { handleInteraction, shutdown } = await setupPlugin();

      const interaction = createSlashInteraction("usage", { mode: "full" });
      await handleInteraction(interaction);

      expect(interaction.reply).toHaveBeenCalledWith(
        expect.objectContaining({
          content: expect.stringContaining("full"),
          ephemeral: true,
        }),
      );

      await shutdown();
    });

    it("/session should switch to named session", async () => {
      const { handleInteraction, shutdown } = await setupPlugin();

      const interaction = createSlashInteraction("session", { name: "research" });
      await handleInteraction(interaction);

      expect(interaction.reply).toHaveBeenCalledWith(
        expect.objectContaining({
          content: expect.stringContaining("research"),
        }),
      );

      await shutdown();
    });

    it("/wopr should send message to AI and reply", async () => {
      const { handleInteraction, ctx, shutdown } = await setupPlugin({ injectResponse: "Hello from AI" });

      const interaction = createSlashInteraction("wopr", { message: "Tell me a joke" });
      await handleInteraction(interaction);

      // Should defer reply first
      expect(interaction.deferReply).toHaveBeenCalled();

      // Then inject and edit reply
      await vi.advanceTimersByTimeAsync(200);
      expect(ctx.inject).toHaveBeenCalledWith(
        expect.any(String),
        "Tell me a joke",
        expect.any(Object),
      );
      expect(interaction.editReply).toHaveBeenCalled();

      await shutdown();
    });

    it("/help should show all commands", async () => {
      const { handleInteraction, shutdown } = await setupPlugin();

      const interaction = createSlashInteraction("help");
      await handleInteraction(interaction);

      const replyArgs = (interaction.reply as ReturnType<typeof vi.fn>).mock.calls[0][0];
      const content = replyArgs.content as string;

      // Should list all command names
      expect(content).toContain("/status");
      expect(content).toContain("/new");
      expect(content).toContain("/compact");
      expect(content).toContain("/think");
      expect(content).toContain("/verbose");
      expect(content).toContain("/usage");
      expect(content).toContain("/model");
      expect(content).toContain("/cancel");
      expect(content).toContain("/session");
      expect(content).toContain("/wopr");
      expect(content).toContain("/claim");
      expect(content).toContain("/help");
      expect(replyArgs.ephemeral).toBe(true);

      await shutdown();
    });

    it("/claim should reject outside of DMs", async () => {
      const { handleInteraction, shutdown } = await setupPlugin();

      // Non-DM channel (type 0 = GuildText)
      const channel = createMockTextChannel({ id: "guild-ch-1", type: 0 });
      const interaction = createSlashInteraction("claim", { code: "ABC123" }, { channel, channelId: channel.id });
      await handleInteraction(interaction);

      expect(interaction.reply).toHaveBeenCalledWith(
        expect.objectContaining({
          content: expect.stringContaining("only works in DMs"),
          ephemeral: true,
        }),
      );

      await shutdown();
    });

    it("/cancel should cancel current processing", async () => {
      const { handleInteraction, shutdown } = await setupPlugin();

      const interaction = createSlashInteraction("cancel");
      await handleInteraction(interaction);

      // No active processing, should say "nothing to cancel"
      expect(interaction.reply).toHaveBeenCalledWith(
        expect.objectContaining({
          content: expect.stringContaining("Nothing to cancel"),
          ephemeral: true,
        }),
      );

      await shutdown();
    });
  });

  // =========================================================================
  // Model resolution cascade
  // =========================================================================

  describe("Model resolution cascade", () => {
    const testModels = [
      { provider: "anthropic", id: "claude-opus-4-6", name: "Opus 4.6" },
      { provider: "anthropic", id: "claude-sonnet-4-5-20250929", name: "Sonnet 4.5" },
      { provider: "anthropic", id: "claude-haiku-4-5-20251001", name: "Haiku 4.5" },
      { provider: "openai", id: "gpt-5.2", name: "GPT 5.2" },
    ];

    it("/model with exact ID should resolve directly", async () => {
      const { handleInteraction, shutdown } = await setupPlugin({ providerModels: testModels });

      const interaction = createSlashInteraction("model", { model: "claude-opus-4-6" });
      await handleInteraction(interaction);

      await vi.advanceTimersByTimeAsync(100);

      expect(interaction.reply).toHaveBeenCalledWith(
        expect.objectContaining({
          content: expect.stringContaining("Model switched"),
        }),
      );

      await shutdown();
    });

    it("/model with partial match should resolve", async () => {
      const { handleInteraction, shutdown } = await setupPlugin({ providerModels: testModels });

      const interaction = createSlashInteraction("model", { model: "opus" });
      await handleInteraction(interaction);

      await vi.advanceTimersByTimeAsync(100);

      // "opus" should match "claude-opus-4-6" via substring of model ID
      expect(interaction.reply).toHaveBeenCalledWith(
        expect.objectContaining({
          content: expect.stringContaining("Model switched"),
        }),
      );

      await shutdown();
    });

    it("/model resolution should be case-insensitive", async () => {
      const { handleInteraction, shutdown } = await setupPlugin({ providerModels: testModels });

      const interaction = createSlashInteraction("model", { model: "OPUS" });
      await handleInteraction(interaction);

      await vi.advanceTimersByTimeAsync(100);

      expect(interaction.reply).toHaveBeenCalledWith(
        expect.objectContaining({
          content: expect.stringContaining("Model switched"),
        }),
      );

      await shutdown();
    });

    it("/model with unknown model should show available models", async () => {
      const { handleInteraction, shutdown } = await setupPlugin({ providerModels: testModels });

      const interaction = createSlashInteraction("model", { model: "nonexistent-model-xyz" });
      await handleInteraction(interaction);

      expect(interaction.reply).toHaveBeenCalledWith(
        expect.objectContaining({
          content: expect.stringContaining("Unknown model"),
          ephemeral: true,
        }),
      );

      await shutdown();
    });

    it("/model with no available models should report gracefully", async () => {
      // No models configured
      const { handleInteraction, shutdown } = await setupPlugin({ providerModels: [] });

      const interaction = createSlashInteraction("model", { model: "opus" });
      await handleInteraction(interaction);

      expect(interaction.reply).toHaveBeenCalledWith(
        expect.objectContaining({
          content: expect.stringContaining("Unknown model"),
          ephemeral: true,
        }),
      );

      await shutdown();
    });
  });

  // =========================================================================
  // Dynamic handler delegation
  // =========================================================================

  describe("Dynamic handler delegation", () => {
    it("should delegate unknown commands to registered channel commands", async () => {
      const { handleInteraction, ctx, shutdown } = await setupPlugin();

      // Register a channel command via the provider
      const handlerFn = vi.fn().mockResolvedValue(undefined);

      // Get the channel provider that was registered
      const registerCall = (ctx.registerChannelProvider as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(registerCall).toBeDefined();

      const channelProvider = registerCall[0];

      // Register a custom command
      channelProvider.registerCommand({
        name: "custom-cmd",
        description: "A custom command",
        handler: handlerFn,
      });

      // Create interaction for the registered command
      const interaction = createSlashInteraction("custom-cmd", {}, {
        options: {
          getString: vi.fn().mockReturnValue(null),
          getBoolean: vi.fn().mockReturnValue(null),
          getInteger: vi.fn().mockReturnValue(null),
          getNumber: vi.fn().mockReturnValue(null),
          data: [],
        },
      });
      await handleInteraction(interaction);

      // The handler should have been called
      expect(handlerFn).toHaveBeenCalled();

      await shutdown();
    });

    it("should acknowledge if registered handler doesn't reply", async () => {
      const { handleInteraction, ctx, shutdown } = await setupPlugin();

      const silentHandler = vi.fn().mockResolvedValue(undefined);

      const registerCall = (ctx.registerChannelProvider as ReturnType<typeof vi.fn>).mock.calls[0];
      const channelProvider = registerCall[0];
      channelProvider.registerCommand({
        name: "silent-cmd",
        description: "Silent command",
        handler: silentHandler,
      });

      const interaction = createSlashInteraction("silent-cmd", {}, {
        options: {
          getString: vi.fn().mockReturnValue(null),
          getBoolean: vi.fn().mockReturnValue(null),
          getInteger: vi.fn().mockReturnValue(null),
          getNumber: vi.fn().mockReturnValue(null),
          data: [],
        },
      });
      await handleInteraction(interaction);

      // Should send default acknowledgment since handler didn't reply
      expect(interaction.reply).toHaveBeenCalledWith(
        expect.objectContaining({
          content: expect.stringContaining("Command executed"),
          ephemeral: true,
        }),
      );

      await shutdown();
    });
  });

  // =========================================================================
  // Autocomplete with 25-choice limit
  // =========================================================================

  describe("Autocomplete", () => {
    it("should return up to 25 model choices on autocomplete", async () => {
      // Create 30 models to test the limit
      const manyModels = Array.from({ length: 30 }, (_, i) => ({
        provider: "anthropic",
        id: `model-${i}`,
        name: `Model ${i}`,
      }));

      const { handleInteraction, shutdown } = await setupPlugin({ providerModels: manyModels });

      // Create an autocomplete interaction
      const respondFn = vi.fn().mockResolvedValue(undefined);
      const autocompleteInteraction = {
        isAutocomplete: () => true,
        isChatInputCommand: () => false,
        isButton: () => false,
        commandName: "model",
        options: {
          getFocused: vi.fn().mockReturnValue(""),
        },
        respond: respondFn,
      };

      await handleInteraction(autocompleteInteraction);

      expect(respondFn).toHaveBeenCalled();
      const choices = respondFn.mock.calls[0][0];
      expect(choices.length).toBeLessThanOrEqual(25);

      await shutdown();
    });

    it("should filter autocomplete results based on focused value", async () => {
      const testModels = [
        { provider: "anthropic", id: "claude-opus-4-6", name: "Opus 4.6" },
        { provider: "anthropic", id: "claude-sonnet-4-5-20250929", name: "Sonnet 4.5" },
        { provider: "openai", id: "gpt-5.2", name: "GPT 5.2" },
      ];

      const { handleInteraction, shutdown } = await setupPlugin({ providerModels: testModels });

      const respondFn = vi.fn().mockResolvedValue(undefined);
      const autocompleteInteraction = {
        isAutocomplete: () => true,
        isChatInputCommand: () => false,
        isButton: () => false,
        commandName: "model",
        options: {
          getFocused: vi.fn().mockReturnValue("opus"),
        },
        respond: respondFn,
      };

      await handleInteraction(autocompleteInteraction);

      expect(respondFn).toHaveBeenCalled();
      const choices = respondFn.mock.calls[0][0];
      // Only opus model should match
      expect(choices.length).toBe(1);
      expect(choices[0].value).toBe("claude-opus-4-6");

      await shutdown();
    });
  });

  // =========================================================================
  // Session override persistence
  // =========================================================================

  describe("Session override persistence", () => {
    it("should persist thinking level across commands", async () => {
      const { handleInteraction, shutdown } = await setupPlugin();

      // Set thinking level
      const thinkInteraction = createSlashInteraction("think", { level: "high" });
      await handleInteraction(thinkInteraction);

      // Check status - should show the updated thinking level
      const statusInteraction = createSlashInteraction("status");
      await handleInteraction(statusInteraction);

      const statusContent = (statusInteraction.reply as ReturnType<typeof vi.fn>).mock.calls[0][0].content as string;
      expect(statusContent).toContain("high");

      await shutdown();
    });

    it("should persist verbose mode across commands", async () => {
      const { handleInteraction, shutdown } = await setupPlugin();

      // Enable verbose
      const verboseInteraction = createSlashInteraction("verbose", { enabled: true });
      await handleInteraction(verboseInteraction);

      // Check status
      const statusInteraction = createSlashInteraction("status");
      await handleInteraction(statusInteraction);

      const statusContent = (statusInteraction.reply as ReturnType<typeof vi.fn>).mock.calls[0][0].content as string;
      expect(statusContent).toContain("On");

      await shutdown();
    });

    it("should persist usage mode across commands", async () => {
      const { handleInteraction, shutdown } = await setupPlugin();

      // Set usage mode
      const usageInteraction = createSlashInteraction("usage", { mode: "full" });
      await handleInteraction(usageInteraction);

      // Check status
      const statusInteraction = createSlashInteraction("status");
      await handleInteraction(statusInteraction);

      const statusContent = (statusInteraction.reply as ReturnType<typeof vi.fn>).mock.calls[0][0].content as string;
      expect(statusContent).toContain("full");

      await shutdown();
    });

    it("should inject thinking level context when not medium", async () => {
      const { handleInteraction, ctx, shutdown } = await setupPlugin({ injectResponse: "Thought deeply" });

      // Set thinking to high
      const thinkInteraction = createSlashInteraction("think", { level: "high" });
      await handleInteraction(thinkInteraction);

      // Send a /wopr message
      const woprInteraction = createSlashInteraction("wopr", { message: "What is life?" });
      await handleInteraction(woprInteraction);

      await vi.advanceTimersByTimeAsync(200);

      // inject should include thinking level prefix
      const injectCalls = (ctx.inject as ReturnType<typeof vi.fn>).mock.calls;
      const woprCall = injectCalls.find((c: any[]) => (c[1] as string).includes("What is life"));
      expect(woprCall).toBeDefined();
      expect(woprCall![1]).toContain("[Thinking level: high]");

      await shutdown();
    });

    it("/new should reset session state to defaults", async () => {
      const { handleInteraction, shutdown } = await setupPlugin();

      // Change some settings
      await handleInteraction(createSlashInteraction("think", { level: "xhigh" }));
      await handleInteraction(createSlashInteraction("verbose", { enabled: true }));

      // Reset
      await handleInteraction(createSlashInteraction("new"));

      // Check status - should show defaults
      const statusInteraction = createSlashInteraction("status");
      await handleInteraction(statusInteraction);

      const statusContent = (statusInteraction.reply as ReturnType<typeof vi.fn>).mock.calls[0][0].content as string;
      expect(statusContent).toContain("medium"); // default thinking
      expect(statusContent).toContain("Off"); // default verbose

      await shutdown();
    });
  });

  // =========================================================================
  // Input validation (WOP-585)
  // =========================================================================

  describe("Input validation (WOP-585)", () => {
    it("/session should reject names with path traversal characters", async () => {
      const { handleInteraction, shutdown } = await setupPlugin();
      const interaction = createSlashInteraction("session", { name: "../../../etc/passwd" });
      await handleInteraction(interaction);
      expect(interaction.reply).toHaveBeenCalledWith(
        expect.objectContaining({
          content: expect.stringContaining("Invalid session name"),
          ephemeral: true,
        }),
      );
      await shutdown();
    });

    it("/claim should reject codes with special characters", async () => {
      const { handleInteraction, shutdown } = await setupPlugin();
      const channel = createMockTextChannel({ id: "dm-ch", type: 1 }); // DM
      const interaction = createSlashInteraction("claim", { code: "ABC!@#$" }, { channel, channelId: channel.id });
      await handleInteraction(interaction);
      expect(interaction.reply).toHaveBeenCalledWith(
        expect.objectContaining({
          content: expect.stringContaining("Invalid pairing code"),
          ephemeral: true,
        }),
      );
      await shutdown();
    });

    it("/model should reject model names with shell metacharacters", async () => {
      const { handleInteraction, shutdown } = await setupPlugin();
      const interaction = createSlashInteraction("model", { model: "opus$(whoami)" });
      await handleInteraction(interaction);
      expect(interaction.reply).toHaveBeenCalledWith(
        expect.objectContaining({
          content: expect.stringContaining("Invalid model name"),
          ephemeral: true,
        }),
      );
      await shutdown();
    });

    it("/wopr should reject empty messages after sanitization", async () => {
      const { handleInteraction, shutdown } = await setupPlugin();
      // A string of only control characters, after sanitize() becomes empty
      const interaction = createSlashInteraction("wopr", { message: "\x00\x01\x02" });
      await handleInteraction(interaction);
      expect(interaction.reply).toHaveBeenCalledWith(
        expect.objectContaining({
          content: expect.stringContaining("empty"),
          ephemeral: true,
        }),
      );
      await shutdown();
    });
  });
});
