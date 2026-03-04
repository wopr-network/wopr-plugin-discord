import { describe, it, expect, vi, afterEach } from "vitest";
import {
  isFriendRequestButton,
  parseButtonCustomId,
  handleFriendButtonInteraction,
  createFriendRequestButtons,
  createFriendRequestEmbed,
  getOwnerUserId,
} from "../src/friend-buttons.js";
import { createMockContext } from "./mocks/wopr-context.js";

describe("isFriendRequestButton", () => {
  it("returns true for friend_accept: prefix", () => {
    expect(isFriendRequestButton("friend_accept:alice")).toBe(true);
  });

  it("returns true for friend_deny: prefix", () => {
    expect(isFriendRequestButton("friend_deny:alice")).toBe(true);
  });

  it("returns false for unrelated custom IDs", () => {
    expect(isFriendRequestButton("some_other_button")).toBe(false);
    expect(isFriendRequestButton("friend_")).toBe(false);
    expect(isFriendRequestButton("")).toBe(false);
  });
});

describe("parseButtonCustomId", () => {
  it("parses accept button", () => {
    expect(parseButtonCustomId("friend_accept:alice")).toEqual({
      action: "accept",
      from: "alice",
    });
  });

  it("parses deny button", () => {
    expect(parseButtonCustomId("friend_deny:bob")).toEqual({
      action: "deny",
      from: "bob",
    });
  });

  it("returns null for non-friend buttons", () => {
    expect(parseButtonCustomId("other:value")).toBeNull();
    expect(parseButtonCustomId("")).toBeNull();
  });
});

function createMockButtonInteraction(overrides: Record<string, any> = {}) {
  const channelId = overrides.channelId ?? "ch-1";
  return {
    customId: overrides.customId ?? "friend_accept:alice",
    user: { id: overrides.userId ?? "owner-123" },
    deferred: false,
    replied: false,
    message: { author: { id: "bot-id" }, id: "msg-1" },
    reply: vi.fn().mockResolvedValue(undefined),
    deferUpdate: vi.fn().mockResolvedValue(undefined),
    editReply: vi.fn().mockResolvedValue(undefined),
    followUp: vi.fn().mockResolvedValue(undefined),
    client: {
      user: { id: "bot-id" },
      channels: {
        cache: new Map([
          [channelId, { id: channelId, isTextBased: () => true, send: vi.fn().mockResolvedValue(undefined) }],
        ]),
      },
    },
    ...overrides,
  };
}

describe("handleFriendButtonInteraction", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("accepts a friend request via callback", async () => {
    const interaction = createMockButtonInteraction({ customId: "friend_accept:alice" });
    const ctx = createMockContext({ getConfig: vi.fn(() => ({ ownerUserId: "owner-123" })) });
    const onAccept = vi.fn().mockResolvedValue(undefined);
    const onDeny = vi.fn();

    await handleFriendButtonInteraction(interaction as any, ctx, onAccept, onDeny);

    expect(interaction.deferUpdate).toHaveBeenCalled();
    expect(onAccept).toHaveBeenCalled();
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("accepted"),
      }),
    );
    expect(ctx.log.info).toHaveBeenCalled();
  });

  it("denies a friend request via callback", async () => {
    const interaction = createMockButtonInteraction({ customId: "friend_deny:alice" });
    const ctx = createMockContext({ getConfig: vi.fn(() => ({ ownerUserId: "owner-123" })) });
    const onAccept = vi.fn();
    const onDeny = vi.fn().mockResolvedValue(undefined);

    await handleFriendButtonInteraction(interaction as any, ctx, onAccept, onDeny);

    expect(interaction.deferUpdate).toHaveBeenCalled();
    expect(onDeny).toHaveBeenCalled();
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("denied"),
      }),
    );
    expect(ctx.log.info).toHaveBeenCalled();
  });

  it("follows up with error when onAccept throws", async () => {
    const interaction = createMockButtonInteraction({ customId: "friend_accept:alice" });
    const ctx = createMockContext({ getConfig: vi.fn(() => ({ ownerUserId: "owner-123" })) });
    const onAccept = vi.fn().mockRejectedValue(new Error("network error"));
    const onDeny = vi.fn();

    await handleFriendButtonInteraction(interaction as any, ctx, onAccept, onDeny);

    expect(interaction.followUp).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("Failed to accept"),
        ephemeral: true,
      }),
    );
  });

  it("follows up with error when onDeny throws", async () => {
    const interaction = createMockButtonInteraction({ customId: "friend_deny:alice" });
    const ctx = createMockContext({ getConfig: vi.fn(() => ({ ownerUserId: "owner-123" })) });
    const onAccept = vi.fn();
    const onDeny = vi.fn().mockRejectedValue(new Error("db error"));

    await handleFriendButtonInteraction(interaction as any, ctx, onAccept, onDeny);

    expect(interaction.followUp).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("Failed to deny"),
        ephemeral: true,
      }),
    );
  });

  it("does nothing for non-friend button custom IDs", async () => {
    const interaction = createMockButtonInteraction({ customId: "other_button:xyz" });
    const ctx = createMockContext({ getConfig: vi.fn(() => ({ ownerUserId: "owner-123" })) });
    const onAccept = vi.fn();
    const onDeny = vi.fn();

    await handleFriendButtonInteraction(interaction as any, ctx, onAccept, onDeny);

    expect(interaction.reply).not.toHaveBeenCalled();
    expect(interaction.deferUpdate).not.toHaveBeenCalled();
    expect(onAccept).not.toHaveBeenCalled();
    expect(onDeny).not.toHaveBeenCalled();
  });

  it("rejects button from a message not authored by this bot", async () => {
    const interaction = createMockButtonInteraction({
      customId: "friend_accept:alice",
      message: { author: { id: "other-bot" }, id: "msg-1" },
    });
    const ctx = createMockContext({ getConfig: vi.fn(() => ({ ownerUserId: "owner-123" })) });
    const onAccept = vi.fn();
    const onDeny = vi.fn();

    await handleFriendButtonInteraction(interaction as any, ctx, onAccept, onDeny);

    expect(interaction.reply).toHaveBeenCalledWith({ content: "Unauthorized", ephemeral: true });
    expect(onAccept).not.toHaveBeenCalled();
  });

  it("rejects non-owner user", async () => {
    const interaction = createMockButtonInteraction({
      customId: "friend_accept:alice",
      userId: "stranger-456",
    });
    const ctx = createMockContext({ getConfig: vi.fn(() => ({ ownerUserId: "owner-123" })) });
    const onAccept = vi.fn();
    const onDeny = vi.fn();

    await handleFriendButtonInteraction(interaction as any, ctx, onAccept, onDeny);

    expect(interaction.reply).toHaveBeenCalledWith({ content: "Unauthorized", ephemeral: true });
    expect(onAccept).not.toHaveBeenCalled();
  });
});

describe("getOwnerUserId", () => {
  it("returns ownerUserId from config", () => {
    const ctx = createMockContext({
      getConfig: vi.fn(() => ({ ownerUserId: "owner-456" })),
    });
    expect(getOwnerUserId(ctx)).toBe("owner-456");
  });

  it("returns null when ownerUserId is not set", () => {
    const ctx = createMockContext({
      getConfig: vi.fn(() => ({})),
    });
    expect(getOwnerUserId(ctx)).toBeNull();
  });

  it("returns null when ownerUserId is empty string", () => {
    const ctx = createMockContext({
      getConfig: vi.fn(() => ({ ownerUserId: "" })),
    });
    expect(getOwnerUserId(ctx)).toBeNull();
  });
});

describe("createFriendRequestButtons", () => {
  it("returns an ActionRowBuilder with two buttons", () => {
    const row = createFriendRequestButtons("alice");
    expect(row).toBeDefined();
    expect(row.components).toHaveLength(2);
  });

  it("truncates long usernames to fit custom ID limit", () => {
    const longName = "a".repeat(100);
    const row = createFriendRequestButtons(longName);
    expect(row).toBeDefined();
  });
});

describe("createFriendRequestEmbed", () => {
  it("creates an embed with correct fields", () => {
    const embed = createFriendRequestEmbed("alice", "abc123", "#general");
    expect(embed).toBeDefined();
    const json = embed.toJSON();
    expect(json.title).toBe("Friend Request Received");
    expect(json.description).toContain("alice");
  });
});
