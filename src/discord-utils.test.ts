import { DMChannel, TextChannel, ThreadChannel } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import { getSessionKey, getSessionKeyFromInteraction, resolveMentions } from "./discord-utils.js";

// Helper: create a mock TextChannel (guild-based, not thread, not DM)
function mockTextChannel(overrides: { id?: string; guildId?: string; name?: string; guildName?: string } = {}) {
  return {
    id: overrides.id ?? "channel-001",
    name: overrides.name ?? "general",
    guild: { id: overrides.guildId ?? "guild-001", name: overrides.guildName ?? "Test Guild" },
    isDMBased: () => false,
    isThread: () => false,
  } as any;
}

// Helper: create a mock DMChannel
function mockDMChannel(overrides: { recipientId?: string | null; recipientUsername?: string | null } = {}) {
  const id = overrides.recipientId;
  const username = overrides.recipientUsername;
  return {
    recipient: id === null ? null : { id: id ?? "user-001", username: username ?? "someuser" },
    isDMBased: () => true,
    isThread: () => false,
  } as any;
}

// Helper: create a mock ThreadChannel
function mockThreadChannel(
  overrides: {
    id?: string;
    parentId?: string | null;
    guildId?: string;
    name?: string;
    parentName?: string | null;
    guildName?: string;
  } = {},
) {
  return {
    id: overrides.id ?? "thread-001",
    name: overrides.name ?? "my-thread",
    guild: { id: overrides.guildId ?? "guild-001", name: overrides.guildName ?? "Test Guild" },
    parentId: overrides.parentId === null ? null : (overrides.parentId ?? "channel-001"),
    parent: overrides.parentName === null ? null : { name: overrides.parentName ?? "general" },
    isDMBased: () => false,
    isThread: () => true,
  } as any;
}

describe("discord-utils", () => {
  describe("getSessionKey", () => {
    describe("guild TextChannel", () => {
      it("returns discord:guildId:#channelId for a basic guild channel", () => {
        const channel = mockTextChannel({ id: "ch-100", guildId: "g-200" });
        expect(getSessionKey(channel)).toBe("discord:g-200:#ch-100");
      });

      it("uses unknown when guild is null", () => {
        const channel = {
          id: "ch-100",
          guild: null as any,
          isDMBased: () => false,
          isThread: () => false,
        } as any;
        expect(getSessionKey(channel)).toBe("discord:unknown:#ch-100");
      });

      it("produces different keys for same-named channels in different guilds", () => {
        const ch1 = mockTextChannel({ id: "ch-100", guildId: "g-aaa", name: "general", guildName: "My Server" });
        const ch2 = mockTextChannel({ id: "ch-100", guildId: "g-bbb", name: "general", guildName: "My Server" });
        expect(getSessionKey(ch1)).not.toBe(getSessionKey(ch2));
      });
    });

    describe("DMChannel", () => {
      it("returns discord:dm:userId for a DM", () => {
        const channel = mockDMChannel({ recipientId: "user-alice" });
        expect(getSessionKey(channel)).toBe("discord:dm:user-alice");
      });

      it("returns discord:dm:unknown when recipient is null", () => {
        const channel = mockDMChannel({ recipientId: null });
        expect(getSessionKey(channel)).toBe("discord:dm:unknown");
      });
    });

    describe("ThreadChannel", () => {
      it("returns discord:guildId:#parentId/threadId format", () => {
        const channel = mockThreadChannel({ id: "t-300", parentId: "ch-100", guildId: "g-200" });
        expect(getSessionKey(channel)).toBe("discord:g-200:#ch-100/t-300");
      });

      it("uses unknown for null parentId", () => {
        const channel = mockThreadChannel({ id: "t-300", parentId: null, guildId: "g-200" });
        expect(getSessionKey(channel)).toBe("discord:g-200:#unknown/t-300");
      });
    });

    describe("consistency", () => {
      it("returns the same key for the same channel", () => {
        const channel = mockTextChannel({ id: "ch-dev", guildId: "g-wopr" });
        const key1 = getSessionKey(channel);
        const key2 = getSessionKey(channel);
        expect(key1).toBe(key2);
      });
    });
  });

  describe("getSessionKeyFromInteraction", () => {
    it("falls back to discord:channelId when channel is not a recognized type", () => {
      // channel is a plain object, not instanceof TextChannel/ThreadChannel/DMChannel
      const interaction = {
        channel: { id: "ch-123", isDMBased: () => false, isThread: () => false },
        channelId: "ch-123",
      } as any;
      expect(getSessionKeyFromInteraction(interaction)).toBe("discord:ch-123");
    });

    it("falls back to discord:channelId when channel is null", () => {
      const interaction = {
        channel: null,
        channelId: "ch-456",
      } as any;
      expect(getSessionKeyFromInteraction(interaction)).toBe("discord:ch-456");
    });

    it("uses getSessionKey when channel is instanceof TextChannel", () => {
      const channel = Object.assign(Object.create(TextChannel.prototype), {
        id: "ch-789",
        name: "general",
        guild: { id: "g-100", name: "Test Guild" },
        isDMBased: () => false,
        isThread: () => false,
      });
      const interaction = { channel, channelId: "ch-789" } as any;
      expect(getSessionKeyFromInteraction(interaction)).toBe("discord:g-100:#ch-789");
    });

    it("uses getSessionKey when channel is instanceof ThreadChannel", () => {
      const channel = Object.create(ThreadChannel.prototype);
      Object.defineProperties(channel, {
        id: { value: "t-790", writable: true, configurable: true },
        name: { value: "my-thread", writable: true, configurable: true },
        guild: { value: { id: "g-100", name: "Test Guild" }, writable: true, configurable: true },
        parentId: { value: "ch-100", writable: true, configurable: true },
        parent: { value: { name: "general" }, writable: true, configurable: true },
        isDMBased: { value: () => false, writable: true, configurable: true },
        isThread: { value: () => true, writable: true, configurable: true },
      });
      const interaction = { channel, channelId: "ch-790" } as any;
      expect(getSessionKeyFromInteraction(interaction)).toBe("discord:g-100:#ch-100/t-790");
    });

    it("uses getSessionKey when channel is instanceof DMChannel", () => {
      const channel = Object.create(DMChannel.prototype);
      Object.defineProperties(channel, {
        recipient: { value: { id: "user-alice", username: "alice" }, writable: true, configurable: true },
        isDMBased: { value: () => true, writable: true, configurable: true },
        isThread: { value: () => false, writable: true, configurable: true },
      });
      const interaction = { channel, channelId: "ch-791" } as any;
      expect(getSessionKeyFromInteraction(interaction)).toBe("discord:dm:user-alice");
    });
  });

  describe("resolveMentions", () => {
    it("resolves user mentions to @DisplayName [ID] format", () => {
      const message = {
        content: "Hello <@user-1> and <@!user-2>",
        mentions: {
          users: new Map([
            ["user-1", { id: "user-1", username: "alice", displayName: "Alice" }],
            ["user-2", { id: "user-2", username: "bob", displayName: "Bob" }],
          ]),
          channels: new Map(),
          roles: new Map(),
        },
        guild: {
          members: {
            cache: {
              get: vi.fn().mockReturnValue(null),
            },
          },
        },
      } as any;
      const result = resolveMentions(message);
      expect(result).toBe("Hello @Alice [user-1] and @Bob [user-2]");
    });

    it("prefers member displayName over user displayName", () => {
      const message = {
        content: "Hey <@user-1>",
        mentions: {
          users: new Map([["user-1", { id: "user-1", username: "alice", displayName: "Alice" }]]),
          channels: new Map(),
          roles: new Map(),
        },
        guild: {
          members: {
            cache: {
              get: vi.fn((id: string) => (id === "user-1" ? { displayName: "Alice (Nickname)" } : null)),
            },
          },
        },
      } as any;
      const result = resolveMentions(message);
      expect(result).toBe("Hey @Alice (Nickname) [user-1]");
    });

    it("resolves channel mentions to #name [ID] format", () => {
      const message = {
        content: "Check <#ch-1>",
        mentions: {
          users: new Map(),
          channels: new Map([["ch-1", { name: "general" }]]),
          roles: new Map(),
        },
        guild: null,
      } as any;
      const result = resolveMentions(message);
      expect(result).toBe("Check #general [ch-1]");
    });

    it("resolves role mentions to @RoleName [ID] format", () => {
      const message = {
        content: "Pinging <@&role-1>",
        mentions: {
          users: new Map(),
          channels: new Map(),
          roles: new Map([["role-1", { name: "Admin" }]]),
        },
        guild: null,
      } as any;
      const result = resolveMentions(message);
      expect(result).toBe("Pinging @Admin [role-1]");
    });

    it("returns content unchanged when no mentions exist", () => {
      const message = {
        content: "Just a normal message",
        mentions: {
          users: new Map(),
          channels: new Map(),
          roles: new Map(),
        },
        guild: null,
      } as any;
      expect(resolveMentions(message)).toBe("Just a normal message");
    });

    it("resolves multiple mentions of the same user", () => {
      const message = {
        content: "<@user-1> said hi to <@user-1>",
        mentions: {
          users: new Map([["user-1", { id: "user-1", username: "alice", displayName: "Alice" }]]),
          channels: new Map(),
          roles: new Map(),
        },
        guild: { members: { cache: { get: vi.fn().mockReturnValue(null) } } },
      } as any;
      const result = resolveMentions(message);
      expect(result).toBe("@Alice [user-1] said hi to @Alice [user-1]");
    });

    it("falls back to username when displayName is missing", () => {
      const message = {
        content: "Hey <@user-1>",
        mentions: {
          users: new Map([["user-1", { id: "user-1", username: "alice", displayName: undefined }]]),
          channels: new Map(),
          roles: new Map(),
        },
        guild: { members: { cache: { get: vi.fn().mockReturnValue(null) } } },
      } as any;
      const result = resolveMentions(message);
      expect(result).toBe("Hey @alice [user-1]");
    });

    it("uses channelId as fallback when channel has no name", () => {
      const message = {
        content: "See <#ch-99>",
        mentions: {
          users: new Map(),
          channels: new Map([["ch-99", {}]]),
          roles: new Map(),
        },
        guild: null,
      } as any;
      const result = resolveMentions(message);
      expect(result).toBe("See #ch-99 [ch-99]");
    });
  });
});
