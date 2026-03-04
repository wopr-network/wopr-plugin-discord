import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  isFriendRequestButton,
  parseButtonCustomId,
  isValidEd25519Pubkey,
  storePendingButtonRequest,
  getPendingButtonRequest,
  removePendingButtonRequest,
  cleanupExpiredButtonRequests,
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

describe("isValidEd25519Pubkey", () => {
  const validKey = "a".repeat(64);

  it("accepts valid 64-char hex string", () => {
    expect(isValidEd25519Pubkey(validKey)).toBe(true);
    expect(isValidEd25519Pubkey("abcdef0123456789".repeat(4))).toBe(true);
  });

  it("rejects short strings", () => {
    expect(isValidEd25519Pubkey("abc")).toBe(false);
  });

  it("rejects 65-char strings", () => {
    expect(isValidEd25519Pubkey("a".repeat(65))).toBe(false);
  });

  it("rejects non-hex characters", () => {
    expect(isValidEd25519Pubkey("g".repeat(64))).toBe(false);
    expect(isValidEd25519Pubkey("z".repeat(64))).toBe(false);
  });

  it("rejects non-string input", () => {
    expect(isValidEd25519Pubkey(123 as any)).toBe(false);
    expect(isValidEd25519Pubkey(null as any)).toBe(false);
  });
});

describe("pending button request lifecycle", () => {
  const validPubkey = "a".repeat(64);
  const validEncryptPub = "b".repeat(64);

  afterEach(() => {
    removePendingButtonRequest("alice");
    removePendingButtonRequest("Bob");
  });

  describe("storePendingButtonRequest", () => {
    it("stores a valid request and returns undefined", () => {
      const result = storePendingButtonRequest("alice", validPubkey, validEncryptPub, "ch-1", "sig-1");
      expect(result).toBeUndefined();
    });

    it("returns error for invalid pubkey", () => {
      const result = storePendingButtonRequest("alice", "bad", validEncryptPub, "ch-1", "sig-1");
      expect(result).toBe("Invalid public key format (expected 64-char hex Ed25519 key)");
    });

    it("returns error for invalid encryptPub", () => {
      const result = storePendingButtonRequest("alice", validPubkey, "bad", "ch-1", "sig-1");
      expect(result).toBe("Invalid encryption public key format");
    });
  });

  describe("getPendingButtonRequest", () => {
    it("retrieves a stored request", () => {
      storePendingButtonRequest("alice", validPubkey, validEncryptPub, "ch-1", "sig-1");
      const pending = getPendingButtonRequest("alice");
      expect(pending).toBeDefined();
      expect(pending!.requestFrom).toBe("alice");
      expect(pending!.requestPubkey).toBe(validPubkey);
      expect(pending!.encryptPub).toBe(validEncryptPub);
      expect(pending!.channelId).toBe("ch-1");
      expect(pending!.signature).toBe("sig-1");
    });

    it("returns undefined for unknown request", () => {
      expect(getPendingButtonRequest("unknown")).toBeUndefined();
    });

    it("is case-insensitive", () => {
      storePendingButtonRequest("Bob", validPubkey, validEncryptPub, "ch-1", "sig-1");
      expect(getPendingButtonRequest("bob")).toBeDefined();
      expect(getPendingButtonRequest("BOB")).toBeDefined();
    });
  });

  describe("removePendingButtonRequest", () => {
    it("removes a stored request", () => {
      storePendingButtonRequest("alice", validPubkey, validEncryptPub, "ch-1", "sig-1");
      removePendingButtonRequest("alice");
      expect(getPendingButtonRequest("alice")).toBeUndefined();
    });

    it("is case-insensitive", () => {
      storePendingButtonRequest("Bob", validPubkey, validEncryptPub, "ch-1", "sig-1");
      removePendingButtonRequest("bob");
      expect(getPendingButtonRequest("Bob")).toBeUndefined();
    });

    it("does not throw for unknown key", () => {
      expect(() => removePendingButtonRequest("nonexistent")).not.toThrow();
    });
  });
});

describe("cleanupExpiredButtonRequests", () => {
  afterEach(() => {
    vi.useRealTimers();
    removePendingButtonRequest("alice");
    removePendingButtonRequest("bob");
  });

  it("removes requests older than 15 minutes", () => {
    vi.useFakeTimers();
    const validPubkey = "a".repeat(64);
    const validEncryptPub = "b".repeat(64);

    storePendingButtonRequest("alice", validPubkey, validEncryptPub, "ch-1", "sig-1");

    vi.advanceTimersByTime(16 * 60 * 1000);

    cleanupExpiredButtonRequests();
    expect(getPendingButtonRequest("alice")).toBeUndefined();
  });

  it("keeps requests younger than 15 minutes", () => {
    vi.useFakeTimers();
    const validPubkey = "a".repeat(64);
    const validEncryptPub = "b".repeat(64);

    storePendingButtonRequest("alice", validPubkey, validEncryptPub, "ch-1", "sig-1");

    vi.advanceTimersByTime(10 * 60 * 1000);

    cleanupExpiredButtonRequests();
    expect(getPendingButtonRequest("alice")).toBeDefined();
  });

  it("removes only expired requests, keeps fresh ones", () => {
    vi.useFakeTimers();
    const validPubkey = "a".repeat(64);
    const validEncryptPub = "b".repeat(64);

    storePendingButtonRequest("alice", validPubkey, validEncryptPub, "ch-1", "sig-1");

    vi.advanceTimersByTime(14 * 60 * 1000);
    storePendingButtonRequest("bob", validPubkey, validEncryptPub, "ch-2", "sig-2");

    vi.advanceTimersByTime(2 * 60 * 1000); // alice=16min, bob=2min

    cleanupExpiredButtonRequests();
    expect(getPendingButtonRequest("alice")).toBeUndefined();
    expect(getPendingButtonRequest("bob")).toBeDefined();
  });
});

function createMockButtonInteraction(overrides: Record<string, any> = {}) {
  const channelId = overrides.channelId ?? "ch-1";
  const channel = {
    id: channelId,
    isTextBased: () => true,
    send: vi.fn().mockResolvedValue(undefined),
  };
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
        cache: new Map([[channelId, channel]]),
      },
    },
    ...overrides,
  };
}

describe("handleFriendButtonInteraction", () => {
  const validPubkey = "a".repeat(64);
  const validEncryptPub = "b".repeat(64);

  afterEach(() => {
    removePendingButtonRequest("alice");
  });

  it("replies with expired message when no pending request exists", async () => {
    const interaction = createMockButtonInteraction({ customId: "friend_accept:alice" });
    const ctx = createMockContext({ getConfig: vi.fn(() => ({ ownerUserId: "owner-123" })) });
    const onAccept = vi.fn().mockResolvedValue("accepted");
    const onDeny = vi.fn();

    await handleFriendButtonInteraction(interaction as any, ctx, "bot", onAccept, onDeny);

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("expired or was already handled"),
        ephemeral: true,
      }),
    );
    expect(onAccept).not.toHaveBeenCalled();
  });

  it("accepts a friend request and removes pending entry", async () => {
    storePendingButtonRequest("alice", validPubkey, validEncryptPub, "ch-1", "sig-1");
    const interaction = createMockButtonInteraction({ customId: "friend_accept:alice" });
    const ctx = createMockContext({ getConfig: vi.fn(() => ({ ownerUserId: "owner-123" })) });
    const onAccept = vi.fn().mockResolvedValue("Welcome alice!");
    const onDeny = vi.fn();

    await handleFriendButtonInteraction(interaction as any, ctx, "bot", onAccept, onDeny);

    expect(interaction.deferUpdate).toHaveBeenCalled();
    expect(onAccept).toHaveBeenCalledWith("alice", expect.objectContaining({ requestFrom: "alice" }));
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("accepted"),
      }),
    );
    expect(getPendingButtonRequest("alice")).toBeUndefined();
    expect(ctx.log.info).toHaveBeenCalled();
  });

  it("sends accept message to the original channel", async () => {
    storePendingButtonRequest("alice", validPubkey, validEncryptPub, "ch-1", "sig-1");
    const interaction = createMockButtonInteraction({ customId: "friend_accept:alice" });
    const ctx = createMockContext({ getConfig: vi.fn(() => ({ ownerUserId: "owner-123" })) });
    const onAccept = vi.fn().mockResolvedValue("Welcome alice!");
    const onDeny = vi.fn();

    await handleFriendButtonInteraction(interaction as any, ctx, "bot", onAccept, onDeny);

    const channel = interaction.client.channels.cache.get("ch-1");
    expect(channel.send).toHaveBeenCalledWith("Welcome alice!");
  });

  it("denies a friend request and removes pending entry", async () => {
    storePendingButtonRequest("alice", validPubkey, validEncryptPub, "ch-1", "sig-1");
    const interaction = createMockButtonInteraction({ customId: "friend_deny:alice" });
    const ctx = createMockContext({ getConfig: vi.fn(() => ({ ownerUserId: "owner-123" })) });
    const onAccept = vi.fn();
    const onDeny = vi.fn().mockResolvedValue(undefined);

    await handleFriendButtonInteraction(interaction as any, ctx, "bot", onAccept, onDeny);

    expect(interaction.deferUpdate).toHaveBeenCalled();
    expect(onDeny).toHaveBeenCalledWith("alice");
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("denied"),
      }),
    );
    expect(getPendingButtonRequest("alice")).toBeUndefined();
  });

  it("follows up with error when onAccept throws", async () => {
    storePendingButtonRequest("alice", validPubkey, validEncryptPub, "ch-1", "sig-1");
    const interaction = createMockButtonInteraction({ customId: "friend_accept:alice" });
    const ctx = createMockContext({ getConfig: vi.fn(() => ({ ownerUserId: "owner-123" })) });
    const onAccept = vi.fn().mockRejectedValue(new Error("network error"));
    const onDeny = vi.fn();

    await handleFriendButtonInteraction(interaction as any, ctx, "bot", onAccept, onDeny);

    expect(interaction.followUp).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("Failed to accept"),
        ephemeral: true,
      }),
    );
  });

  it("follows up with error when onDeny throws", async () => {
    storePendingButtonRequest("alice", validPubkey, validEncryptPub, "ch-1", "sig-1");
    const interaction = createMockButtonInteraction({ customId: "friend_deny:alice" });
    const ctx = createMockContext({ getConfig: vi.fn(() => ({ ownerUserId: "owner-123" })) });
    const onAccept = vi.fn();
    const onDeny = vi.fn().mockRejectedValue(new Error("db error"));

    await handleFriendButtonInteraction(interaction as any, ctx, "bot", onAccept, onDeny);

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

    await handleFriendButtonInteraction(interaction as any, ctx, "bot", onAccept, onDeny);

    expect(interaction.reply).not.toHaveBeenCalled();
    expect(interaction.deferUpdate).not.toHaveBeenCalled();
    expect(onAccept).not.toHaveBeenCalled();
    expect(onDeny).not.toHaveBeenCalled();
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
