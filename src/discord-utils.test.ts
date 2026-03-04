import { DMChannel, TextChannel, ThreadChannel } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import { getSessionKey, getSessionKeyFromInteraction, resolveMentions } from "./discord-utils.js";

// Helper: create a mock TextChannel (guild-based, not thread, not DM)
function mockTextChannel(overrides: { name?: string; guildName?: string } = {}) {
  return {
    name: overrides.name ?? "general",
    guild: { name: overrides.guildName ?? "Test Guild" },
    isDMBased: () => false,
    isThread: () => false,
  } as any;
}

// Helper: create a mock DMChannel
function mockDMChannel(overrides: { recipientUsername?: string | null } = {}) {
  const username = overrides.recipientUsername;
  return {
    recipient: username === null ? null : { username: username ?? "someuser" },
    isDMBased: () => true,
    isThread: () => false,
  } as any;
}

// Helper: create a mock ThreadChannel
function mockThreadChannel(overrides: { name?: string; parentName?: string | null; guildName?: string } = {}) {
  return {
    name: overrides.name ?? "my-thread",
    guild: { name: overrides.guildName ?? "Test Guild" },
    parent: overrides.parentName === null ? null : { name: overrides.parentName ?? "general" },
    isDMBased: () => false,
    isThread: () => true,
  } as any;
}

describe("discord-utils", () => {
  describe("getSessionKey", () => {
    describe("guild TextChannel", () => {
      it("returns discord:guildname:#channelname for a basic guild channel", () => {
        const channel = mockTextChannel({ name: "general", guildName: "My Server" });
        expect(getSessionKey(channel)).toBe("discord:my-server:#general");
      });

      it("sanitizes spaces to hyphens", () => {
        const channel = mockTextChannel({ name: "my channel", guildName: "Cool Server" });
        expect(getSessionKey(channel)).toBe("discord:cool-server:#my-channel");
      });

      it("removes special characters", () => {
        const channel = mockTextChannel({ name: "chat!@#$%", guildName: "Server (Test)" });
        expect(getSessionKey(channel)).toBe("discord:server-test:#chat");
      });

      it("lowercases everything", () => {
        const channel = mockTextChannel({ name: "GENERAL", guildName: "BIG SERVER" });
        expect(getSessionKey(channel)).toBe("discord:big-server:#general");
      });

      it("uses unknown when guild is null", () => {
        const channel = {
          name: "general",
          guild: null as any,
          isDMBased: () => false,
          isThread: () => false,
        } as any;
        expect(getSessionKey(channel)).toBe("discord:unknown:#general");
      });
    });

    describe("DMChannel", () => {
      it("returns discord:dm:username for a DM", () => {
        const channel = mockDMChannel({ recipientUsername: "alice" });
        expect(getSessionKey(channel)).toBe("discord:dm:alice");
      });

      it("returns discord:dm:unknown when recipient is null", () => {
        const channel = mockDMChannel({ recipientUsername: null });
        expect(getSessionKey(channel)).toBe("discord:dm:unknown");
      });

      it("sanitizes username with spaces and special chars", () => {
        const channel = mockDMChannel({ recipientUsername: "Some User!!" });
        expect(getSessionKey(channel)).toBe("discord:dm:some-user");
      });
    });

    describe("ThreadChannel", () => {
      it("returns discord:guild:#parent/thread format", () => {
        const channel = mockThreadChannel({
          name: "my-thread",
          parentName: "general",
          guildName: "Server",
        });
        expect(getSessionKey(channel)).toBe("discord:server:#general/my-thread");
      });

      it("uses unknown for null parent", () => {
        const channel = mockThreadChannel({ name: "orphan", parentName: null, guildName: "Server" });
        expect(getSessionKey(channel)).toBe("discord:server:#unknown/orphan");
      });

      it("sanitizes thread and parent names", () => {
        const channel = mockThreadChannel({
          name: "My Thread!",
          parentName: "Cool Channel",
          guildName: "Test",
        });
        expect(getSessionKey(channel)).toBe("discord:test:#cool-channel/my-thread");
      });
    });

    describe("consistency", () => {
      it("returns the same key for the same channel", () => {
        const channel = mockTextChannel({ name: "dev", guildName: "WOPR" });
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
      // Create an object whose prototype chain includes TextChannel so instanceof passes
      const channel = Object.assign(Object.create(TextChannel.prototype), {
        name: "general",
        guild: { name: "Test Guild" },
        isDMBased: () => false,
        isThread: () => false,
      });
      const interaction = { channel, channelId: "ch-789" } as any;
      expect(getSessionKeyFromInteraction(interaction)).toBe("discord:test-guild:#general");
    });

    it("uses getSessionKey when channel is instanceof ThreadChannel", () => {
      const channel = Object.create(ThreadChannel.prototype);
      Object.defineProperties(channel, {
        name: { value: "my-thread", writable: true, configurable: true },
        guild: { value: { name: "Test Guild" }, writable: true, configurable: true },
        parent: { value: { name: "general" }, writable: true, configurable: true },
        isDMBased: { value: () => false, writable: true, configurable: true },
        isThread: { value: () => true, writable: true, configurable: true },
      });
      const interaction = { channel, channelId: "ch-790" } as any;
      expect(getSessionKeyFromInteraction(interaction)).toBe("discord:test-guild:#general/my-thread");
    });

    it("uses getSessionKey when channel is instanceof DMChannel", () => {
      const channel = Object.create(DMChannel.prototype);
      Object.defineProperties(channel, {
        recipient: { value: { username: "alice" }, writable: true, configurable: true },
        isDMBased: { value: () => true, writable: true, configurable: true },
        isThread: { value: () => false, writable: true, configurable: true },
      });
      const interaction = { channel, channelId: "ch-791" } as any;
      expect(getSessionKeyFromInteraction(interaction)).toBe("discord:dm:alice");
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
