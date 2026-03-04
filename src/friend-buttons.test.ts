import type { ButtonInteraction } from "discord.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  handleFriendButtonInteraction,
  setMessageIdOnPendingButtonRequest,
  storePendingButtonRequest,
} from "./friend-buttons.js";
import type { WOPRPluginContext } from "./types.js";

// Minimal mock for WOPRPluginContext
function mockCtx(ownerUserId: string | null): WOPRPluginContext {
  return {
    getConfig: vi.fn(() => ({ ownerUserId: ownerUserId ?? undefined })),
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  } as unknown as WOPRPluginContext;
}

function mockInteraction(
  userId: string,
  customId: string,
  opts: { botId?: string; messageId?: string; messageAuthorId?: string } = {},
) {
  const reply = vi.fn().mockResolvedValue(undefined);
  const deferUpdate = vi.fn().mockResolvedValue(undefined);
  const editReply = vi.fn().mockResolvedValue(undefined);
  const followUp = vi.fn().mockResolvedValue(undefined);
  const botId = opts.botId ?? "bot-999";
  return {
    user: { id: userId },
    customId,
    deferred: false,
    replied: false,
    reply,
    deferUpdate,
    editReply,
    followUp,
    message: {
      id: opts.messageId ?? "msg-111",
      author: { id: opts.messageAuthorId ?? botId },
    },
    client: {
      user: { id: botId },
      channels: { cache: { get: vi.fn() } },
    },
  } as unknown as ButtonInteraction;
}

describe("handleFriendButtonInteraction owner authorization", () => {
  const onAccept = vi.fn().mockResolvedValue("Accepted!");
  const onDeny = vi.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    vi.clearAllMocks();
    // Store a pending request so the "expired" check doesn't fire
    expect(storePendingButtonRequest("alice", "a".repeat(64), "b".repeat(64), "chan-1", "sig-1")).toBeUndefined();
    // Bind the expected message ID to the pending request
    setMessageIdOnPendingButtonRequest("alice", "msg-111");
  });

  it("rejects non-owner with ephemeral Unauthorized", async () => {
    const ctx = mockCtx("owner-123");
    const interaction = mockInteraction("stranger-456", "friend_accept:alice");

    await handleFriendButtonInteraction(interaction, ctx, "bot", onAccept, onDeny);

    expect(interaction.reply).toHaveBeenCalledWith({
      content: "Unauthorized",
      ephemeral: true,
    });
    expect(onAccept).not.toHaveBeenCalled();
    expect(interaction.deferUpdate).not.toHaveBeenCalled();
  });

  it("rejects when no owner is configured", async () => {
    const ctx = mockCtx(null);
    const interaction = mockInteraction("anyone-789", "friend_deny:alice");

    await handleFriendButtonInteraction(interaction, ctx, "bot", onAccept, onDeny);

    expect(interaction.reply).toHaveBeenCalledWith({
      content: "Unauthorized",
      ephemeral: true,
    });
    expect(onDeny).not.toHaveBeenCalled();
  });

  it("allows owner to accept", async () => {
    const ctx = mockCtx("owner-123");
    const interaction = mockInteraction("owner-123", "friend_accept:alice");

    await handleFriendButtonInteraction(interaction, ctx, "bot", onAccept, onDeny);

    expect(interaction.reply).not.toHaveBeenCalled();
    expect(interaction.deferUpdate).toHaveBeenCalled();
    expect(onAccept).toHaveBeenCalledWith("alice", expect.any(Object));
  });

  it("allows owner to deny", async () => {
    const ctx = mockCtx("owner-123");
    const interaction = mockInteraction("owner-123", "friend_deny:alice");

    await handleFriendButtonInteraction(interaction, ctx, "bot", onAccept, onDeny);

    expect(interaction.reply).not.toHaveBeenCalled();
    expect(interaction.deferUpdate).toHaveBeenCalled();
    expect(onDeny).toHaveBeenCalledWith("alice");
  });
});

describe("handleFriendButtonInteraction button provenance", () => {
  const onAccept = vi.fn().mockResolvedValue("Accepted!");
  const onDeny = vi.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    vi.clearAllMocks();
    expect(storePendingButtonRequest("alice", "a".repeat(64), "b".repeat(64), "chan-1", "sig-1")).toBeUndefined();
    setMessageIdOnPendingButtonRequest("alice", "msg-111");
  });

  it("rejects button from a message not authored by this bot", async () => {
    const ctx = mockCtx("owner-123");
    // messageAuthorId differs from botId — button came from another bot/user
    const interaction = mockInteraction("owner-123", "friend_accept:alice", {
      botId: "bot-999",
      messageAuthorId: "other-bot-888",
      messageId: "msg-111",
    });

    await handleFriendButtonInteraction(interaction, ctx, "bot", onAccept, onDeny);

    expect(interaction.reply).toHaveBeenCalledWith({
      content: "Unauthorized",
      ephemeral: true,
    });
    expect(onAccept).not.toHaveBeenCalled();
  });

  it("rejects button whose message ID does not match the stored pending request", async () => {
    const ctx = mockCtx("owner-123");
    const interaction = mockInteraction("owner-123", "friend_accept:alice", {
      botId: "bot-999",
      messageAuthorId: "bot-999",
      messageId: "msg-DIFFERENT",
    });

    await handleFriendButtonInteraction(interaction, ctx, "bot", onAccept, onDeny);

    expect(interaction.reply).toHaveBeenCalledWith({
      content: "Unauthorized",
      ephemeral: true,
    });
    expect(onAccept).not.toHaveBeenCalled();
  });

  it("allows owner when button provenance and message ID are correct", async () => {
    const ctx = mockCtx("owner-123");
    const interaction = mockInteraction("owner-123", "friend_accept:alice", {
      botId: "bot-999",
      messageAuthorId: "bot-999",
      messageId: "msg-111",
    });

    await handleFriendButtonInteraction(interaction, ctx, "bot", onAccept, onDeny);

    expect(interaction.reply).not.toHaveBeenCalled();
    expect(interaction.deferUpdate).toHaveBeenCalled();
    expect(onAccept).toHaveBeenCalledWith("alice", expect.any(Object));
  });
});
