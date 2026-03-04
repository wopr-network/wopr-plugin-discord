/**
 * Discord Extension (cross-plugin API)
 *
 * Provides the extension object registered with core for other plugins
 * to interact with the Discord bot (friend requests, ownership, etc.).
 */

import { ChannelType, type Client } from "discord.js";
import { createFriendRequestButtons, createFriendRequestEmbed, getOwnerUserId } from "./friend-buttons.js";
import { logger } from "./logger.js";
import { claimPairingCode, hasOwner, setOwner } from "./pairing.js";
import type { WOPRPluginContext } from "./types.js";

// Callback map: Discord message ID → { onAccept, onDeny, requestFrom, timestamp }
const CALLBACK_TTL_MS = 15 * 60 * 1000; // 15 minutes

type P2PExtension = {
  acceptFriendRequest?: (
    from: string,
    pubkey: string,
    encryptPub: string,
    signature: string,
    channelId: string,
  ) => Promise<{ friend: { name: string }; acceptMessage: string }>;
  denyFriendRequest?: (from: string, signature: string) => Promise<void>;
};

/** Basic sanity check: non-empty, 32–128 chars, only alphanumeric/base64/base58 chars */
function isValidEd25519Pubkey(key: string): boolean {
  if (!key || key.length < 32 || key.length > 128) return false;
  return /^[A-Za-z0-9+/=_-]+$/.test(key);
}

export interface PendingNotificationCallbacks {
  onAccept: () => Promise<void>;
  onDeny: () => Promise<void>;
  requestFrom: string;
  timestamp: number;
}

const pendingCallbacks: Map<string, PendingNotificationCallbacks> = new Map();

export function getPendingCallbacks(messageId: string): PendingNotificationCallbacks | undefined {
  return pendingCallbacks.get(messageId);
}

export function removePendingCallbacks(messageId: string): void {
  pendingCallbacks.delete(messageId);
}

export function clearPendingCallbacks(): void {
  pendingCallbacks.clear();
}

export function cleanupExpiredCallbacks(): void {
  const now = Date.now();
  for (const [key, entry] of pendingCallbacks) {
    if (now - entry.timestamp > CALLBACK_TTL_MS) {
      pendingCallbacks.delete(key);
    }
  }
}

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

async function sendFriendRequestNotification(
  getCtx: () => WOPRPluginContext | null,
  getClient: () => Client | null,
  requestFrom: string,
  pubkey: string,
  encryptPub: string,
  channelId: string,
  channelName: string,
  signature: string,
): Promise<boolean> {
  const ctx = getCtx();
  const client = getClient();
  if (!ctx || !client) return false;

  const config = ctx.getConfig<{ ownerUserId?: string }>();
  if (!config.ownerUserId) {
    logger.warn({ msg: "No ownerUserId configured - friend request notification not sent" });
    return false;
  }

  if (!isValidEd25519Pubkey(pubkey) || !isValidEd25519Pubkey(encryptPub)) {
    logger.warn({ msg: "Invalid pubkey or encryptPub in friend request - notification not sent", requestFrom });
    return false;
  }

  try {
    const owner = await client.users.fetch(config.ownerUserId);
    if (!owner) {
      logger.warn({ msg: "Could not fetch owner user", ownerUserId: config.ownerUserId });
      return false;
    }

    const pubkeyShort = `${pubkey.slice(0, 12)}...`;
    const embed = createFriendRequestEmbed(requestFrom, pubkeyShort, channelName);
    const buttons = createFriendRequestButtons(requestFrom);

    const sentMessage = await owner.send({
      embeds: [embed],
      components: [buttons],
    });

    // Store callbacks keyed by Discord message ID.
    // P2P extension is resolved fresh at click time so hot-reloads are handled correctly.
    pendingCallbacks.set(sentMessage.id, {
      requestFrom,
      timestamp: Date.now(),
      onAccept: async () => {
        const currentCtx = getCtx();
        const currentClient = getClient();
        const p2pExt = currentCtx?.getExtension?.("p2p") as P2PExtension | undefined;
        if (!p2pExt?.acceptFriendRequest) {
          throw new Error("P2P extension not available");
        }
        const result = await p2pExt.acceptFriendRequest(requestFrom, pubkey, encryptPub, signature, channelId);
        try {
          const channel = currentClient?.channels.cache.get(channelId);
          if (channel?.isTextBased() && "send" in channel) {
            await channel.send(result.acceptMessage);
          }
        } catch (e) {
          logger.warn({ msg: "Failed to send accept message to channel", error: String(e) });
        }
      },
      onDeny: async () => {
        const currentCtx = getCtx();
        const p2pExt = currentCtx?.getExtension?.("p2p") as P2PExtension | undefined;
        if (!p2pExt?.denyFriendRequest) {
          throw new Error("P2P extension not available");
        }
        await p2pExt.denyFriendRequest(requestFrom, signature);
      },
    });

    logger.info({ msg: "Friend request notification sent to owner", requestFrom, ownerUserId: config.ownerUserId });
    return true;
  } catch (err) {
    logger.error({ msg: "Failed to send friend request notification", error: String(err) });
    return false;
  }
}

export interface DiscordExtension {
  sendFriendRequestNotification: (
    requestFrom: string,
    pubkey: string,
    encryptPub: string,
    channelId: string,
    channelName: string,
    signature: string,
  ) => Promise<boolean>;
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
    sendFriendRequestNotification: (
      requestFrom: string,
      pubkey: string,
      encryptPub: string,
      channelId: string,
      channelName: string,
      signature: string,
    ): Promise<boolean> => {
      return sendFriendRequestNotification(
        getCtx,
        getClient,
        requestFrom,
        pubkey,
        encryptPub,
        channelId,
        channelName,
        signature,
      );
    },

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
      return currentCtx ? getOwnerUserId(currentCtx) : null;
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
