import { createWriteStream, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import {
  type ChatInputCommandInteraction,
  DMChannel,
  type Message,
  REST,
  Routes,
  SlashCommandBuilder,
  TextChannel,
  ThreadChannel,
} from "discord.js";
import { logger } from "./logger.js";

/**
 * Generate a readable session key from a Discord channel.
 * Format:
 * - Guild channels: discord:guildName:#channelName
 * - Threads: discord:guildName:#parentChannel/threadName
 * - DMs: discord:dm:username
 */
export function getSessionKey(channel: TextChannel | ThreadChannel | DMChannel): string {
  // Sanitize name for use in session key (lowercase, replace spaces with -)
  const sanitize = (name: string) =>
    name
      .toLowerCase()
      .replace(/\s+/g, "-")
      .replace(/[^a-z0-9-_]/g, "");

  if (channel.isDMBased()) {
    // DM channel - use recipient username
    const dm = channel as DMChannel;
    const recipientName = dm.recipient?.username || "unknown";
    return `discord:dm:${sanitize(recipientName)}`;
  }

  if (channel.isThread()) {
    // Thread - include parent channel
    const thread = channel as ThreadChannel;
    const guildName = thread.guild?.name || "unknown";
    const parentName = thread.parent?.name || "unknown";
    return `discord:${sanitize(guildName)}:#${sanitize(parentName)}/${sanitize(thread.name)}`;
  }

  // Regular text channel
  const textChannel = channel as TextChannel;
  const guildName = textChannel.guild?.name || "unknown";
  return `discord:${sanitize(guildName)}:#${sanitize(textChannel.name)}`;
}

/**
 * Get session key from interaction (for slash commands)
 */
export function getSessionKeyFromInteraction(interaction: ChatInputCommandInteraction): string {
  const channel = interaction.channel;
  if (channel && (channel instanceof TextChannel || channel instanceof ThreadChannel || channel instanceof DMChannel)) {
    return getSessionKey(channel);
  }
  // Fallback to channel ID if we can't resolve the channel type
  return `discord:${interaction.channelId}`;
}

/**
 * Resolve Discord mentions in message content to readable names.
 * Converts <@USER_ID> to @Username and <#CHANNEL_ID> to #channel-name
 */
export function resolveMentions(message: Message): string {
  let content = message.content;

  // Resolve user mentions: <@USER_ID> or <@!USER_ID> -> @Username [USER_ID]
  // Include both display name for readability AND ID for when WOPR needs to mention back
  for (const [userId, user] of message.mentions.users) {
    const member = message.guild?.members.cache.get(userId);
    const displayName = member?.displayName || user.displayName || user.username;
    // Replace both <@ID> and <@!ID> formats with @Name [ID]
    content = content.replace(new RegExp(`<@!?${userId}>`, "g"), `@${displayName} [${userId}]`);
  }

  // Resolve channel mentions: <#CHANNEL_ID> -> #channel-name [CHANNEL_ID]
  for (const [channelId, channel] of message.mentions.channels) {
    const channelName = (channel as any).name || channelId;
    content = content.replace(new RegExp(`<#${channelId}>`, "g"), `#${channelName} [${channelId}]`);
  }

  // Resolve role mentions: <@&ROLE_ID> -> @RoleName [ROLE_ID]
  for (const [roleId, role] of message.mentions.roles) {
    content = content.replace(new RegExp(`<@&${roleId}>`, "g"), `@${role.name} [${roleId}]`);
  }

  return content;
}

/**
 * Find the Discord channel ID from a session's conversation log.
 * Looks for the most recent message with a Discord channel reference.
 */
export function findChannelIdFromConversationLog(sessionName: string): string | null {
  const sessionsDir = process.env.WOPR_HOME ? path.join(process.env.WOPR_HOME, "sessions") : "/data/sessions";
  const logPath = path.join(sessionsDir, `${sessionName}.conversation.jsonl`);

  if (!existsSync(logPath)) {
    logger.debug({ msg: "Conversation log not found", sessionName, logPath });
    return null;
  }

  try {
    const content = readFileSync(logPath, "utf-8");
    const lines = content
      .trim()
      .split("\n")
      .filter((l) => l);

    // Search from most recent entry backwards for a Discord channel reference
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const entry = JSON.parse(lines[i]);
        if (entry.channel?.type === "discord" && entry.channel?.id) {
          logger.debug({ msg: "Found Discord channel ID", sessionName, channelId: entry.channel.id });
          return entry.channel.id;
        }
      } catch {
        // Skip malformed lines
      }
    }

    logger.debug({ msg: "No Discord channel found in conversation log", sessionName });
    return null;
  } catch (err) {
    logger.error({ msg: "Error reading conversation log", sessionName, error: String(err) });
    return null;
  }
}

// Attachments directory
export const ATTACHMENTS_DIR = existsSync("/data") ? "/data/attachments" : path.join(process.cwd(), "attachments");

/**
 * Download and save message attachments to disk
 * Returns array of file paths
 */
export async function saveAttachments(message: Message): Promise<string[]> {
  if (!message.attachments.size) return [];

  // Ensure attachments directory exists
  if (!existsSync(ATTACHMENTS_DIR)) {
    mkdirSync(ATTACHMENTS_DIR, { recursive: true });
  }

  const savedPaths: string[] = [];

  for (const [, attachment] of message.attachments) {
    try {
      // Create unique filename: timestamp-originalname
      const timestamp = Date.now();
      const safeName = attachment.name?.replace(/[^a-zA-Z0-9._-]/g, "_") || "attachment";
      const filename = `${timestamp}-${message.author.id}-${safeName}`;
      const filepath = path.join(ATTACHMENTS_DIR, filename);

      // Download the attachment
      const response = await fetch(attachment.url);
      if (!response.ok) {
        logger.warn({ msg: "Failed to download attachment", url: attachment.url, status: response.status });
        continue;
      }

      // Save to disk
      const fileStream = createWriteStream(filepath);
      await pipeline(response.body as any, fileStream);

      savedPaths.push(filepath);
      logger.info({ msg: "Attachment saved", filename, size: attachment.size, contentType: attachment.contentType });
    } catch (err) {
      logger.error({ msg: "Error saving attachment", name: attachment.name, error: String(err) });
    }
  }

  return savedPaths;
}

// Slash command definitions
export const commands = [
  new SlashCommandBuilder().setName("status").setDescription("Show session status and configuration"),
  new SlashCommandBuilder().setName("new").setDescription("Start a new session (reset conversation)"),
  new SlashCommandBuilder().setName("reset").setDescription("Reset the current session (alias for /new)"),
  new SlashCommandBuilder().setName("compact").setDescription("Compact session context (summarize conversation)"),
  new SlashCommandBuilder()
    .setName("think")
    .setDescription("Set the thinking level for responses")
    .addStringOption((option) =>
      option
        .setName("level")
        .setDescription("Thinking level")
        .setRequired(true)
        .addChoices(
          { name: "Off", value: "off" },
          { name: "Minimal", value: "minimal" },
          { name: "Low", value: "low" },
          { name: "Medium", value: "medium" },
          { name: "High", value: "high" },
          { name: "Maximum", value: "xhigh" },
        ),
    ),
  new SlashCommandBuilder()
    .setName("verbose")
    .setDescription("Toggle verbose mode")
    .addBooleanOption((option) =>
      option.setName("enabled").setDescription("Enable or disable verbose mode").setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName("usage")
    .setDescription("Set usage tracking display")
    .addStringOption((option) =>
      option
        .setName("mode")
        .setDescription("Usage display mode")
        .setRequired(true)
        .addChoices(
          { name: "Off", value: "off" },
          { name: "Tokens only", value: "tokens" },
          { name: "Full", value: "full" },
        ),
    ),
  new SlashCommandBuilder()
    .setName("session")
    .setDescription("Switch to a different session")
    .addStringOption((option) => option.setName("name").setDescription("Session name").setRequired(true)),
  new SlashCommandBuilder()
    .setName("wopr")
    .setDescription("Send a message to WOPR")
    .addStringOption((option) => option.setName("message").setDescription("Your message").setRequired(true)),
  new SlashCommandBuilder().setName("help").setDescription("Show available commands and help"),
  new SlashCommandBuilder()
    .setName("claim")
    .setDescription("Claim ownership of this bot with a pairing code (DM only)")
    .addStringOption((option) =>
      option.setName("code").setDescription("The pairing code you received").setRequired(true),
    ),
  new SlashCommandBuilder().setName("cancel").setDescription("Cancel the current AI response in progress"),
  new SlashCommandBuilder()
    .setName("model")
    .setDescription("Switch the AI model for this session")
    .addStringOption((option) =>
      option
        .setName("model")
        .setDescription("Model name or ID (e.g. opus, haiku, gpt-5.2)")
        .setRequired(true)
        .setAutocomplete(true),
    ),
];

/**
 * Register slash commands with Discord
 */
export async function registerSlashCommands(token: string, clientId: string, guildId?: string) {
  const rest = new REST({ version: "10" }).setToken(token);

  try {
    logger.info("Registering slash commands...");

    if (guildId) {
      // Register to specific guild (faster for development)
      await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: commands.map((cmd) => cmd.toJSON()) });
      logger.info(`Registered ${commands.length} commands to guild ${guildId}`);
    } else {
      // Register globally (can take up to 1 hour to propagate)
      await rest.put(Routes.applicationCommands(clientId), { body: commands.map((cmd) => cmd.toJSON()) });
      logger.info(`Registered ${commands.length} global commands`);
    }
  } catch (error) {
    logger.error({ msg: "Failed to register commands", error: String(error) });
  }
}
