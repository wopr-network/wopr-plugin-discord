/**
 * Discord utility functions for session key generation, mention
 * resolution, and channel ID lookup.
 */

import { type ChatInputCommandInteraction, DMChannel, type Message, TextChannel, ThreadChannel } from "discord.js";

/**
 * Sanitize a name for use in session keys (lowercase, replace spaces with -).
 */
function sanitize(name: string): string {
  return name
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9_-]/g, "");
}

/**
 * Generate a readable session key from a Discord channel.
 * Format:
 * - Guild channels: discord:guildName:#channelName
 * - Threads: discord:guildName:#parentChannel/threadName
 * - DMs: discord:dm:username
 */
export function getSessionKey(channel: TextChannel | ThreadChannel | DMChannel): string {
  if (channel.isDMBased()) {
    const dm = channel as DMChannel;
    const recipientName = dm.recipient?.username || "unknown";
    return `discord:dm:${sanitize(recipientName)}`;
  }

  if (channel.isThread()) {
    const thread = channel as ThreadChannel;
    const guildName = thread.guild?.name || "unknown";
    const parentName = thread.parent?.name || "unknown";
    return `discord:${sanitize(guildName)}:#${sanitize(parentName)}/${sanitize(thread.name)}`;
  }

  const textChannel = channel as TextChannel;
  const guildName = textChannel.guild?.name || "unknown";
  return `discord:${sanitize(guildName)}:#${sanitize(textChannel.name)}`;
}

/**
 * Get session key from interaction (for slash commands).
 */
export function getSessionKeyFromInteraction(interaction: ChatInputCommandInteraction): string {
  const channel = interaction.channel;
  if (channel && (channel instanceof TextChannel || channel instanceof ThreadChannel || channel instanceof DMChannel)) {
    return getSessionKey(channel);
  }
  return `discord:${interaction.channelId}`;
}

/**
 * Resolve Discord mentions in message content to readable names.
 * Converts <@USER_ID> to @Username and <#CHANNEL_ID> to #channel-name
 */
export function resolveMentions(message: Message): string {
  let content = message.content;

  // Resolve user mentions: <@USER_ID> or <@!USER_ID> -> @Username [USER_ID]
  for (const [userId, user] of message.mentions.users) {
    const member = message.guild?.members.cache.get(userId);
    const displayName = member?.displayName || user.displayName || user.username;
    content = content.replace(new RegExp(`<@!?${userId}>`, "g"), `@${displayName} [${userId}]`);
  }

  // Resolve channel mentions: <#CHANNEL_ID> -> #channel-name [CHANNEL_ID]
  for (const [channelId, channel] of message.mentions.channels) {
    const channelName = (channel as { name?: string }).name || channelId;
    content = content.replace(new RegExp(`<#${channelId}>`, "g"), `#${channelName} [${channelId}]`);
  }

  // Resolve role mentions: <@&ROLE_ID> -> @RoleName [ROLE_ID]
  for (const [roleId, role] of message.mentions.roles) {
    content = content.replace(new RegExp(`<@&${roleId}>`, "g"), `@${role.name} [${roleId}]`);
  }

  return content;
}
