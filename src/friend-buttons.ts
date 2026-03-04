/**
 * Discord Friend Request Buttons
 *
 * Creates interactive Accept/Deny buttons for friend requests.
 * Only visible to the bot owner via ephemeral messages.
 */

import { ActionRowBuilder, ButtonBuilder, type ButtonInteraction, ButtonStyle, EmbedBuilder } from "discord.js";
import type { WOPRPluginContext } from "./types.js";

const UNAUTHORIZED_MESSAGE = "Unauthorized";

// Discord custom ID max length is 100 characters
const DISCORD_CUSTOM_ID_MAX_LENGTH = 100;
// "friend_accept:" = 14 chars (longest prefix)
const MAX_USERNAME_IN_CUSTOM_ID = DISCORD_CUSTOM_ID_MAX_LENGTH - "friend_accept:".length;

/**
 * Truncate a username to fit within Discord's 100-char custom ID limit
 */
function truncateForCustomId(username: string): string {
  if (username.length <= MAX_USERNAME_IN_CUSTOM_ID) {
    return username;
  }
  return username.slice(0, MAX_USERNAME_IN_CUSTOM_ID);
}

/**
 * Create Accept/Deny buttons for a friend request
 */
export function createFriendRequestButtons(requestFrom: string): ActionRowBuilder<ButtonBuilder> {
  const truncatedFrom = truncateForCustomId(requestFrom);

  const acceptButton = new ButtonBuilder()
    .setCustomId(`friend_accept:${truncatedFrom}`)
    .setLabel("Accept")
    .setStyle(ButtonStyle.Success)
    .setEmoji("✅");

  const denyButton = new ButtonBuilder()
    .setCustomId(`friend_deny:${truncatedFrom}`)
    .setLabel("Deny")
    .setStyle(ButtonStyle.Danger)
    .setEmoji("❌");

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(acceptButton, denyButton);

  return row;
}

/**
 * Create an embed for the friend request notification
 */
export function createFriendRequestEmbed(requestFrom: string, pubkeyShort: string, channelName: string): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle("Friend Request Received")
    .setDescription(`**@${requestFrom}** wants to be your friend!`)
    .addFields(
      { name: "From", value: `@${requestFrom}`, inline: true },
      { name: "Pubkey", value: pubkeyShort, inline: true },
      { name: "Channel", value: channelName, inline: true },
    )
    .setFooter({ text: "Click Accept to add as friend, Deny to ignore" })
    .setTimestamp();
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
 * Send an error response, using followUp if already deferred/replied, else reply
 */
async function replyWithError(interaction: ButtonInteraction, message: string): Promise<void> {
  const payload = { content: message, ephemeral: true } as const;
  if (interaction.deferred || interaction.replied) {
    await interaction.followUp(payload);
  } else {
    await interaction.reply(payload);
  }
}

/**
 * Verify button originated from this bot's own DM
 */
function verifyBotOrigin(interaction: ButtonInteraction): boolean {
  const botId = interaction.client.user?.id;
  return !!(botId && interaction.message?.author?.id === botId);
}

/**
 * Verify clicking user is the bot owner
 */
function verifyOwnerUser(interaction: ButtonInteraction, ctx: WOPRPluginContext): boolean {
  const ownerId = getOwnerUserId(ctx);
  return !!(ownerId && interaction.user.id === ownerId);
}

/**
 * Handle a friend request button interaction.
 * Callbacks are looked up by the caller (keyed by message ID in discord-extension.ts).
 */
export async function handleFriendButtonInteraction(
  interaction: ButtonInteraction,
  ctx: WOPRPluginContext,
  onAccept: () => Promise<void>,
  onDeny: () => Promise<void>,
): Promise<void> {
  const parsed = parseButtonCustomId(interaction.customId);
  if (!parsed) return;

  // Verify button originated from this bot
  if (!verifyBotOrigin(interaction)) {
    await replyWithError(interaction, UNAUTHORIZED_MESSAGE);
    return;
  }

  // Verify clicking user is the owner
  if (!verifyOwnerUser(interaction, ctx)) {
    await replyWithError(interaction, UNAUTHORIZED_MESSAGE);
    return;
  }

  await interaction.deferUpdate();

  if (parsed.action === "accept") {
    try {
      await onAccept();

      await interaction.editReply({
        content: `Friend request from @${parsed.from} **accepted**.`,
        embeds: [],
        components: [],
      });

      ctx.log.info(`[discord] Friend request from ${parsed.from} accepted via button`);
    } catch (err) {
      ctx.log.error("[discord] Failed to accept friend request", { from: parsed.from, err });
      await interaction.followUp({
        content: "Failed to accept friend request. Please try again later.",
        ephemeral: true,
      });
    }
  } else if (parsed.action === "deny") {
    try {
      await onDeny();

      await interaction.editReply({
        content: `Friend request from @${parsed.from} **denied**.`,
        embeds: [],
        components: [],
      });

      ctx.log.info(`[discord] Friend request from ${parsed.from} denied via button`);
    } catch (err) {
      ctx.log.error("[discord] Failed to deny friend request", { from: parsed.from, err });
      await interaction.followUp({
        content: "Failed to deny friend request. Please try again later.",
        ephemeral: true,
      });
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
