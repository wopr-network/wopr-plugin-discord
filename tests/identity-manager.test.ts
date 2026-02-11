/**
 * Tests for Identity Manager logic.
 *
 * The identity manager in index.ts handles:
 * - Config-driven emoji/name refresh from getAgentIdentity()
 * - Trimming whitespace from identity values
 * - Fallback defaults when identity fields are missing
 * - Prefix formatting: "[Name]" or "[WOPR]" fallback
 * - Ack reaction emoji from identity or fallback
 * - Reaction emoji refresh from config (emojiQueued, emojiActive, etc.)
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createMockContext } from "./mocks/wopr-context.js";

// ---------------------------------------------------------------------------
// Extracted identity manager logic (mirrors src/index.ts implementation)
// ---------------------------------------------------------------------------

interface AgentIdentity {
  name?: string;
  creature?: string;
  vibe?: string;
  emoji?: string;
}

interface ReactionEmojis {
  queued: string;
  active: string;
  done: string;
  error: string;
  cancelled: string;
}

function createIdentityManager() {
  let agentIdentity: AgentIdentity = { name: "WOPR", emoji: "\u{1F440}" }; // 👀
  let reactionEmojis: ReactionEmojis = {
    queued: "\u{1F550}",
    active: "\u26A1",
    done: "\u2705",
    error: "\u274C",
    cancelled: "\u23F9\uFE0F",
  };

  async function refreshIdentity(ctx: any): Promise<void> {
    try {
      const identity = await ctx.getAgentIdentity();
      if (identity) {
        agentIdentity = { ...agentIdentity, ...identity };
      }
    } catch (_e) {
      // Failed to refresh identity - keep existing
    }
    await refreshReactionEmojis(ctx);
  }

  async function refreshReactionEmojis(ctx: any): Promise<void> {
    try {
      const config = ctx.getConfig();
      if (config) {
        reactionEmojis = {
          queued: config.emojiQueued || "\u{1F550}",
          active: config.emojiActive || "\u26A1",
          done: config.emojiDone || "\u2705",
          error: config.emojiError || "\u274C",
          cancelled: config.emojiCancelled || "\u23F9\uFE0F",
        };
      }
    } catch (_e) {
      // Failed to refresh emojis - keep defaults
    }
  }

  function getAckReaction(): string {
    return agentIdentity.emoji?.trim() || "\u{1F440}";
  }

  function getMessagePrefix(): string {
    const name = agentIdentity.name?.trim();
    return name ? `[${name}]` : "[WOPR]";
  }

  function getIdentity(): AgentIdentity {
    return { ...agentIdentity };
  }

  function getReactionEmojis(): ReactionEmojis {
    return { ...reactionEmojis };
  }

  return { refreshIdentity, getAckReaction, getMessagePrefix, getIdentity, getReactionEmojis };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("IdentityManager", () => {
  let manager: ReturnType<typeof createIdentityManager>;

  beforeEach(() => {
    manager = createIdentityManager();
  });

  // ---- default identity ----

  it("should have default identity with name WOPR and emoji 👀", () => {
    const identity = manager.getIdentity();
    expect(identity.name).toBe("WOPR");
    expect(identity.emoji).toBe("\u{1F440}");
  });

  // ---- config-driven identity refresh ----

  it("should refresh identity from getAgentIdentity()", async () => {
    const ctx = createMockContext();
    (ctx.getAgentIdentity as any).mockResolvedValue({
      name: "NewBot",
      creature: "cat",
      vibe: "playful",
      emoji: "\u{1F431}", // 🐱
    });

    await manager.refreshIdentity(ctx);

    const identity = manager.getIdentity();
    expect(identity.name).toBe("NewBot");
    expect(identity.creature).toBe("cat");
    expect(identity.vibe).toBe("playful");
    expect(identity.emoji).toBe("\u{1F431}");
  });

  it("should keep existing identity if getAgentIdentity returns null", async () => {
    const ctx = createMockContext();
    (ctx.getAgentIdentity as any).mockResolvedValue(null);

    await manager.refreshIdentity(ctx);

    const identity = manager.getIdentity();
    expect(identity.name).toBe("WOPR");
    expect(identity.emoji).toBe("\u{1F440}");
  });

  it("should keep existing identity if getAgentIdentity throws", async () => {
    const ctx = createMockContext();
    (ctx.getAgentIdentity as any).mockRejectedValue(new Error("Network error"));

    await manager.refreshIdentity(ctx);

    const identity = manager.getIdentity();
    expect(identity.name).toBe("WOPR");
  });

  // ---- trimming ----

  it("should trim whitespace from emoji in getAckReaction", async () => {
    const ctx = createMockContext();
    (ctx.getAgentIdentity as any).mockResolvedValue({
      name: "Bot",
      emoji: "  \u{1F431}  ",
    });

    await manager.refreshIdentity(ctx);
    expect(manager.getAckReaction()).toBe("\u{1F431}");
  });

  it("should trim whitespace from name in getMessagePrefix", async () => {
    const ctx = createMockContext();
    (ctx.getAgentIdentity as any).mockResolvedValue({
      name: "  SpacedBot  ",
      emoji: "\u{1F916}",
    });

    await manager.refreshIdentity(ctx);
    expect(manager.getMessagePrefix()).toBe("[SpacedBot]");
  });

  // ---- fallbacks ----

  it("should fallback to 👀 when emoji is empty string", async () => {
    const ctx = createMockContext();
    (ctx.getAgentIdentity as any).mockResolvedValue({
      name: "Bot",
      emoji: "",
    });

    await manager.refreshIdentity(ctx);
    expect(manager.getAckReaction()).toBe("\u{1F440}");
  });

  it("should fallback to 👀 when emoji is whitespace only", async () => {
    const ctx = createMockContext();
    (ctx.getAgentIdentity as any).mockResolvedValue({
      name: "Bot",
      emoji: "   ",
    });

    await manager.refreshIdentity(ctx);
    expect(manager.getAckReaction()).toBe("\u{1F440}");
  });

  it("should fallback to [WOPR] prefix when name is empty", async () => {
    const ctx = createMockContext();
    (ctx.getAgentIdentity as any).mockResolvedValue({
      name: "",
      emoji: "\u{1F916}",
    });

    await manager.refreshIdentity(ctx);
    expect(manager.getMessagePrefix()).toBe("[WOPR]");
  });

  it("should fallback to [WOPR] prefix when name is whitespace only", async () => {
    const ctx = createMockContext();
    (ctx.getAgentIdentity as any).mockResolvedValue({
      name: "   ",
      emoji: "\u{1F916}",
    });

    await manager.refreshIdentity(ctx);
    expect(manager.getMessagePrefix()).toBe("[WOPR]");
  });

  // ---- prefix formatting ----

  it("should format prefix as [Name] with brackets", async () => {
    const ctx = createMockContext();
    (ctx.getAgentIdentity as any).mockResolvedValue({
      name: "Athena",
      emoji: "\u{1F9D9}",
    });

    await manager.refreshIdentity(ctx);
    expect(manager.getMessagePrefix()).toBe("[Athena]");
  });

  // ---- reaction emoji refresh from config ----

  it("should refresh reaction emojis from config", async () => {
    const ctx = createMockContext();
    (ctx.getConfig as any).mockReturnValue({
      emojiQueued: "\u231B",       // ⌛
      emojiActive: "\u{1F525}",    // 🔥
      emojiDone: "\u{1F389}",      // 🎉
      emojiError: "\u{1F4A5}",     // 💥
      emojiCancelled: "\u{1F6D1}", // 🛑
    });

    await manager.refreshIdentity(ctx);

    const emojis = manager.getReactionEmojis();
    expect(emojis.queued).toBe("\u231B");
    expect(emojis.active).toBe("\u{1F525}");
    expect(emojis.done).toBe("\u{1F389}");
    expect(emojis.error).toBe("\u{1F4A5}");
    expect(emojis.cancelled).toBe("\u{1F6D1}");
  });

  it("should use default emojis when config has no emoji overrides", async () => {
    const ctx = createMockContext();
    (ctx.getConfig as any).mockReturnValue({});

    await manager.refreshIdentity(ctx);

    const emojis = manager.getReactionEmojis();
    expect(emojis.queued).toBe("\u{1F550}");
    expect(emojis.active).toBe("\u26A1");
    expect(emojis.done).toBe("\u2705");
    expect(emojis.error).toBe("\u274C");
    expect(emojis.cancelled).toBe("\u23F9\uFE0F");
  });

  it("should keep default emojis when config refresh throws", async () => {
    const ctx = createMockContext();
    (ctx.getConfig as any).mockImplementation(() => {
      throw new Error("Config unavailable");
    });

    await manager.refreshIdentity(ctx);

    const emojis = manager.getReactionEmojis();
    expect(emojis.queued).toBe("\u{1F550}");
    expect(emojis.done).toBe("\u2705");
  });
});
