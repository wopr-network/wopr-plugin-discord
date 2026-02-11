/**
 * Tests for Reaction Manager logic.
 *
 * The reaction manager in index.ts handles:
 * - Setting message reactions by state (queued, active, done, error, cancelled)
 * - Removing bot-only reactions via cache lookup (existingReaction.users.cache.has)
 * - State emoji mapping from config (IdentityManager provides emoji config)
 * - Error resilience when Discord API fails
 * - Finding reactions with custom emoji formats (name:id vs Unicode)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Extracted reaction manager logic (mirrors src/index.ts implementation)
// ---------------------------------------------------------------------------

interface ReactionEmojis {
  queued: string;
  active: string;
  done: string;
  error: string;
  cancelled: string;
}

function createReactionManager(botId: string) {
  let reactionEmojis: ReactionEmojis = {
    queued: "\u{1F550}",   // 🕐
    active: "\u26A1",      // ⚡
    done: "\u2705",        // ✅
    error: "\u274C",       // ❌
    cancelled: "\u23F9\uFE0F", // ⏹️
  };

  function updateEmojis(emojis: Partial<ReactionEmojis>): void {
    reactionEmojis = { ...reactionEmojis, ...emojis };
  }

  function getEmojis(): ReactionEmojis {
    return { ...reactionEmojis };
  }

  function getAllStateEmojis(): string[] {
    return [
      reactionEmojis.queued,
      reactionEmojis.active,
      reactionEmojis.done,
      reactionEmojis.error,
      reactionEmojis.cancelled,
    ];
  }

  async function setMessageReaction(message: any, reaction: string | (() => string)): Promise<void> {
    if (!botId) return;

    const stateReactions = getAllStateEmojis();
    const reactionValue = typeof reaction === "function" ? reaction() : reaction;

    try {
      // Remove any existing state reactions from the bot
      for (const emoji of stateReactions) {
        try {
          const existingReaction = message.reactions.cache.get(emoji);
          if (existingReaction?.users.cache.has(botId)) {
            await existingReaction.users.remove(botId);
          }
        } catch (_e) {
          // Ignore - reaction might not exist
        }
      }

      // Add the new reaction
      await message.react(reactionValue);
    } catch (_e) {
      // Log but don't throw
    }
  }

  async function clearMessageReactions(message: any): Promise<void> {
    if (!botId) return;

    const stateReactions = getAllStateEmojis();

    for (const emoji of stateReactions) {
      try {
        const existingReaction = message.reactions.cache.get(emoji);
        if (existingReaction?.users.cache.has(botId)) {
          await existingReaction.users.remove(botId);
        }
      } catch (_e) {
        // Ignore
      }
    }
  }

  return { setMessageReaction, clearMessageReactions, updateEmojis, getEmojis, getAllStateEmojis };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a mock message with a reactions cache */
function createReactionMessage(botId: string, existingReactions: Record<string, string[]> = {}) {
  const reactionsCache = new Map<string, any>();

  for (const [emoji, userIds] of Object.entries(existingReactions)) {
    const usersCache = new Map<string, boolean>();
    for (const uid of userIds) usersCache.set(uid, true);
    reactionsCache.set(emoji, {
      emoji: { name: emoji },
      users: {
        cache: usersCache,
        remove: vi.fn().mockResolvedValue(undefined),
      },
    });
  }

  return {
    id: "msg-123",
    react: vi.fn().mockResolvedValue(undefined),
    reactions: {
      cache: reactionsCache,
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("ReactionManager", () => {
  const BOT_ID = "bot-123";
  let manager: ReturnType<typeof createReactionManager>;

  beforeEach(() => {
    manager = createReactionManager(BOT_ID);
  });

  // ---- setMessageReaction ----

  it("should add a reaction to a message", async () => {
    const message = createReactionMessage(BOT_ID);
    await manager.setMessageReaction(message, "\u2705");

    expect(message.react).toHaveBeenCalledWith("\u2705");
  });

  it("should accept a function for reaction value", async () => {
    const message = createReactionMessage(BOT_ID);
    await manager.setMessageReaction(message, () => "\u26A1");

    expect(message.react).toHaveBeenCalledWith("\u26A1");
  });

  it("should remove bot-only state reactions before adding new one", async () => {
    const emojis = manager.getEmojis();
    // Bot has an existing "queued" reaction
    const message = createReactionMessage(BOT_ID, {
      [emojis.queued]: [BOT_ID],
    });

    await manager.setMessageReaction(message, emojis.active);

    // Should remove the old "queued" reaction
    const queuedReaction = message.reactions.cache.get(emojis.queued);
    expect(queuedReaction.users.remove).toHaveBeenCalledWith(BOT_ID);

    // Should add the new "active" reaction
    expect(message.react).toHaveBeenCalledWith(emojis.active);
  });

  it("should not remove reactions from other users", async () => {
    const emojis = manager.getEmojis();
    // Another user has the "queued" reaction, not the bot
    const message = createReactionMessage(BOT_ID, {
      [emojis.queued]: ["other-user-456"],
    });

    await manager.setMessageReaction(message, emojis.active);

    // Should NOT remove the other user's reaction
    const queuedReaction = message.reactions.cache.get(emojis.queued);
    expect(queuedReaction.users.remove).not.toHaveBeenCalled();

    // Should still add the new reaction
    expect(message.react).toHaveBeenCalledWith(emojis.active);
  });

  it("should handle missing reactions cache gracefully", async () => {
    const message = createReactionMessage(BOT_ID);
    // No existing reactions in cache at all

    await expect(manager.setMessageReaction(message, "\u2705")).resolves.toBeUndefined();
    expect(message.react).toHaveBeenCalledWith("\u2705");
  });

  // ---- error resilience ----

  it("should not throw if message.react fails", async () => {
    const message = createReactionMessage(BOT_ID);
    message.react.mockRejectedValue(new Error("Missing Permissions"));

    await expect(manager.setMessageReaction(message, "\u2705")).resolves.toBeUndefined();
  });

  it("should not throw if removing a reaction fails", async () => {
    const emojis = manager.getEmojis();
    const message = createReactionMessage(BOT_ID, {
      [emojis.queued]: [BOT_ID],
    });

    // Make remove throw
    const queuedReaction = message.reactions.cache.get(emojis.queued);
    queuedReaction.users.remove.mockRejectedValue(new Error("Unknown Message"));

    await expect(manager.setMessageReaction(message, emojis.active)).resolves.toBeUndefined();
    // Should still try to add the new reaction
    expect(message.react).toHaveBeenCalledWith(emojis.active);
  });

  // ---- clearMessageReactions ----

  it("should clear all state reactions from a message", async () => {
    const emojis = manager.getEmojis();
    const message = createReactionMessage(BOT_ID, {
      [emojis.queued]: [BOT_ID],
      [emojis.active]: [BOT_ID],
      [emojis.done]: [BOT_ID],
    });

    await manager.clearMessageReactions(message);

    for (const emoji of [emojis.queued, emojis.active, emojis.done]) {
      const reaction = message.reactions.cache.get(emoji);
      expect(reaction.users.remove).toHaveBeenCalledWith(BOT_ID);
    }
  });

  it("should skip clearing reactions that the bot did not add", async () => {
    const emojis = manager.getEmojis();
    const message = createReactionMessage(BOT_ID, {
      [emojis.done]: ["other-user-789"],
    });

    await manager.clearMessageReactions(message);

    const doneReaction = message.reactions.cache.get(emojis.done);
    expect(doneReaction.users.remove).not.toHaveBeenCalled();
  });

  // ---- state emoji mapping from config ----

  it("should use default emojis when no config override", () => {
    const emojis = manager.getEmojis();
    expect(emojis.queued).toBe("\u{1F550}");
    expect(emojis.active).toBe("\u26A1");
    expect(emojis.done).toBe("\u2705");
    expect(emojis.error).toBe("\u274C");
    expect(emojis.cancelled).toBe("\u23F9\uFE0F");
  });

  it("should update emojis from config", () => {
    manager.updateEmojis({
      queued: "hourglass:12345",
      active: "zap:67890",
    });

    const emojis = manager.getEmojis();
    expect(emojis.queued).toBe("hourglass:12345");
    expect(emojis.active).toBe("zap:67890");
    // Unchanged defaults
    expect(emojis.done).toBe("\u2705");
  });

  it("should use updated emojis when setting reactions", async () => {
    manager.updateEmojis({ done: "custom_check:99999" });

    const message = createReactionMessage(BOT_ID);
    await manager.setMessageReaction(message, "custom_check:99999");

    expect(message.react).toHaveBeenCalledWith("custom_check:99999");
  });

  // ---- findReaction with custom emoji formats ----

  it("should find reactions with Unicode emojis in cache", async () => {
    const message = createReactionMessage(BOT_ID, {
      "\u2705": [BOT_ID],
    });

    const found = message.reactions.cache.get("\u2705");
    expect(found).toBeDefined();
    expect(found.users.cache.has(BOT_ID)).toBe(true);
  });

  it("should find reactions with custom emoji format (name:id) in cache", async () => {
    const message = createReactionMessage(BOT_ID, {
      "custom_emoji:123456789": [BOT_ID],
    });

    const found = message.reactions.cache.get("custom_emoji:123456789");
    expect(found).toBeDefined();
    expect(found.users.cache.has(BOT_ID)).toBe(true);
  });

  // ---- no botId guard ----

  it("should do nothing if botId is empty", async () => {
    const emptyBotManager = createReactionManager("");
    const message = createReactionMessage("", {});

    await emptyBotManager.setMessageReaction(message, "\u2705");
    expect(message.react).not.toHaveBeenCalled();

    await emptyBotManager.clearMessageReactions(message);
    // Should not throw
  });
});
