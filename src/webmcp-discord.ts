/**
 * WebMCP Discord Tools
 *
 * Registers 4 read-only browser-side WebMCP tools for Discord connection
 * status, guild listing, channel listing, and message stats.
 *
 * These tools call the WOPR daemon REST API via fetch() and are only
 * meaningful when the Discord plugin is loaded on the instance.
 */

// ============================================================================
// Types (mirrors WebMCPRegistry from wopr-plugin-webui)
// ============================================================================

export interface AuthContext {
  token?: string;
  [key: string]: unknown;
}

export interface ParameterSchema {
  type: string;
  description: string;
  required?: boolean;
}

export interface WebMCPTool {
  name: string;
  description: string;
  parameters: Record<string, ParameterSchema>;
  handler: (params: Record<string, unknown>, auth: AuthContext) => Promise<unknown>;
}

export interface WebMCPRegistry {
  register(tool: WebMCPTool): void;
  get(name: string): WebMCPTool | undefined;
  list(): string[];
}

// ============================================================================
// Internal helpers
// ============================================================================

interface RequestOptions {
  method?: string;
  body?: string;
  headers?: Record<string, string>;
}

async function daemonRequest<T>(
  apiBase: string,
  path: string,
  auth: AuthContext,
  options?: RequestOptions,
): Promise<T> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...options?.headers,
  };
  if (auth.token) {
    headers.Authorization = `Bearer ${auth.token as string}`;
  }
  const res = await fetch(`${apiBase}${path}`, {
    ...options,
    headers,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: "Request failed" }));
    throw new Error((err as { error?: string }).error || `Request failed (${res.status})`);
  }
  return res.json() as Promise<T>;
}

// ============================================================================
// Tool registration
// ============================================================================

/**
 * Register all 4 Discord WebMCP tools on the given registry.
 *
 * The tools proxy to the Discord plugin extension via daemon API endpoints
 * at `/plugins/discord/status`, `/plugins/discord/guilds`, etc.
 *
 * @param registry - The WebMCPRegistry instance to register tools on
 * @param apiBase  - Base URL of the WOPR daemon API (e.g. "/api" or "http://localhost:7437")
 */
export function registerDiscordTools(registry: WebMCPRegistry, apiBase = "/api"): void {
  // 1. getDiscordStatus
  registry.register({
    name: "getDiscordStatus",
    description: "Get Discord bot connection status: online/offline, connected guilds count, and latency.",
    parameters: {},
    handler: async (_params: Record<string, unknown>, auth: AuthContext) => {
      return daemonRequest(apiBase, "/plugins/discord/status", auth);
    },
  });

  // 2. listGuilds
  registry.register({
    name: "listGuilds",
    description: "List all Discord servers (guilds) the bot is connected to, with member counts.",
    parameters: {},
    handler: async (_params: Record<string, unknown>, auth: AuthContext) => {
      return daemonRequest(apiBase, "/plugins/discord/guilds", auth);
    },
  });

  // 3. listChannels
  registry.register({
    name: "listChannels",
    description: "List channels in a specific Discord guild that the bot can see.",
    parameters: {
      guildId: {
        type: "string",
        description: "The Discord guild (server) ID to list channels for",
        required: true,
      },
    },
    handler: async (params: Record<string, unknown>, auth: AuthContext) => {
      const guildId = params.guildId as string;
      if (!guildId) {
        throw new Error("Parameter 'guildId' is required");
      }
      return daemonRequest(apiBase, `/plugins/discord/guilds/${encodeURIComponent(guildId)}/channels`, auth);
    },
  });

  // 4. getMessageStats
  registry.register({
    name: "getMessageStats",
    description: "Get message processing statistics: active Discord sessions and connected guilds.",
    parameters: {},
    handler: async (_params: Record<string, unknown>, auth: AuthContext) => {
      return daemonRequest(apiBase, "/plugins/discord/stats", auth);
    },
  });
}
