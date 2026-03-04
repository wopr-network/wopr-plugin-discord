/**
 * Discord Friend Request Buttons
 *
 * Creates interactive Accept/Deny buttons for friend requests.
 * Only visible to the bot owner via ephemeral messages.
 */

import { ActionRowBuilder, ButtonBuilder, type ButtonInteraction, ButtonStyle, EmbedBuilder } from "discord.js";
import type { WOPRPluginContext } from "./types.js";

// Align button request TTL with pairing code TTL (15 minutes)
const BUTTON_REQUEST_TTL_MS = 15 * 60 * 1000;

const UNAUTHORIZED_MESSAGE = "Unauthorized";

// Discord custom ID max length is 100 characters
const DISCORD_CUSTOM_ID_MAX_LENGTH = 100;
// "friend_accept:" = 14 chars (longest prefix)
const MAX_USERNAME_IN_CUSTOM_ID = DISCORD_CUSTOM_ID_MAX_LENGTH - "friend_accept:".length;

/**
 * Pending friend request with button context
 */
export interface PendingButtonRequest {
  requestFrom: string;
  requestPubkey: string;
  encryptPub: string;
  timestamp: number;
  channelId: string;
  messageId?: string;
  signature: string;
}

// Store pending button requests (keyed by requestFrom)
const pendingButtonRequests: Map<string, PendingButtonRequest> = new Map();

/**
 * Validate an Ed25519 public key (32 bytes, hex-encoded = 64 chars)
 */
export function isValidEd25519Pubkey(pubkey: string): boolean {
  if (typeof pubkey !== "string") return false;
  return /^[0-9a-fA-F]{64}$/.test(pubkey);
}

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
 * Store a pending button request after validating pubkey format.
 * Returns an error string if validation fails, undefined on success.
 */
export function storePendingButtonRequest(
  requestFrom: string,
  pubkey: string,
  encryptPub: string,
  channelId: string,
  signature: string,
): string | undefined {
  if (!isValidEd25519Pubkey(pubkey)) {
    return "Invalid public key format (expected 64-char hex Ed25519 key)";
  }

  if (!isValidEd25519Pubkey(encryptPub)) {
    return "Invalid encryption public key format";
  }

  pendingButtonRequests.set(requestFrom.toLowerCase(), {
    requestFrom,
    requestPubkey: pubkey,
    encryptPub,
    timestamp: Date.now(),
    channelId,
    signature,
  });

  return undefined;
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
 * Bind a Discord message ID to a pending button request so we can verify provenance later
 */
export function setMessageIdOnPendingButtonRequest(requestFrom: string, messageId: string): void {
  const pending = pendingButtonRequests.get(requestFrom.toLowerCase());
  if (pending) {
    pending.messageId = messageId;
  }
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
 * Verify button's message ID matches stored pending request
 */
function verifyMessageId(pending: PendingButtonRequest, interaction: ButtonInteraction): boolean {
  if (pending.messageId === undefined) return true;
  return pending.messageId === interaction.message?.id;
}

/**
 * Handle accept action
 */
async function handleAccept(
  parsed: ReturnType<typeof parseButtonCustomId>,
  pending: PendingButtonRequest,
  interaction: ButtonInteraction,
  ctx: WOPRPluginContext,
  onAccept: (from: string, pending: PendingButtonRequest) => Promise<string>,
): Promise<void> {
  const from = parsed?.from;
  if (!from) return;

  try {
    const acceptMessage = await onAccept(from, pending);
    removePendingButtonRequest(from);

    await interaction.editReply({
      content: `Friend request from @${from} **accepted**.`,
      embeds: [],
      components: [],
    });

    const channel = interaction.client.channels.cache.get(pending.channelId);
    if (channel?.isTextBased() && "send" in channel) {
      await channel.send(acceptMessage);
    }

    ctx.log.info(`[discord] Friend request from ${from} accepted via button`);
  } catch (err) {
    await interaction.followUp({
      content: `Failed to accept friend request: ${err}`,
      ephemeral: true,
    });
  }
}

/**
 * Handle deny action
 */
async function handleDeny(
  parsed: ReturnType<typeof parseButtonCustomId>,
  interaction: ButtonInteraction,
  ctx: WOPRPluginContext,
  onDeny: (from: string) => Promise<void>,
): Promise<void> {
  const from = parsed?.from;
  if (!from) return;

  try {
    await onDeny(from);
    removePendingButtonRequest(from);

    await interaction.editReply({
      content: `Friend request from @${from} **denied**.`,
      embeds: [],
      components: [],
    });

    ctx.log.info(`[discord] Friend request from ${from} denied via button`);
  } catch (err) {
    await interaction.followUp({
      content: `Failed to deny friend request: ${err}`,
      ephemeral: true,
    });
  }
}

export async function handleFriendButtonInteraction(
  interaction: ButtonInteraction,
  ctx: WOPRPluginContext,
  _botUsername: string,
  onAccept: (from: string, pending: PendingButtonRequest) => Promise<string>,
  onDeny: (from: string) => Promise<void>,
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

  // Get and validate pending request
  const pending = getPendingButtonRequest(parsed.from);
  if (!pending) {
    await interaction.reply({
      content: `Friend request from @${parsed.from} has expired or was already handled.`,
      ephemeral: true,
    });
    return;
  }

  // Verify message ID matches
  if (!verifyMessageId(pending, interaction)) {
    await replyWithError(interaction, UNAUTHORIZED_MESSAGE);
    return;
  }

  await interaction.deferUpdate();

  if (parsed.action === "accept") {
    await handleAccept(parsed, pending, interaction, ctx, onAccept);
  } else if (parsed.action === "deny") {
    await handleDeny(parsed, interaction, ctx, onDeny);
  }
}

/**
 * Clean up expired pending requests (older than TTL)
 */
export function cleanupExpiredButtonRequests(): void {
  const now = Date.now();

  for (const [key, request] of pendingButtonRequests) {
    if (now - request.timestamp > BUTTON_REQUEST_TTL_MS) {
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
