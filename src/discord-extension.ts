/**
 * Discord Extension (cross-plugin API)
 *
 * Provides the extension object registered with core for other plugins
 * to interact with the Discord bot (ownership, status, etc.).
 */

import { ChannelType, type Client } from "discord.js";
import { claimPairingCode, hasOwner, setOwner } from "./pairing.js";
import type { WOPRPluginContext } from "./types.js";

// ============================================================================
// Structured return types for WebMCP-facing extension methods
// ============================================================================

export interface DiscordStatusInfo {
  online: boolean;
  username: string;
  guildsCount: number;
  latencyMs: number;
  uptimeMs: number | null;
}

export interface GuildInfo {
  id: string;
  name: string;
  memberCount: number;
  icon: string | null;
}

export interface ChannelInfo {
  id: string;
  name: string;
  type: string;
  position: number;
}

export interface MessageStatsInfo {
  sessionsActive: number;
  guildsConnected: number;
}

export interface DiscordExtension {
  getBotUsername: () => string;
  claimOwnership: (
    code: string,
    sourceId?: string,
    claimingUserId?: string,
  ) => Promise<{ success: boolean; userId?: string; username?: string; error?: string }>;
  hasOwner: () => boolean;
  getOwnerId: () => string | null;

  // Read-only WebMCP data methods
  getStatus: () => DiscordStatusInfo;
  listGuilds: () => GuildInfo[];
  listChannels: (guildId: string) => ChannelInfo[];
  getMessageStats: () => MessageStatsInfo;
}

export function createDiscordExtension(
  getClient: () => Client | null,
  getCtx: () => WOPRPluginContext | null,
): DiscordExtension {
  return {
    getBotUsername: () => getClient()?.user?.username || "unknown",

    claimOwnership: async (
      code: string,
      sourceId?: string,
      claimingUserId?: string,
    ): Promise<{ success: boolean; userId?: string; username?: string; error?: string }> => {
      const currentCtx = getCtx();
      if (!currentCtx) return { success: false, error: "Discord plugin not initialized" };

      const result = claimPairingCode(code, sourceId, claimingUserId);
      if (!result.request) {
        return { success: false, error: result.error || "Invalid or expired pairing code" };
      }

      await setOwner(currentCtx, result.request.discordUserId);

      return {
        success: true,
        userId: result.request.discordUserId,
        username: result.request.discordUsername,
      };
    },

    hasOwner: () => {
      const currentCtx = getCtx();
      return currentCtx ? hasOwner(currentCtx) : false;
    },

    getOwnerId: () => {
      const currentCtx = getCtx();
      if (!currentCtx) return null;
      const config = currentCtx.getConfig<{ ownerUserId?: string }>();
      return config.ownerUserId || null;
    },

    getStatus: (): DiscordStatusInfo => {
      const currentClient = getClient();
      if (!currentClient) {
        return { online: false, username: "unknown", guildsCount: 0, latencyMs: -1, uptimeMs: null };
      }
      return {
        online: currentClient.isReady(),
        username: currentClient.user?.username || "unknown",
        guildsCount: currentClient.guilds.cache.size,
        latencyMs: currentClient.ws.ping,
        uptimeMs: currentClient.uptime,
      };
    },

    listGuilds: (): GuildInfo[] => {
      const currentClient = getClient();
      if (!currentClient) return [];
      return currentClient.guilds.cache.map((g) => ({
        id: g.id,
        name: g.name,
        memberCount: g.memberCount,
        icon: g.iconURL({ size: 64 }),
      }));
    },

    listChannels: (guildId: string): ChannelInfo[] => {
      const currentClient = getClient();
      if (!currentClient) return [];
      const guild = currentClient.guilds.cache.get(guildId);
      if (!guild) return [];

      const channelTypeLabel = (type: ChannelType): string => {
        switch (type) {
          case ChannelType.GuildText:
            return "text";
          case ChannelType.GuildVoice:
            return "voice";
          case ChannelType.GuildCategory:
            return "category";
          case ChannelType.GuildAnnouncement:
            return "announcement";
          case ChannelType.GuildStageVoice:
            return "stage";
          case ChannelType.GuildForum:
            return "forum";
          default:
            return "other";
        }
      };

      return guild.channels.cache.map((ch) => ({
        id: ch.id,
        name: ch.name,
        type: channelTypeLabel(ch.type),
        position: "position" in ch ? (ch.position as number) : 0,
      }));
    },

    getMessageStats: (): MessageStatsInfo => {
      const currentClient = getClient();
      const currentCtx = getCtx();
      return {
        sessionsActive: currentCtx ? currentCtx.getSessions().filter((s) => s.startsWith("discord:")).length : 0,
        guildsConnected: currentClient ? currentClient.guilds.cache.size : 0,
      };
    },
  };
}
