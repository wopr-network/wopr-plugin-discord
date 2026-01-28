/**
 * WOPR Discord Plugin - Fixed streaming
 * ONE active message, edit every 800 chars, split at 2000, new message on 1s gap
 */

import { Client, GatewayIntentBits, Events, Message, TextChannel, ThreadChannel, DMChannel } from "discord.js";
import winston from "winston";
import path from "path";
import type { WOPRPlugin, WOPRPluginContext, ConfigSchema, StreamMessage } from "./types.js";

const logger = winston.createLogger({
  level: "info",
  format: winston.format.combine(winston.format.timestamp(), winston.format.errors({ stack: true }), winston.format.json()),
  defaultMeta: { service: "wopr-plugin-discord" },
  transports: [
    new winston.transports.File({ filename: path.join(process.env.WOPR_HOME || "/tmp/wopr-test", "logs", "discord-plugin-error.log"), level: "error" }),
    new winston.transports.File({ filename: path.join(process.env.WOPR_HOME || "/tmp/wopr-test", "logs", "discord-plugin.log") }),
    new winston.transports.Console({ format: winston.format.combine(winston.format.colorize(), winston.format.simple()), level: "warn" }),
  ],
});

let client: Client | null = null;
let ctx: WOPRPluginContext | null = null;

const configSchema: ConfigSchema = {
  title: "Discord Integration",
  description: "Configure Discord bot integration",
  fields: [
    { name: "token", type: "password", label: "Discord Bot Token", placeholder: "Bot token from Discord Developer Portal", required: true, description: "Your Discord bot token" },
    { name: "guildId", type: "text", label: "Guild ID (optional)", placeholder: "Server ID to restrict bot to", description: "Restrict bot to a specific Discord server" },
    { name: "pairingRequests", type: "object", hidden: true, default: {} },
    { name: "mappings", type: "object", hidden: true, default: {} },
  ],
};

const DISCORD_LIMIT = 2000;
const EDIT_THRESHOLD = 800;  // Edit Discord message every 800 new chars
const IDLE_SPLIT_MS = 1000;  // Split to new message after 1 second of no tokens

interface StreamState {
  channel: TextChannel | ThreadChannel | DMChannel;
  replyTo: Message;
  message: Message | null;
  buffer: string;
  lastUpdateTime: number;
  lastEditLength: number;
  isReply: boolean;
  isFinalized: boolean;
}

const streams = new Map<string, StreamState>();

async function updateMessage(state: StreamState): Promise<void> {
  if (state.isFinalized || !state.buffer.trim()) return;
  
  const content = state.buffer.trim();
  
  try {
    if (!state.message) {
      // Create new message
      if (state.isReply) {
        state.message = await state.replyTo.reply(content.slice(0, DISCORD_LIMIT));
        state.isReply = false;
      } else {
        state.message = await state.channel.send(content.slice(0, DISCORD_LIMIT));
      }
      state.lastEditLength = content.length;
    } else if (content.length <= DISCORD_LIMIT) {
      // Edit existing message
      await state.message.edit(content);
      state.lastEditLength = content.length;
    }
    // If > DISCORD_LIMIT, we need to split - handled in handleChunk
  } catch (e) {
    logger.error({ msg: "Update failed", error: String(e) });
  }
}

async function handleChunk(msg: StreamMessage, sessionKey: string) {
  if (msg.type !== "text" || !msg.content) return;
  
  let state = streams.get(sessionKey);
  if (!state) return; // Stream was cleaned up
  
  if (state.isFinalized) {
    // Previous message was finalized (idle gap), start fresh
    state = {
      channel: state.channel,
      replyTo: state.replyTo,
      message: null,
      buffer: "",
      lastUpdateTime: Date.now(),
      lastEditLength: 0,
      isReply: false, // Follow-up messages are not replies
      isFinalized: false,
    };
    streams.set(sessionKey, state);
    logger.info({ msg: "Started new message after idle gap", sessionKey });
  }
  
  // Check for idle gap before adding new content
  const now = Date.now();
  const timeSinceLast = now - state.lastUpdateTime;
  
  if (timeSinceLast > IDLE_SPLIT_MS && state.buffer.length > 0) {
    // Idle gap detected - finalize current and start new
    logger.info({ msg: "Idle gap detected, splitting to new message", sessionKey, gapMs: timeSinceLast, bufferLength: state.buffer.length });
    state.isFinalized = true;
    
    // Create new state for continuation
    const newState: StreamState = {
      channel: state.channel,
      replyTo: state.replyTo,
      message: null,
      buffer: msg.content,
      lastUpdateTime: now,
      lastEditLength: 0,
      isReply: false,
      isFinalized: false,
    };
    streams.set(sessionKey, newState);
    state = newState;
    await updateMessage(state);
    return;
  }
  
  // Add content
  state.buffer += msg.content;
  state.lastUpdateTime = now;
  
  // Check if we need to split (hit Discord limit)
  if (state.buffer.length > DISCORD_LIMIT) {
    // Send what fits, keep rest for next message
    const toSend = state.buffer.slice(0, DISCORD_LIMIT);
    state.buffer = state.buffer.slice(DISCORD_LIMIT);
    
    logger.info({ msg: "Hit Discord limit, splitting", sessionKey, sentLength: toSend.length, remaining: state.buffer.length });
    
    // Finalize current message at limit
    if (state.message) {
      await state.message.edit(toSend);
    } else {
      state.message = state.isReply 
        ? await state.replyTo.reply(toSend)
        : await state.channel.send(toSend);
      state.isReply = false;
    }
    state.isFinalized = true;
    
    // Create new state with remaining content
    const newState: StreamState = {
      channel: state.channel,
      replyTo: state.replyTo,
      message: null,
      buffer: state.buffer,
      lastUpdateTime: now,
      lastEditLength: 0,
      isReply: false,
      isFinalized: false,
    };
    streams.set(sessionKey, newState);
    await updateMessage(newState);
    return;
  }
  
  // Normal update check (every ~800 chars)
  const newContent = state.buffer.length - state.lastEditLength;
  if (newContent >= EDIT_THRESHOLD || !state.message) {
    await updateMessage(state);
  }
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
    ctx.logMessage(`discord-${message.channel.id}`, `${authorDisplayName}: ${message.content}`, {
      from: authorDisplayName, channel: { type: "discord", id: message.channel.id, name: (message.channel as any).name }
    });
  } catch (e) {}

  try { await message.react("👀"); } catch (e) {}
  
  const sessionKey = `discord-${message.channel.id}`;
  
  // Clean up any existing stream
  streams.delete(sessionKey);
  
  // Create new stream
  const state: StreamState = {
    channel: message.channel as TextChannel | ThreadChannel | DMChannel,
    replyTo: message,
    message: null,
    buffer: "",
    lastUpdateTime: Date.now(),
    lastEditLength: 0,
    isReply: true,
    isFinalized: false,
  };
  streams.set(sessionKey, state);
  
  logger.info({ msg: "New stream", sessionKey, content: messageContent.slice(0, 100) });
  
  try {
    await ctx.inject(sessionKey, messageContent, {
      from: authorDisplayName,
      channel: { type: "discord", id: message.channel.id, name: (message.channel as any).name },
      onStream: (msg: StreamMessage) => {
        handleChunk(msg, sessionKey).catch((e) => logger.error({ msg: "Chunk error", error: String(e) }));
      }
    });
    
    // Finalize
    const finalState = streams.get(sessionKey);
    if (finalState && !finalState.isFinalized) {
      await updateMessage(finalState);
    }
    streams.delete(sessionKey);
    
    try {
      await message.reactions.cache.get("👀")?.users.remove(client.user.id);
      await message.react("✅");
    } catch (e) {}
    
  } catch (error: any) {
    logger.error({ msg: "Inject failed", error: String(error) });
    streams.delete(sessionKey);
    try {
      await message.reactions.cache.get("👀")?.users.remove(client.user.id);
      await message.react("❌");
    } catch (e) {}
    await message.reply("Error processing your request.");
  }
}

const plugin: WOPRPlugin = {
  name: "wopr-plugin-discord",
  version: "2.6.0",
  description: "Discord bot with correct streaming",

  async init(context: WOPRPluginContext) {
    ctx = context;
    ctx.registerConfigSchema("wopr-plugin-discord", configSchema);

    let config = ctx.getConfig<{token?: string; guildId?: string}>();
    if (!config?.token) {
      const legacyConfig = ctx.getMainConfig("discord") as {token?: string; guildId?: string};
      if (legacyConfig?.token) config = { token: legacyConfig.token, guildId: legacyConfig.guildId };
    }

    if (!config?.token) { logger.warn("Discord not configured"); return; }

    client = new Client({
      intents: [
        GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent, GatewayIntentBits.DirectMessages,
        GatewayIntentBits.GuildMessageReactions,
      ],
    });

    client.on(Events.MessageCreate, (msg) => {
      handleMessage(msg).catch((e) => logger.error({ msg: "Handler error", error: String(e) }));
    });
    client.on(Events.ClientReady, () => logger.info({ msg: "Bot logged in", tag: client?.user?.tag }));

    try {
      await client.login(config.token);
      logger.info("Bot started");
    } catch (error: any) {
      logger.error({ msg: "Failed to start", error: String(error) });
      throw error;
    }
  },

  async shutdown() {
    if (client) await client.destroy();
    logger.info("Plugin shut down");
  },
};

export default plugin;
