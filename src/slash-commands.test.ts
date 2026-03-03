import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock logger
vi.mock("./logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// Mock discord-utils to avoid instanceof checks
vi.mock("./discord-utils.js", () => ({
  getSessionKeyFromInteraction: vi.fn(() => "discord:test-guild:#general"),
  getSessionKey: vi.fn(() => "discord:test-guild:#general"),
  resolveMentions: vi.fn((msg: any) => msg.content),
}));

// Mock child_process to prevent real exec calls
vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));
vi.mock("node:util", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:util")>();
  return {
    ...actual,
    promisify: vi.fn(() => vi.fn().mockResolvedValue({ stdout: "", stderr: "" })),
  };
});

import { createMockClient, createMockContext, createMockInteraction } from "./__test-utils__/mocks.js";
import { ChannelQueueManager } from "./channel-queue.js";
import { commands, registerSlashCommands, SlashCommandHandler } from "./slash-commands.js";
import type { ChannelCommand } from "./types.js";

describe("commands array", () => {
  it("should define expected slash commands", () => {
    const names = commands.map((c) => c.name);
    expect(names).toContain("status");
    expect(names).toContain("new");
    expect(names).toContain("reset");
    expect(names).toContain("help");
    expect(names).toContain("model");
    expect(names).toContain("think");
    expect(names).toContain("wopr");
    expect(names).toContain("cancel");
    expect(names).toContain("claim");
    expect(names).toContain("session");
    expect(names).toContain("verbose");
    expect(names).toContain("usage");
    expect(names).toContain("compact");
  });
});

describe("SlashCommandHandler", () => {
  let handler: SlashCommandHandler;
  let client: any;
  let ctx: any;
  let queueManager: ChannelQueueManager;
  let getRegisteredCommand: ReturnType<typeof vi.fn>;
  let claimOwnership: ReturnType<typeof vi.fn>;
  let hasOwner: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    client = createMockClient();
    ctx = createMockContext({
      providers: {
        anthropic: {
          supportedModels: ["claude-sonnet-4-20250514", "claude-opus-4-20250514"],
        },
        openai: { supportedModels: ["gpt-4o"] },
      },
    });
    queueManager = new ChannelQueueManager(vi.fn().mockResolvedValue(undefined));
    getRegisteredCommand = vi.fn().mockReturnValue(undefined);
    claimOwnership = vi.fn().mockResolvedValue({ success: true });
    hasOwner = vi.fn().mockReturnValue(false);

    handler = new SlashCommandHandler(
      () => client,
      ctx,
      queueManager,
      getRegisteredCommand as (name: string) => ChannelCommand | undefined,
      claimOwnership as (
        code: string,
        sourceId?: string,
        claimingUserId?: string,
      ) => Promise<{ success: boolean; userId?: string; username?: string; error?: string }>,
      hasOwner as () => boolean,
    );
  });

  afterEach(() => {
    queueManager.stopProcessing();
  });

  describe("handle - /help", () => {
    it("should reply with help text listing commands", async () => {
      const interaction = createMockInteraction({ commandName: "help" });
      await handler.handle(interaction);
      expect(interaction.reply).toHaveBeenCalledTimes(1);
      const replyArg = interaction.reply.mock.calls[0][0];
      expect(replyArg.content).toContain("WOPR Discord Commands");
      expect(replyArg.ephemeral).toBe(true);
    });
  });

  describe("handle - /status", () => {
    it("should reply with session status info", async () => {
      const interaction = createMockInteraction({ commandName: "status" });
      await handler.handle(interaction);
      expect(interaction.reply).toHaveBeenCalledTimes(1);
      const replyArg = interaction.reply.mock.calls[0][0];
      expect(replyArg.content).toContain("Session Status");
      expect(replyArg.content).toContain("Thinking Level");
      expect(replyArg.ephemeral).toBe(true);
    });
  });

  describe("handle - /new and /reset", () => {
    it("should reset session state on /new", async () => {
      const interaction = createMockInteraction({ commandName: "new" });
      await handler.handle(interaction);
      expect(interaction.reply).toHaveBeenCalledTimes(1);
      const replyArg = interaction.reply.mock.calls[0][0];
      expect(replyArg.content).toContain("Session Reset");
    });

    it("should reset session state on /reset", async () => {
      const interaction = createMockInteraction({ commandName: "reset" });
      await handler.handle(interaction);
      const replyArg = interaction.reply.mock.calls[0][0];
      expect(replyArg.content).toContain("Session Reset");
    });
  });

  describe("handle - /think", () => {
    it("should set thinking level to the specified value", async () => {
      const interaction = createMockInteraction({
        commandName: "think",
        options: { level: "high" },
      });
      await handler.handle(interaction);
      const replyArg = interaction.reply.mock.calls[0][0];
      expect(replyArg.content).toContain("high");
    });

    it("should reject invalid thinking level", async () => {
      const interaction = createMockInteraction({
        commandName: "think",
        options: { level: "invalid" },
      });
      await handler.handle(interaction);
      const replyArg = interaction.reply.mock.calls[0][0];
      expect(replyArg.content).toContain("Invalid thinking level");
    });
  });

  describe("handle - /verbose", () => {
    it("should enable verbose mode", async () => {
      const interaction = createMockInteraction({
        commandName: "verbose",
        options: { enabled: true },
      });
      await handler.handle(interaction);
      const replyArg = interaction.reply.mock.calls[0][0];
      expect(replyArg.content).toContain("Verbose mode enabled");
    });

    it("should disable verbose mode", async () => {
      const interaction = createMockInteraction({
        commandName: "verbose",
        options: { enabled: false },
      });
      await handler.handle(interaction);
      const replyArg = interaction.reply.mock.calls[0][0];
      expect(replyArg.content).toContain("Verbose mode disabled");
    });
  });

  describe("handle - /usage", () => {
    it("should set usage mode", async () => {
      const interaction = createMockInteraction({
        commandName: "usage",
        options: { mode: "full" },
      });
      await handler.handle(interaction);
      const replyArg = interaction.reply.mock.calls[0][0];
      expect(replyArg.content).toContain("full");
    });

    it("should reject invalid usage mode", async () => {
      const interaction = createMockInteraction({
        commandName: "usage",
        options: { mode: "invalid" },
      });
      await handler.handle(interaction);
      const replyArg = interaction.reply.mock.calls[0][0];
      expect(replyArg.content).toContain("Invalid usage mode");
    });
  });

  describe("handle - /session", () => {
    it("should switch to a named session", async () => {
      const interaction = createMockInteraction({
        commandName: "session",
        options: { name: "my-session" },
      });
      await handler.handle(interaction);
      const replyArg = interaction.reply.mock.calls[0][0];
      expect(replyArg.content).toContain("my-session");
    });

    it("should reject invalid session name with special characters", async () => {
      const interaction = createMockInteraction({
        commandName: "session",
        options: { name: "bad name!" },
      });
      await handler.handle(interaction);
      const replyArg = interaction.reply.mock.calls[0][0];
      expect(replyArg.content).toContain("Invalid session name");
    });
  });

  describe("handle - /model", () => {
    it("should resolve and switch to a known model by partial name", async () => {
      ctx.setSessionProvider = vi.fn().mockResolvedValue(undefined);
      (ctx as any).setSessionProvider = vi.fn().mockResolvedValue(undefined);
      const interaction = createMockInteraction({
        commandName: "model",
        options: { model: "sonnet" },
      });
      await handler.handle(interaction);
      const replyArg = interaction.reply.mock.calls[0][0];
      expect(replyArg.content).toContain("Model switched to");
    });

    it("should show available models when model is unknown", async () => {
      const interaction = createMockInteraction({
        commandName: "model",
        options: { model: "nonexistent-model-xyz" },
      });
      await handler.handle(interaction);
      const replyArg = interaction.reply.mock.calls[0][0];
      expect(replyArg.content).toContain("Unknown model");
      expect(replyArg.content).toContain("Available models");
    });

    it("should reject invalid model name with special characters", async () => {
      const interaction = createMockInteraction({
        commandName: "model",
        options: { model: "model with spaces!" },
      });
      await handler.handle(interaction);
      const replyArg = interaction.reply.mock.calls[0][0];
      expect(replyArg.content).toContain("Invalid model name");
    });
  });

  describe("handle - /cancel", () => {
    it("should reply nothing to cancel when nothing is running", async () => {
      const interaction = createMockInteraction({ commandName: "cancel" });
      await handler.handle(interaction);
      const replyArg = interaction.reply.mock.calls[0][0];
      expect(replyArg.content).toContain("Nothing to cancel");
    });

    it("should reply cancelled when cancelInject succeeds", async () => {
      ctx.cancelInject.mockReturnValue(true);
      const interaction = createMockInteraction({ commandName: "cancel" });
      await handler.handle(interaction);
      const replyArg = interaction.reply.mock.calls[0][0];
      expect(replyArg.content).toContain("Cancelled");
    });
  });

  describe("handle - /claim", () => {
    it("should reject claim outside DM", async () => {
      const interaction = createMockInteraction({
        commandName: "claim",
        channelType: 0, // guild text
        options: { code: "ABCD1234" },
      });
      await handler.handle(interaction);
      const replyArg = interaction.reply.mock.calls[0][0];
      expect(replyArg.content).toContain("only works in DMs");
    });

    it("should reject claim when owner already exists", async () => {
      hasOwner.mockReturnValue(true);
      const interaction = createMockInteraction({
        commandName: "claim",
        channelType: 1, // DM
        options: { code: "ABCD1234" },
      });
      await handler.handle(interaction);
      const replyArg = interaction.reply.mock.calls[0][0];
      expect(replyArg.content).toContain("already has an owner");
    });

    it("should successfully claim ownership with valid code", async () => {
      // pairingCodeSchema allows [A-Z2-9] — no 0 or 1 digits allowed
      const interaction = createMockInteraction({
        commandName: "claim",
        channelType: 1,
        options: { code: "ABCD2345" },
      });
      await handler.handle(interaction);
      const replyArg = interaction.reply.mock.calls[0][0];
      expect(replyArg.content).toContain("Ownership claimed");
      expect(claimOwnership).toHaveBeenCalledWith("ABCD2345", "user-1", "user-1");
    });
  });

  describe("handle - /wopr", () => {
    it("should defer reply and inject message to WOPR", async () => {
      const interaction = createMockInteraction({
        commandName: "wopr",
        options: { message: "Tell me about AI" },
      });
      await handler.handle(interaction);
      expect(interaction.deferReply).toHaveBeenCalled();
      expect(ctx.inject).toHaveBeenCalled();
      expect(interaction.editReply).toHaveBeenCalled();
    });

    it("should reject empty wopr message", async () => {
      const interaction = createMockInteraction({
        commandName: "wopr",
        options: { message: "" },
      });
      await handler.handle(interaction);
      const replyArg = interaction.reply.mock.calls[0][0];
      expect(replyArg.content).toContain("Message cannot be empty");
    });
  });

  describe("handle - unknown command (registered command dispatch)", () => {
    it("should dispatch to registered channel command", async () => {
      const cmdHandler = vi.fn().mockResolvedValue(undefined);
      getRegisteredCommand.mockReturnValue({ handler: cmdHandler });
      const interaction = createMockInteraction({
        commandName: "custom-cmd",
        options: { arg1: "value1" },
      });
      await handler.handle(interaction);
      expect(cmdHandler).toHaveBeenCalledTimes(1);
      const cmdCtx = cmdHandler.mock.calls[0][0];
      expect(cmdCtx.args).toContain("value1");
      expect(cmdCtx.channelType).toBe("discord");
    });

    it("should show 'Command executed' if registered handler does not reply", async () => {
      const cmdHandler = vi.fn().mockResolvedValue(undefined);
      getRegisteredCommand.mockReturnValue({ handler: cmdHandler });
      const interaction = createMockInteraction({ commandName: "custom-cmd" });
      await handler.handle(interaction);
      expect(interaction.reply).toHaveBeenCalledWith(
        expect.objectContaining({
          content: expect.stringContaining("Command executed"),
        }),
      );
    });
  });

  describe("handleAutocomplete", () => {
    it("should return matching models for /model autocomplete", async () => {
      const interaction = createMockInteraction({
        commandName: "model",
        options: { _focused: "son" },
      });
      interaction.commandName = "model";
      await handler.handleAutocomplete(interaction);
      expect(interaction.respond).toHaveBeenCalledTimes(1);
      const choices = interaction.respond.mock.calls[0][0];
      expect(choices.length).toBeGreaterThan(0);
      expect(choices.some((c: any) => c.value.includes("sonnet"))).toBe(true);
    });

    it("should return all models when focused value is empty", async () => {
      const interaction = createMockInteraction({
        commandName: "model",
        options: { _focused: "" },
      });
      interaction.commandName = "model";
      await handler.handleAutocomplete(interaction);
      expect(interaction.respond).toHaveBeenCalledTimes(1);
      const choices = interaction.respond.mock.calls[0][0];
      // Should include all models (anthropic: 2 + openai: 1 = 3)
      expect(choices.length).toBe(3);
    });
  });

  describe("handle - returns early if getClient() is null", () => {
    it("should do nothing when client is null", async () => {
      const nullHandler = new SlashCommandHandler(
        () => null,
        ctx,
        queueManager,
        getRegisteredCommand as (name: string) => ChannelCommand | undefined,
        claimOwnership as (
          code: string,
          sourceId?: string,
          claimingUserId?: string,
        ) => Promise<{ success: boolean; userId?: string; username?: string; error?: string }>,
        hasOwner as () => boolean,
      );
      const interaction = createMockInteraction({ commandName: "help" });
      await nullHandler.handle(interaction);
      expect(interaction.reply).not.toHaveBeenCalled();
    });
  });
});

describe("registerSlashCommands", () => {
  it("should be exported as a function", () => {
    expect(typeof registerSlashCommands).toBe("function");
  });
});
