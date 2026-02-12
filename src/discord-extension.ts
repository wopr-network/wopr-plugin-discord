/**
 * Discord Extension (cross-plugin API)
 *
 * Provides the extension object registered with core for other plugins
 * to interact with the Discord bot (friend requests, ownership, etc.).
 */

import type { Client } from "discord.js";
import {
  createFriendRequestButtons,
  createFriendRequestEmbed,
  getOwnerUserId,
  storePendingButtonRequest,
} from "./friend-buttons.js";
import { logger } from "./logger.js";
import { claimPairingCode, hasOwner, setOwner } from "./pairing.js";
import type { WOPRPluginContext } from "./types.js";

async function sendFriendRequestNotification(
  ctx: WOPRPluginContext,
  client: Client,
  requestFrom: string,
  pubkey: string,
  encryptPub: string,
  channelId: string,
  channelName: string,
  signature: string,
): Promise<boolean> {
  const config = ctx.getConfig<{ ownerUserId?: string }>();
  if (!config.ownerUserId) {
    logger.warn({ msg: "No ownerUserId configured - friend request notification not sent" });
    return false;
  }

  try {
    const owner = await client.users.fetch(config.ownerUserId);
    if (!owner) {
      logger.warn({ msg: "Could not fetch owner user", ownerUserId: config.ownerUserId });
      return false;
    }

    const validationError = storePendingButtonRequest(requestFrom, pubkey, encryptPub, channelId, signature);
    if (validationError) {
      logger.warn({ msg: "Friend request rejected: invalid keys", requestFrom, error: validationError });
      return false;
    }

    const pubkeyShort = `${pubkey.slice(0, 12)}...`;
    const embed = createFriendRequestEmbed(requestFrom, pubkeyShort, channelName);
    const buttons = createFriendRequestButtons(requestFrom);

    await owner.send({
      embeds: [embed],
      components: [buttons],
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
}

export function createDiscordExtension(
  getClient: () => Client | null,
  getCtx: () => WOPRPluginContext | null,
): DiscordExtension {
  return {
    sendFriendRequestNotification: async (
      requestFrom: string,
      pubkey: string,
      encryptPub: string,
      channelId: string,
      channelName: string,
      signature: string,
    ): Promise<boolean> => {
      const currentCtx = getCtx();
      const currentClient = getClient();
      if (!currentCtx || !currentClient) return false;
      return sendFriendRequestNotification(
        currentCtx,
        currentClient,
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
  };
}
