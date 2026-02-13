import { describe, expect, it, vi } from "vitest";
import { createDiscordExtension } from "../src/discord-extension.js";
import type { WOPRPluginContext } from "../src/types.js";

/** Creates a Map-like object with a .map() method to mimic discord.js Collection. */
function createCollection<V>(entries: [string, V][]): Map<string, V> & { map: <T>(fn: (v: V) => T) => T[] } {
  const map = new Map(entries) as Map<string, V> & { map: <T>(fn: (v: V) => T) => T[] };
  map.map = <T>(fn: (v: V) => T): T[] => [...map.values()].map(fn);
  return map;
}

function createMockClient(options: {
  ready?: boolean;
  username?: string;
  ping?: number;
  uptime?: number | null;
  guilds?: Array<{ id: string; name: string; memberCount: number; iconURL: string | null; channels: Array<{ id: string; name: string; type: number; position: number }> }>;
} = {}) {
  const guildEntries: [string, any][] = (options.guilds || []).map((g) => {
    const channelEntries: [string, any][] = g.channels.map((ch) => [ch.id, ch]);
    return [
      g.id,
      {
        ...g,
        iconURL: () => g.iconURL,
        channels: { cache: createCollection(channelEntries) },
      },
    ];
  });

  return {
    isReady: () => options.ready ?? true,
    user: { username: options.username ?? "WOPRBot" },
    ws: { ping: options.ping ?? 42 },
    uptime: options.uptime ?? 120000,
    guilds: { cache: createCollection(guildEntries) },
    users: { fetch: vi.fn() },
  } as any;
}

function createMockCtx(sessions: string[] = []): WOPRPluginContext {
  return {
    getSessions: () => sessions,
    getConfig: () => ({}),
  } as unknown as WOPRPluginContext;
}

describe("DiscordExtension WebMCP methods", () => {
  describe("getStatus", () => {
    it("should return offline status when client is null", () => {
      const ext = createDiscordExtension(
        () => null,
        () => null,
      );
      const status = ext.getStatus();
      expect(status).toEqual({
        online: false,
        username: "unknown",
        guildsCount: 0,
        latencyMs: -1,
        uptimeMs: null,
      });
    });

    it("should return online status with client data", () => {
      const client = createMockClient({
        ready: true,
        username: "TestBot",
        ping: 55,
        uptime: 300000,
        guilds: [
          { id: "g1", name: "Guild 1", memberCount: 10, iconURL: null, channels: [] },
          { id: "g2", name: "Guild 2", memberCount: 20, iconURL: null, channels: [] },
        ],
      });
      const ext = createDiscordExtension(
        () => client,
        () => createMockCtx(),
      );

      const status = ext.getStatus();
      expect(status).toEqual({
        online: true,
        username: "TestBot",
        guildsCount: 2,
        latencyMs: 55,
        uptimeMs: 300000,
      });
    });
  });

  describe("listGuilds", () => {
    it("should return empty array when client is null", () => {
      const ext = createDiscordExtension(
        () => null,
        () => null,
      );
      expect(ext.listGuilds()).toEqual([]);
    });

    it("should return guild info with structured data", () => {
      const client = createMockClient({
        guilds: [
          { id: "g1", name: "Test Server", memberCount: 42, iconURL: "https://cdn.example.com/icon.png", channels: [] },
        ],
      });
      const ext = createDiscordExtension(
        () => client,
        () => createMockCtx(),
      );

      const guilds = ext.listGuilds();
      expect(guilds).toEqual([
        { id: "g1", name: "Test Server", memberCount: 42, icon: "https://cdn.example.com/icon.png" },
      ]);
    });
  });

  describe("listChannels", () => {
    it("should return empty array when client is null", () => {
      const ext = createDiscordExtension(
        () => null,
        () => null,
      );
      expect(ext.listChannels("g1")).toEqual([]);
    });

    it("should return empty array for unknown guild", () => {
      const client = createMockClient({ guilds: [] });
      const ext = createDiscordExtension(
        () => client,
        () => createMockCtx(),
      );
      expect(ext.listChannels("nonexistent")).toEqual([]);
    });

    it("should return channel info with type labels", () => {
      const client = createMockClient({
        guilds: [
          {
            id: "g1",
            name: "Guild",
            memberCount: 10,
            iconURL: null,
            channels: [
              { id: "ch1", name: "general", type: 0, position: 0 }, // GuildText
              { id: "ch2", name: "voice", type: 2, position: 1 }, // GuildVoice
              { id: "ch3", name: "info", type: 4, position: 2 }, // GuildCategory
            ],
          },
        ],
      });
      const ext = createDiscordExtension(
        () => client,
        () => createMockCtx(),
      );

      const channels = ext.listChannels("g1");
      expect(channels).toEqual([
        { id: "ch1", name: "general", type: "text", position: 0 },
        { id: "ch2", name: "voice", type: "voice", position: 1 },
        { id: "ch3", name: "info", type: "category", position: 2 },
      ]);
    });
  });

  describe("getMessageStats", () => {
    it("should return zeros when client/ctx are null", () => {
      const ext = createDiscordExtension(
        () => null,
        () => null,
      );
      const stats = ext.getMessageStats();
      expect(stats).toEqual({ sessionsActive: 0, guildsConnected: 0 });
    });

    it("should count only discord sessions", () => {
      const client = createMockClient({
        guilds: [
          { id: "g1", name: "Guild", memberCount: 10, iconURL: null, channels: [] },
        ],
      });
      const ctx = createMockCtx(["discord:guild:#general", "discord:guild:#random", "cli:default", "web:session1"]);
      const ext = createDiscordExtension(
        () => client,
        () => ctx,
      );

      const stats = ext.getMessageStats();
      expect(stats).toEqual({ sessionsActive: 2, guildsConnected: 1 });
    });
  });
});
