/**
 * Discord Friend Request Buttons
 *
 * Creates interactive Accept/Deny buttons for friend requests.
 * Only visible to the bot owner via ephemeral messages.
 */

import {
  ButtonBuilder,
  ButtonStyle,
  ActionRowBuilder,
  Message,
  TextChannel,
  EmbedBuilder,
  ButtonInteraction,
} from "discord.js";
import type { WOPRPluginContext } from "./types.js";

/**
 * Pending friend request with button context
 */
interface PendingButtonRequest {
  requestFrom: string;       // Username of requester
  requestPubkey: string;     // Public key of requester
  encryptPub: string;        // Encryption pubkey
  timestamp: number;
  channelId: string;
  messageId?: string;        // ID of the notification message
  signature: string;
}

// Store pending button requests (keyed by requestFrom)
const pendingButtonRequests: Map<string, PendingButtonRequest> = new Map();

/**
 * Create Accept/Deny buttons for a friend request
 */
export function createFriendRequestButtons(requestFrom: string): ActionRowBuilder<ButtonBuilder> {
  const acceptButton = new ButtonBuilder()
    .setCustomId(`friend_accept:${requestFrom}`)
    .setLabel("Accept")
    .setStyle(ButtonStyle.Success)
    .setEmoji("✅");

  const denyButton = new ButtonBuilder()
    .setCustomId(`friend_deny:${requestFrom}`)
    .setLabel("Deny")
    .setStyle(ButtonStyle.Danger)
    .setEmoji("❌");

  const row = new ActionRowBuilder<ButtonBuilder>()
    .addComponents(acceptButton, denyButton);

  return row;
}

/**
 * Create an embed for the friend request notification
 */
export function createFriendRequestEmbed(
  requestFrom: string,
  pubkeyShort: string,
  channelName: string
): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(0x5865F2)  // Discord blurple
    .setTitle("Friend Request Received")
    .setDescription(`**@${requestFrom}** wants to be your friend!`)
    .addFields(
      { name: "From", value: `@${requestFrom}`, inline: true },
      { name: "Pubkey", value: pubkeyShort, inline: true },
      { name: "Channel", value: channelName, inline: true }
    )
    .setFooter({ text: "Click Accept to add as friend, Deny to ignore" })
    .setTimestamp();
}

/**
 * Store a pending button request
 */
export function storePendingButtonRequest(
  requestFrom: string,
  pubkey: string,
  encryptPub: string,
  channelId: string,
  signature: string
): void {
  pendingButtonRequests.set(requestFrom.toLowerCase(), {
    requestFrom,
    requestPubkey: pubkey,
    encryptPub,
    timestamp: Date.now(),
    channelId,
    signature,
  });
}

/**
 * Get a pending button request
 */
export function getPendingButtonRequest(requestFrom: string): PendingButtonRequest | undefined {
  return pendingButtonRequests.get(requestFrom.toLowerCase());
}

/**
 * Remove a pending button request
 */
export function removePendingButtonRequest(requestFrom: string): void {
  pendingButtonRequests.delete(requestFrom.toLowerCase());
}

/**
 * Check if an interaction is a friend request button
 */
export function isFriendRequestButton(customId: string): boolean {
  return customId.startsWith("friend_accept:") || customId.startsWith("friend_deny:");
}

/**
 * Parse button custom ID
 */
export function parseButtonCustomId(customId: string): { action: "accept" | "deny"; from: string } | null {
  if (customId.startsWith("friend_accept:")) {
    return { action: "accept", from: customId.slice("friend_accept:".length) };
  }
  if (customId.startsWith("friend_deny:")) {
    return { action: "deny", from: customId.slice("friend_deny:".length) };
  }
  return null;
}

/**
 * Handle a friend request button interaction
 */
export async function handleFriendButtonInteraction(
  interaction: ButtonInteraction,
  ctx: WOPRPluginContext,
  botUsername: string,
  onAccept: (from: string, pending: PendingButtonRequest) => Promise<string>,
  onDeny: (from: string) => Promise<void>
): Promise<void> {
  const parsed = parseButtonCustomId(interaction.customId);
  if (!parsed) return;

  const pending = getPendingButtonRequest(parsed.from);
  if (!pending) {
    await interaction.reply({
      content: `Friend request from @${parsed.from} has expired or was already handled.`,
      ephemeral: true,
    });
    return;
  }

  if (parsed.action === "accept") {
    try {
      const acceptMessage = await onAccept(parsed.from, pending);

      // Remove from pending
      removePendingButtonRequest(parsed.from);

      // Update the original message to show it was accepted
      await interaction.update({
        content: `Friend request from @${parsed.from} **accepted**.`,
        embeds: [],
        components: [],
      });

      // Post the accept message to the channel where the request was received
      const channel = interaction.client.channels.cache.get(pending.channelId);
      if (channel && channel.isTextBased() && "send" in channel) {
        await channel.send(acceptMessage);
      }

      ctx.log.info(`[discord] Friend request from ${parsed.from} accepted via button`);
    } catch (err) {
      await interaction.reply({
        content: `Failed to accept friend request: ${err}`,
        ephemeral: true,
      });
    }
  } else if (parsed.action === "deny") {
    try {
      await onDeny(parsed.from);

      // Remove from pending
      removePendingButtonRequest(parsed.from);

      // Update the original message to show it was denied
      await interaction.update({
        content: `Friend request from @${parsed.from} **denied**.`,
        embeds: [],
        components: [],
      });

      ctx.log.info(`[discord] Friend request from ${parsed.from} denied via button`);
    } catch (err) {
      await interaction.reply({
        content: `Failed to deny friend request: ${err}`,
        ephemeral: true,
      });
    }
  }
}

/**
 * Clean up expired pending requests (older than 5 minutes)
 */
export function cleanupExpiredButtonRequests(): void {
  const now = Date.now();
  const expiry = 5 * 60 * 1000; // 5 minutes

  for (const [key, request] of pendingButtonRequests) {
    if (now - request.timestamp > expiry) {
      pendingButtonRequests.delete(key);
    }
  }
}

/**
 * Get owner user ID from config
 */
export function getOwnerUserId(ctx: WOPRPluginContext): string | null {
  const config = ctx.getConfig<{ ownerUserId?: string }>();
  return config.ownerUserId || null;
}
