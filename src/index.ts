/**
 * WOPR Discord Plugin
 * Talk to your WOPR sessions via Discord.
 */

import { Client, GatewayIntentBits, Events, Message, TextChannel, ThreadChannel, DMChannel } from "discord.js";
import winston from "winston";
import path from "path";
import type { WOPRPlugin, WOPRPluginContext, ConfigSchema, StreamMessage } from "./types.js";

// Create proper logger
const logger = winston.createLogger({
  level: "debug",
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  defaultMeta: { service: "wopr-plugin-discord" },
  transports: [
    // Write all logs to plugin log file
    new winston.transports.File({ 
      filename: path.join(process.env.WOPR_HOME || "/tmp/wopr-test", "logs", "discord-plugin-error.log"),
      level: "error"
    }),
    new winston.transports.File({ 
      filename: path.join(process.env.WOPR_HOME || "/tmp/wopr-test", "logs", "discord-plugin.log")
    }),
    // Also log to console
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.simple()
      )
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
const IDLE_TIMEOUT_MS = 600;
const MAX_MESSAGE_CHARS = 1800;

interface StreamState {
  channel: Message["channel"];
  replyTo: Message;
  messages: Message[];
  currentBuffer: string;
  lastTokenTime: number;
  idleTimer: NodeJS.Timeout | null;
  isFirstMessage: boolean;
  sessionKey: string;
}

const streams = new Map<string, StreamState>();

async function flushCurrentMessage(state: StreamState, force: boolean = false) {
  logger.debug({ msg: "flushCurrentMessage called", sessionKey: state.sessionKey, bufferLength: state.currentBuffer.length, force });
  
  if (!state.currentBuffer.trim()) {
    logger.debug({ msg: "Empty buffer, skipping flush", sessionKey: state.sessionKey });
    return;
  }
  
  const text = state.currentBuffer.trim();
  logger.debug({ msg: "Flushing message", sessionKey: state.sessionKey, textLength: text.length, isFirstMessage: state.isFirstMessage });
  
  try {
    if (state.isFirstMessage && state.messages.length === 0) {
      logger.info({ msg: "Sending first message as reply", sessionKey: state.sessionKey, textLength: text.length });
      const msg = await state.replyTo.reply(text.slice(0, DISCORD_LIMIT));
      state.messages.push(msg);
      state.isFirstMessage = false;
      logger.info({ msg: "First message sent successfully", sessionKey: state.sessionKey, messageId: msg.id });
    } else {
      logger.info({ msg: "Sending follow-up message", sessionKey: state.sessionKey, textLength: text.length });
      const msg = await sendToChannel(state.channel, text.slice(0, DISCORD_LIMIT));
      if (msg) {
        state.messages.push(msg);
        logger.info({ msg: "Follow-up message sent", sessionKey: state.sessionKey, messageId: msg.id });
      }
    }
    state.currentBuffer = "";
  } catch (error) {
    logger.error({ msg: "Failed to send message", sessionKey: state.sessionKey, error: String(error), stack: error instanceof Error ? error.stack : undefined });
    throw error;
  }
}

async function sendToChannel(channel: Message["channel"], text: string): Promise<Message | undefined> {
  if (channel.isTextBased() && "send" in channel) {
    return await (channel as TextChannel | ThreadChannel | DMChannel).send(text);
  }
  return undefined;
}

function resetIdleTimer(sessionKey: string, state: StreamState) {
  logger.debug({ msg: "Resetting idle timer", sessionKey, bufferLength: state.currentBuffer.length });
  
  if (state.idleTimer) {
    clearTimeout(state.idleTimer);
    state.idleTimer = null;
  }
  
  state.idleTimer = setTimeout(() => {
    logger.info({ msg: "Idle timeout fired", sessionKey, bufferLength: state.currentBuffer.length });
    flushCurrentMessage(state, true).then(() => {
      logger.debug({ msg: "Idle flush complete", sessionKey });
    }).catch((error) => {
      logger.error({ msg: "Idle flush failed", sessionKey, error: String(error) });
    });
  }, IDLE_TIMEOUT_MS);
}

async function handleStream(msg: StreamMessage, sessionKey: string) {
  logger.debug({ msg: "handleStream called", sessionKey, msgType: msg.type, hasContent: !!msg.content });
  
  if (msg.type !== "text" || !msg.content) {
    logger.debug({ msg: "Skipping non-text message", sessionKey, msgType: msg.type });
    return;
  }
  
  const state = streams.get(sessionKey);
  if (!state) {
    logger.error({ msg: "No stream state found", sessionKey });
    return;
  }
  
  state.lastTokenTime = Date.now();
  
  const text = msg.content;
  
  // Just concatenate - don't add spaces. The AI's streaming includes proper spacing.
  state.currentBuffer += text;
  logger.debug({ msg: "Added to buffer", sessionKey, addedLength: text.length, bufferLength: state.currentBuffer.length });
  
  // Flush if buffer is getting large (every ~1000 chars or near Discord limit)
  if (state.currentBuffer.length >= 1000) {
    logger.info({ msg: "Buffer reached threshold, flushing early", sessionKey, bufferLength: state.currentBuffer.length });
    // Clear timer since we're flushing now
    if (state.idleTimer) {
      clearTimeout(state.idleTimer);
      state.idleTimer = null;
    }
    // Fire and forget - don't block streaming
    flushCurrentMessage(state, false).catch((err) => {
      logger.error({ msg: "Early flush failed", sessionKey, error: String(err) });
    });
  } else {
    resetIdleTimer(sessionKey, state);
  }
}

async function handleMessage(message: Message) {
  logger.info({ msg: "handleMessage called", messageId: message.id, author: message.author.username, content: message.content.slice(0, 100) });
  
  if (!client || !ctx) {
    logger.error({ msg: "Client or ctx not initialized" });
    return;
  }
  if (message.author.bot) {
    logger.debug({ msg: "Ignoring bot message" });
    return;
  }
  if (!client.user) {
    logger.error({ msg: "Client user not available" });
    return;
  }

  const isDirectlyMentioned = message.mentions.users.has(client.user.id);
  const isDM = message.channel.type === 1;
  
  logger.debug({ msg: "Message check", isDirectlyMentioned, isDM, channelType: message.channel.type });
  
  const authorDisplayName = message.member?.displayName || (message.author as any).displayName || message.author.username;
  
  let messageContent = message.content;
  if (client.user && isDirectlyMentioned) {
    const botMention = `<@${client.user.id}>`;
    const botNicknameMention = `<@!${client.user.id}>`;
    messageContent = messageContent.replace(botNicknameMention, "").replace(botMention, "").trim();
  }
  
  const shouldRespond = isDirectlyMentioned || isDM;
  
  try {
    ctx.logMessage(
      `discord-${message.channel.id}`,
      `${authorDisplayName}: ${message.content}`,
      { from: authorDisplayName, channel: { type: "discord", id: message.channel.id, name: (message.channel as any).name } }
    );
  } catch (e) {
    logger.error({ msg: "logMessage failed", error: String(e) });
  }
  
  if (!shouldRespond) {
    logger.debug({ msg: "Not responding - not mentioned and not DM" });
    return;
  }

  try {
    await message.react("👀");
    logger.debug({ msg: "Added eyes reaction" });
  } catch (e) {
    logger.error({ msg: "Failed to add eyes reaction", error: String(e) });
  }
  
  const sessionKey = `discord-${message.channel.id}`;
  logger.info({ msg: "Starting new stream", sessionKey, messageContent: messageContent.slice(0, 100) });
  
  // Clean up any existing stream
  const existing = streams.get(sessionKey);
  if (existing?.idleTimer) {
    clearTimeout(existing.idleTimer);
    logger.debug({ msg: "Cleared existing idle timer", sessionKey });
  }
  streams.delete(sessionKey);
  
  // Create new stream state
  const state: StreamState = {
    channel: message.channel,
    replyTo: message,
    messages: [],
    currentBuffer: "",
    lastTokenTime: Date.now(),
    idleTimer: null,
    isFirstMessage: true,
    sessionKey,
  };
  streams.set(sessionKey, state);
  
  try {
    logger.info({ msg: "Calling ctx.inject", sessionKey });
    
    await ctx.inject(
      sessionKey,
      messageContent,
      {
        from: authorDisplayName,
        channel: { type: "discord", id: message.channel.id, name: (message.channel as any).name },
        onStream: (msg: StreamMessage) => {
          handleStream(msg, sessionKey).catch((error) => {
            logger.error({ msg: "handleStream error", sessionKey, error: String(error) });
          });
        }
      }
    );
    
    logger.info({ msg: "ctx.inject completed", sessionKey });
    
    // Injection complete - flush any remaining content
    if (state.idleTimer) {
      clearTimeout(state.idleTimer);
      state.idleTimer = null;
    }
    
    logger.info({ msg: "Flushing final message", sessionKey, bufferLength: state.currentBuffer.length });
    await flushCurrentMessage(state, true);
    streams.delete(sessionKey);
    
    try {
      await message.reactions.cache.get("👀")?.users.remove(client.user.id);
      await message.react("✅");
      logger.info({ msg: "Added checkmark reaction", sessionKey });
    } catch (e) {
      logger.error({ msg: "Failed to update reactions", sessionKey, error: String(e) });
    }
    
  } catch (error: any) {
    logger.error({ msg: "ctx.inject failed", sessionKey, error: String(error), stack: error?.stack });
    
    if (state.idleTimer) {
      clearTimeout(state.idleTimer);
    }
    streams.delete(sessionKey);
    
    try {
      await message.reactions.cache.get("👀")?.users.remove(client.user.id);
      await message.react("❌");
    } catch (e) {
      logger.error({ msg: "Failed to add error reaction", error: String(e) });
    }
    
    await message.reply("Error processing your request.");
  }
}

const plugin: WOPRPlugin = {
  name: "wopr-plugin-discord",
  version: "2.3.0",
  description: "Discord bot integration for WOPR with proper logging",

  async init(context: WOPRPluginContext) {
    logger.info({ msg: "Plugin init started" });
    ctx = context;
    
    // Ensure log directory exists
    const logDir = path.join(process.env.WOPR_HOME || "/tmp/wopr-test", "logs");
    try {
      await import("fs/promises").then(fs => fs.mkdir(logDir, { recursive: true }));
      logger.info({ msg: "Log directory ensured", logDir });
    } catch (e) {
      logger.error({ msg: "Failed to create log directory", logDir, error: String(e) });
    }
    
    ctx.registerConfigSchema("wopr-plugin-discord", configSchema);
    logger.info({ msg: "Config schema registered" });

    let config = ctx.getConfig<{token?: string; guildId?: string}>();
    logger.info({ msg: "Got plugin config", hasToken: !!config?.token });

    if (!config?.token) {
      const legacyConfig = ctx.getMainConfig("discord") as {token?: string; guildId?: string};
      logger.info({ msg: "Checking legacy config", hasToken: !!legacyConfig?.token });
      if (legacyConfig?.token) {
        config = { 
          token: legacyConfig.token, 
          guildId: legacyConfig.guildId,
        };
      }
    }

    if (!config?.token) {
      logger.warn({ msg: "Discord not configured - no token found" });
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
      handleMessage(msg).catch((error) => {
        logger.error({ msg: "Unhandled error in handleMessage", error: String(error), stack: error?.stack });
      });
    });
    
    client.on(Events.ClientReady, () => {
      logger.info({ msg: "Discord bot logged in", tag: client?.user?.tag });
    });
    
    client.on(Events.Error, (error) => {
      logger.error({ msg: "Discord client error", error: String(error) });
    });

    try {
      await client.login(config.token);
      logger.info({ msg: "Discord bot started successfully" });
    } catch (error: any) {
      logger.error({ msg: "Failed to start Discord bot", error: String(error), stack: error?.stack });
      throw error;
    }
  },

  async shutdown() {
    logger.info({ msg: "Plugin shutdown started" });
    if (client) {
      await client.destroy();
      logger.info({ msg: "Discord client destroyed" });
    }
    ctx?.log.info("Discord plugin shut down");
    logger.info({ msg: "Plugin shutdown complete" });
  },
};

export default plugin;
