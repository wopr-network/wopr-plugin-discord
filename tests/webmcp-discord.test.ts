import { beforeEach, describe, expect, it, vi } from "vitest";
import { type AuthContext, type WebMCPRegistry, registerDiscordTools } from "../src/webmcp-discord.js";

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

function mockJsonResponse(data: unknown, ok = true, status = 200) {
  return {
    ok,
    status,
    json: vi.fn().mockResolvedValue(data),
  };
}

function createRegistry(): WebMCPRegistry {
  const tools = new Map<string, { name: string; handler: Function; [k: string]: unknown }>();
  return {
    register(tool: { name: string; handler: Function }) {
      tools.set(tool.name, tool);
    },
    get(name: string) {
      return tools.get(name) as any;
    },
    list() {
      return [...tools.keys()];
    },
  };
}

function getTool(registry: WebMCPRegistry, name: string) {
  const tool = registry.get(name);
  if (!tool) throw new Error(`Tool "${name}" not registered`);
  return tool;
}

describe("registerDiscordTools", () => {
  let registry: WebMCPRegistry;
  const API_BASE = "/api";

  beforeEach(() => {
    registry = createRegistry();
    mockFetch.mockReset();
  });

  it("should register all 4 tools", () => {
    registerDiscordTools(registry, API_BASE);

    const names = registry.list();
    expect(names).toHaveLength(4);
    expect(names).toContain("getDiscordStatus");
    expect(names).toContain("listGuilds");
    expect(names).toContain("listChannels");
    expect(names).toContain("getMessageStats");
  });

  it("should use default apiBase when not provided", () => {
    registerDiscordTools(registry);

    expect(registry.list()).toHaveLength(4);
  });

  describe("getDiscordStatus", () => {
    it("should GET /plugins/discord/status", async () => {
      const status = { online: true, username: "WOPRBot", guildsCount: 3, latencyMs: 45, uptimeMs: 360000 };
      mockFetch.mockResolvedValue(mockJsonResponse(status));
      registerDiscordTools(registry, API_BASE);

      const tool = getTool(registry, "getDiscordStatus");
      const result = await tool.handler({}, {});

      expect(mockFetch).toHaveBeenCalledWith("/api/plugins/discord/status", expect.any(Object));
      expect(result).toEqual(status);
    });

    it("should include bearer token when auth.token is present", async () => {
      mockFetch.mockResolvedValue(mockJsonResponse({ online: true }));
      registerDiscordTools(registry, API_BASE);

      const tool = getTool(registry, "getDiscordStatus");
      const auth: AuthContext = { token: "my-token" };
      await tool.handler({}, auth);

      const headers = mockFetch.mock.calls[0][1].headers;
      expect(headers.Authorization).toBe("Bearer my-token");
    });

    it("should not include Authorization header when no token", async () => {
      mockFetch.mockResolvedValue(mockJsonResponse({ online: false }));
      registerDiscordTools(registry, API_BASE);

      const tool = getTool(registry, "getDiscordStatus");
      await tool.handler({}, {});

      const headers = mockFetch.mock.calls[0][1].headers;
      expect(headers.Authorization).toBeUndefined();
    });
  });

  describe("listGuilds", () => {
    it("should GET /plugins/discord/guilds", async () => {
      const guilds = { guilds: [{ id: "123", name: "Test Server", memberCount: 50, icon: null }] };
      mockFetch.mockResolvedValue(mockJsonResponse(guilds));
      registerDiscordTools(registry, API_BASE);

      const tool = getTool(registry, "listGuilds");
      const result = await tool.handler({}, {});

      expect(mockFetch).toHaveBeenCalledWith("/api/plugins/discord/guilds", expect.any(Object));
      expect(result).toEqual(guilds);
    });

    it("should include bearer token in auth header", async () => {
      mockFetch.mockResolvedValue(mockJsonResponse({ guilds: [] }));
      registerDiscordTools(registry, API_BASE);

      const tool = getTool(registry, "listGuilds");
      await tool.handler({}, { token: "tok-guilds" });

      const headers = mockFetch.mock.calls[0][1].headers;
      expect(headers.Authorization).toBe("Bearer tok-guilds");
    });
  });

  describe("listChannels", () => {
    it("should GET /plugins/discord/guilds/:guildId/channels", async () => {
      const channels = {
        channels: [{ id: "ch1", name: "general", type: "text", position: 0 }],
      };
      mockFetch.mockResolvedValue(mockJsonResponse(channels));
      registerDiscordTools(registry, API_BASE);

      const tool = getTool(registry, "listChannels");
      const result = await tool.handler({ guildId: "guild-123" }, {});

      expect(mockFetch).toHaveBeenCalledWith(
        "/api/plugins/discord/guilds/guild-123/channels",
        expect.any(Object),
      );
      expect(result).toEqual(channels);
    });

    it("should throw when guildId parameter is missing", async () => {
      registerDiscordTools(registry, API_BASE);

      const tool = getTool(registry, "listChannels");

      await expect(tool.handler({}, {})).rejects.toThrow("Parameter 'guildId' is required");
    });

    it("should URL-encode guildId with special characters", async () => {
      mockFetch.mockResolvedValue(mockJsonResponse({ channels: [] }));
      registerDiscordTools(registry, API_BASE);

      const tool = getTool(registry, "listChannels");
      await tool.handler({ guildId: "id with spaces" }, {});

      expect(mockFetch).toHaveBeenCalledWith(
        "/api/plugins/discord/guilds/id%20with%20spaces/channels",
        expect.any(Object),
      );
    });

    it("should include bearer token in auth header", async () => {
      mockFetch.mockResolvedValue(mockJsonResponse({ channels: [] }));
      registerDiscordTools(registry, API_BASE);

      const tool = getTool(registry, "listChannels");
      await tool.handler({ guildId: "g1" }, { token: "tok-ch" });

      const headers = mockFetch.mock.calls[0][1].headers;
      expect(headers.Authorization).toBe("Bearer tok-ch");
    });
  });

  describe("getMessageStats", () => {
    it("should GET /plugins/discord/stats", async () => {
      const stats = { sessionsActive: 5, guildsConnected: 2 };
      mockFetch.mockResolvedValue(mockJsonResponse(stats));
      registerDiscordTools(registry, API_BASE);

      const tool = getTool(registry, "getMessageStats");
      const result = await tool.handler({}, {});

      expect(mockFetch).toHaveBeenCalledWith("/api/plugins/discord/stats", expect.any(Object));
      expect(result).toEqual(stats);
    });

    it("should include bearer token in auth header", async () => {
      mockFetch.mockResolvedValue(mockJsonResponse({ sessionsActive: 0 }));
      registerDiscordTools(registry, API_BASE);

      const tool = getTool(registry, "getMessageStats");
      await tool.handler({}, { token: "tok-stats" });

      const headers = mockFetch.mock.calls[0][1].headers;
      expect(headers.Authorization).toBe("Bearer tok-stats");
    });
  });

  describe("error handling", () => {
    it("should throw on non-ok response with error from body", async () => {
      mockFetch.mockResolvedValue(mockJsonResponse({ error: "Discord plugin not loaded" }, false, 404));
      registerDiscordTools(registry, API_BASE);

      const tool = getTool(registry, "getDiscordStatus");

      await expect(tool.handler({}, {})).rejects.toThrow("Discord plugin not loaded");
    });

    it("should throw with status code when body has no error field", async () => {
      mockFetch.mockResolvedValue(mockJsonResponse({}, false, 500));
      registerDiscordTools(registry, API_BASE);

      const tool = getTool(registry, "listGuilds");

      await expect(tool.handler({}, {})).rejects.toThrow("Request failed (500)");
    });

    it("should handle json parse failure on error response", async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 502,
        json: vi.fn().mockRejectedValue(new Error("invalid json")),
      });
      registerDiscordTools(registry, API_BASE);

      const tool = getTool(registry, "getMessageStats");

      await expect(tool.handler({}, {})).rejects.toThrow("Request failed");
    });
  });
});
