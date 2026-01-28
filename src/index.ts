/**
 * WOPR Discord Plugin
 * Streaming with proper message coalescing
 */

import { Client, GatewayIntentBits, Events, Message, TextChannel, ThreadChannel, DMChannel } from "discord.js";
import winston from "winston";
import path from "path";
import type { WOPRPlugin, WOPRPluginContext, ConfigSchema, StreamMessage } from "./types.js";

const logger = winston.createLogger({
  level: "info",
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  defaultMeta: { service: "wopr-plugin-discord" },
  transports: [
    new winston.transports.File({ 
      filename: path.join(process.env.WOPR_HOME || "/tmp/wopr-test", "logs", "discord-plugin-error.log"),
      level: "error"
    }),
    new winston.transports.File({ 
      filename: path.join(process.env.WOPR_HOME || "/tmp/wopr-test", "logs", "discord-plugin.log")
    }),
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.simple()
      ),
      level: "warn"
    })
  ],
});

let client: Client | null = null;
let ctx: WOPRPluginContext | null = null;

const configSchema: ConfigSchema = {
  title: "Discord Integration",
  description: "Configure Discord bot integration",
  fields: [
    {
      name: "token",
      type: "password",
      label: "Discord Bot Token",
      placeholder: "Bot token from Discord Developer Portal",
      required: true,
      description: "Your Discord bot token",
    },
    {
      name: "guildId",
      type: "text",
      label: "Guild ID (optional)",
      placeholder: "Server ID to restrict bot to",
      description: "Restrict bot to a specific Discord server",
    },
    {
      name: "pairingRequests",
      type: "object",
      hidden: true,
      default: {},
    },
    {
      name: "mappings",
      type: "object",
      hidden: true,
      default: {},
    },
  ],
};

const DISCORD_LIMIT = 2000;
const IDLE_TIMEOUT_MS = 500; // Send message after 500ms of no new tokens

interface ActiveStream {
  channel: TextChannel | ThreadChannel | DMChannel;
  replyTo: Message;
  activeMessage: Message | null; // The ONE message we're currently editing
  buffer: string;
  lastEditLength: number; // How much of buffer we've sent to Discord
  idleTimer: NodeJS.Timeout | null;
  isComplete: boolean;
}

const activeStreams = new Map<string, ActiveStream>();

async function updateActiveMessage(stream: ActiveStream) {
  if (stream.isComplete) return;
  
  const content = stream.buffer.trim();
  if (!content) return;
  
  // Don't update if nothing new to show
  if (content.length <= stream.lastEditLength) return;
  
  try {
    if (!stream.activeMessage) {
      // Create new message (first one is a reply, rest are channel sends)
      const isFirstMessage = stream.lastEditLength === 0;
      if (isFirstMessage) {
        logger.info({ msg: "Creating reply message", contentLength: content.length });
        stream.activeMessage = await stream.replyTo.reply(content.slice(0, DISCORD_LIMIT));
      } else {
        logger.info({ msg: "Creating follow-up message", contentLength: content.length });
        stream.activeMessage = await (stream.channel as TextChannel | ThreadChannel | DMChannel).send(content.slice(0, DISCORD_LIMIT));
      }
      stream.lastEditLength = content.length;
    } else if (content.length <= DISCORD_LIMIT) {
      // Update existing message
      await stream.activeMessage.edit(content);
      stream.lastEditLength = content.length;
    } else {
      // Would exceed limit - finalize current and start new
      logger.info({ msg: "Message would exceed limit, starting new", currentLength: stream.lastEditLength, newContent: content.length });
      stream.activeMessage = null;
      stream.lastEditLength = 0;
      stream.buffer = content; // Keep full buffer for new message
      await updateActiveMessage(stream);
    }
  } catch (error) {
    logger.error({ msg: "Failed to update message", error: String(error) });
  }
}

function finalizeMessage(stream: ActiveStream) {
  if (stream.isComplete) return;
  stream.isComplete = true;
  
  if (stream.idleTimer) {
    clearTimeout(stream.idleTimer);
    stream.idleTimer = null;
  }
  
  // One final update
  updateActiveMessage(stream).catch(() => {});
  
  logger.info({ msg: "Message finalized", finalLength: stream.buffer.length });
}

function scheduleIdleCheck(sessionKey: string, stream: ActiveStream) {
  if (stream.idleTimer) clearTimeout(stream.idleTimer);
  
  stream.idleTimer = setTimeout(() => {
    logger.info({ msg: "Idle timeout - finalizing message", sessionKey, bufferLength: stream.buffer.length });
    finalizeMessage(stream);
  }, IDLE_TIMEOUT_MS);
}

async function handleStreamChunk(msg: StreamMessage, sessionKey: string) {
  if (msg.type !== "text" || !msg.content) return;
  
  const stream = activeStreams.get(sessionKey);
  if (!stream || stream.isComplete) return;
  
  // If we have an active message, check if we should start a new one
  // (this happens after a temporal gap when the previous message was finalized)
  if (stream.activeMessage && stream.isComplete) {
    // Previous message was finalized, start fresh
    stream.activeMessage = null;
    stream.lastEditLength = 0;
    stream.buffer = "";
    stream.isComplete = false;
  }
  
  // Append content
  stream.buffer += msg.content;
  
  // Update the active message
  await updateActiveMessage(stream);
  
  // Reset idle timer
  scheduleIdleCheck(sessionKey, stream);
}

async function handleMessage(message: Message) {
  if (!client || !ctx) return;
  if (message.author.bot) return;
  if (!client.user) return;

  const isDirectlyMentioned = message.mentions.users.has(client.user.id);
  const isDM = message.channel.type === 1;
  
  if (!isDirectlyMentioned && !isDM) return;

  const authorDisplayName = message.member?.displayName || (message.author as any).displayName || message.author.username;
  
  let messageContent = message.content;
  if (client.user && isDirectlyMentioned) {
    const botMention = `<@${client.user.id}>`;
    const botNicknameMention = `<@!${client.user.id}>`;
    messageContent = messageContent.replace(botNicknameMention, "").replace(botMention, "").trim();
  }
  
  try {
    ctx.logMessage(
      `discord-${message.channel.id}`,
      `${authorDisplayName}: ${message.content}`,
      { from: authorDisplayName, channel: { type: "discord", id: message.channel.id, name: (message.channel as any).name } }
    );
  } catch (e) {}

  try {
    await message.react("👀");
  } catch (e) {}
  
  const sessionKey = `discord-${message.channel.id}`;
  
  // Clean up any existing stream
  const existing = activeStreams.get(sessionKey);
  if (existing?.idleTimer) clearTimeout(existing.idleTimer);
  activeStreams.delete(sessionKey);
  
  // Create new stream
  const stream: ActiveStream = {
    channel: message.channel as TextChannel | ThreadChannel | DMChannel,
    replyTo: message,
    activeMessage: null,
    buffer: "",
    lastEditLength: 0,
    idleTimer: null,
    isComplete: false,
  };
  activeStreams.set(sessionKey, stream);
  
  logger.info({ msg: "Starting new stream", sessionKey, messageContent: messageContent.slice(0, 100) });
  
  try {
    await ctx.inject(
      sessionKey,
      messageContent,
      {
        from: authorDisplayName,
        channel: { type: "discord", id: message.channel.id, name: (message.channel as any).name },
        onStream: (msg: StreamMessage) => {
          handleStreamChunk(msg, sessionKey).catch((err) => {
            logger.error({ msg: "Stream chunk error", sessionKey, error: String(err) });
          });
        }
      }
    );
    
    // Injection complete - finalize
    logger.info({ msg: "Injection complete, finalizing", sessionKey, finalBufferLength: stream.buffer.length });
    finalizeMessage(stream);
    activeStreams.delete(sessionKey);
    
    try {
      await message.reactions.cache.get("👀")?.users.remove(client.user.id);
      await message.react("✅");
    } catch (e) {}
    
  } catch (error: any) {
    logger.error({ msg: "Injection failed", sessionKey, error: String(error) });
    
    if (stream.idleTimer) clearTimeout(stream.idleTimer);
    activeStreams.delete(sessionKey);
    
    try {
      await message.reactions.cache.get("👀")?.users.remove(client.user.id);
      await message.react("❌");
    } catch (e) {}
    
    await message.reply("Error processing your request.");
  }
}

const plugin: WOPRPlugin = {
  name: "wopr-plugin-discord",
  version: "2.4.0",
  description: "Discord bot with proper streaming",

  async init(context: WOPRPluginContext) {
    ctx = context;
    ctx.registerConfigSchema("wopr-plugin-discord", configSchema);

    let config = ctx.getConfig<{token?: string; guildId?: string}>();
    if (!config?.token) {
      const legacyConfig = ctx.getMainConfig("discord") as {token?: string; guildId?: string};
      if (legacyConfig?.token) {
        config = { token: legacyConfig.token, guildId: legacyConfig.guildId };
      }
    }

    if (!config?.token) {
      logger.warn("Discord not configured");
      return;
    }

    client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.GuildMessageReactions,
      ],
    });

    client.on(Events.MessageCreate, (msg) => {
      handleMessage(msg).catch((err) => logger.error({ msg: "Message handler error", error: String(err) }));
    });
    
    client.on(Events.ClientReady, () => {
      logger.info({ msg: "Bot logged in", tag: client?.user?.tag });
    });

    try {
      await client.login(config.token);
      logger.info("Discord bot started");
    } catch (error: any) {
      logger.error({ msg: "Failed to start bot", error: String(error) });
      throw error;
    }
  },

  async shutdown() {
    if (client) await client.destroy();
    logger.info("Plugin shut down");
  },
};

export default plugin;
