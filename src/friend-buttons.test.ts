import type { ButtonInteraction } from "discord.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleFriendButtonInteraction, storePendingButtonRequest } from "./friend-buttons.js";

// Minimal mock for WOPRPluginContext
function mockCtx(ownerUserId: string | null) {
  return {
    getConfig: vi.fn(() => ({ ownerUserId: ownerUserId ?? undefined })),
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  } as any;
}

function mockInteraction(userId: string, customId: string) {
  const reply = vi.fn().mockResolvedValue(undefined);
  const deferUpdate = vi.fn().mockResolvedValue(undefined);
  const editReply = vi.fn().mockResolvedValue(undefined);
  const followUp = vi.fn().mockResolvedValue(undefined);
  return {
    user: { id: userId },
    customId,
    reply,
    deferUpdate,
    editReply,
    followUp,
    client: { channels: { cache: { get: vi.fn() } } },
  } as unknown as ButtonInteraction;
}

describe("handleFriendButtonInteraction owner authorization", () => {
  const onAccept = vi.fn().mockResolvedValue("Accepted!");
  const onDeny = vi.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    vi.clearAllMocks();
    // Store a pending request so the "expired" check doesn't fire
    storePendingButtonRequest("alice", "a".repeat(64), "b".repeat(64), "chan-1", "sig-1");
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

    // Re-store since previous test may have consumed it
    storePendingButtonRequest("alice", "a".repeat(64), "b".repeat(64), "chan-1", "sig-1");

    await handleFriendButtonInteraction(interaction, ctx, "bot", onAccept, onDeny);

    expect(interaction.reply).not.toHaveBeenCalled();
    expect(interaction.deferUpdate).toHaveBeenCalled();
    expect(onDeny).toHaveBeenCalledWith("alice");
  });
});
