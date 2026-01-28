/**
 * WOPR Discord Plugin - Debug version
 */

import { Client, GatewayIntentBits, Events, Message, TextChannel, ThreadChannel, DMChannel } from "discord.js";
import winston from "winston";
import path from "path";
import type { WOPRPlugin, WOPRPluginContext, ConfigSchema, StreamMessage } from "./types.js";

const logger = winston.createLogger({
  level: "debug",
  format: winston.format.combine(winston.format.timestamp(), winston.format.errors({ stack: true }), winston.format.json()),
  defaultMeta: { service: "wopr-plugin-discord" },
  transports: [
    new winston.transports.File({ filename: path.join(process.env.WOPR_HOME || "/tmp/wopr-test", "logs", "discord-plugin-error.log"), level: "error" }),
    new winston.transports.File({ filename: path.join(process.env.WOPR_HOME || "/tmp/wopr-test", "logs", "discord-plugin.log") }),
    new winston.transports.Console({ format: winston.format.combine(winston.format.colorize(), winston.format.simple()), level: "debug" }),
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
const EDIT_THRESHOLD = 800;
const IDLE_SPLIT_MS = 1000;

interface StreamState {
  channel: TextChannel | ThreadChannel | DMChannel;
  replyTo: Message;
  message: Message | null;
  buffer: string;
  lastUpdateTime: number;
  lastEditLength: number;
  isReply: boolean;
  isFinalized: boolean;
  messageCount: number;
}

const streams = new Map<string, StreamState>();

async function updateMessage(state: StreamState, sessionKey: string): Promise<void> {
  logger.debug({ msg: "updateMessage called", sessionKey, bufferLength: state.buffer.length, lastEditLength: state.lastEditLength, hasMessage: !!state.message, isFinalized: state.isFinalized });
  
  if (state.isFinalized) {
    logger.debug({ msg: "State is finalized, skipping update", sessionKey });
    return;
  }
  
  const content = state.buffer.trim();
  if (!content) {
    logger.debug({ msg: "Empty content, skipping update", sessionKey });
    return;
  }
  
  try {
    if (!state.message) {
      // Create new message
      logger.info({ msg: "CREATING NEW MESSAGE", sessionKey, isReply: state.isReply, contentLength: content.length, messageCount: state.messageCount });
      if (state.isReply) {
        state.message = await state.replyTo.reply(content.slice(0, DISCORD_LIMIT));
        state.isReply = false;
      } else {
        state.message = await state.channel.send(content.slice(0, DISCORD_LIMIT));
      }
      state.lastEditLength = content.length;
      state.messageCount++;
      logger.info({ msg: "MESSAGE CREATED", sessionKey, messageId: state.message.id, messageCount: state.messageCount });
    } else if (content.length <= DISCORD_LIMIT) {
      // Edit existing
      const newContent = content.slice(state.lastEditLength);
      logger.debug({ msg: "EDITING MESSAGE", sessionKey, messageId: state.message.id, totalLength: content.length, newContentLength: newContent.length });
      await state.message.edit(content);
      state.lastEditLength = content.length;
      logger.debug({ msg: "MESSAGE EDITED", sessionKey, messageId: state.message.id });
    }
  } catch (e) {
    logger.error({ msg: "UPDATE FAILED", sessionKey, error: String(e) });
  }
}

async function handleChunk(msg: StreamMessage, sessionKey: string) {
  logger.debug({ msg: "=== handleChunk START ===", sessionKey, msgType: msg.type, contentLength: msg.content?.length });
  
  if (msg.type !== "text" || !msg.content) {
    logger.debug({ msg: "Skipping - not text or no content", sessionKey, msgType: msg.type, hasContent: !!msg.content });
    return;
  }
  
  let state = streams.get(sessionKey);
  logger.debug({ msg: "Got state", sessionKey, hasState: !!state, stateFinalized: state?.isFinalized });
  
  if (!state) {
    logger.error({ msg: "NO STATE FOUND - cannot process chunk", sessionKey });
    return;
  }
  
  // If state is finalized, we need to start fresh
  if (state.isFinalized) {
    logger.info({ msg: "State was finalized, creating new state", sessionKey, oldBuffer: state.buffer.length });
    const newState: StreamState = {
      channel: state.channel,
      replyTo: state.replyTo,
      message: null,
      buffer: msg.content,
      lastUpdateTime: Date.now(),
      lastEditLength: 0,
      isReply: false,
      isFinalized: false,
      messageCount: state.messageCount,
    };
    streams.set(sessionKey, newState);
    state = newState;
    await updateMessage(state, sessionKey);
    return;
  }
  
  const now = Date.now();
  const timeSinceLast = now - state.lastUpdateTime;
  logger.debug({ msg: "Timing check", sessionKey, now, lastUpdate: state.lastUpdateTime, timeSinceLast, idleThreshold: IDLE_SPLIT_MS });
  
  // Check for idle gap BEFORE adding content
  if (timeSinceLast > IDLE_SPLIT_MS && state.buffer.length > 0) {
    logger.info({ msg: "IDLE GAP DETECTED - splitting", sessionKey, gapMs: timeSinceLast, bufferLength: state.buffer.length });
    
    // Finalize current
    state.isFinalized = true;
    await updateMessage(state, sessionKey);
    
    // Create new state with this content
    const newState: StreamState = {
      channel: state.channel,
      replyTo: state.replyTo,
      message: null,
      buffer: msg.content,
      lastUpdateTime: now,
      lastEditLength: 0,
      isReply: false,
      isFinalized: false,
      messageCount: state.messageCount,
    };
    streams.set(sessionKey, newState);
    state = newState;
    await updateMessage(state, sessionKey);
    logger.info({ msg: "NEW MESSAGE STARTED after idle gap", sessionKey });
    return;
  }
  
  // Add content
  state.buffer += msg.content;
  state.lastUpdateTime = now;
  logger.debug({ msg: "Content added", sessionKey, addedLength: msg.content.length, newBufferLength: state.buffer.length });
  
  // Check Discord limit split
  if (state.buffer.length > DISCORD_LIMIT) {
    logger.info({ msg: "HIT DISCORD LIMIT", sessionKey, bufferLength: state.buffer.length, limit: DISCORD_LIMIT });
    
    const toSend = state.buffer.slice(0, DISCORD_LIMIT);
    const remaining = state.buffer.slice(DISCORD_LIMIT);
    
    // Send what fits
    if (state.message) {
      await state.message.edit(toSend);
    } else {
      state.message = state.isReply 
        ? await state.replyTo.reply(toSend)
        : await state.channel.send(toSend);
      state.isReply = false;
    }
    state.isFinalized = true;
    state.lastEditLength = DISCORD_LIMIT;
    state.messageCount++;
    
    // New state with remainder
    const newState: StreamState = {
      channel: state.channel,
      replyTo: state.replyTo,
      message: null,
      buffer: remaining,
      lastUpdateTime: now,
      lastEditLength: 0,
      isReply: false,
      isFinalized: false,
      messageCount: state.messageCount,
    };
    streams.set(sessionKey, newState);
    logger.info({ msg: "SPLIT COMPLETE - new message with remainder", sessionKey, remainderLength: remaining.length, messageCount: newState.messageCount });
    await updateMessage(newState, sessionKey);
    return;
  }
  
  // Normal edit check
  const newContent = state.buffer.length - state.lastEditLength;
  logger.debug({ msg: "Edit check", sessionKey, newContent, editThreshold: EDIT_THRESHOLD, hasMessage: !!state.message });
  
  if (newContent >= EDIT_THRESHOLD || !state.message) {
    logger.info({ msg: "TRIGGERING EDIT/CREATE", sessionKey, newContent, hasMessage: !!state.message });
    await updateMessage(state, sessionKey);
  } else {
    logger.debug({ msg: "Skipping edit - threshold not met", sessionKey, newContent });
  }
  
  logger.debug({ msg: "=== handleChunk END ===", sessionKey });
}

async function handleMessage(message: Message) {
  logger.info({ msg: "=== handleMessage START ===", messageId: message.id, author: message.author.username, content: message.content.slice(0, 50) });
  
  if (!client || !ctx) { logger.error("No client or ctx"); return; }
  if (message.author.bot) { logger.debug("Ignoring bot"); return; }
  if (!client.user) { logger.error("No client.user"); return; }

  const isDirectlyMentioned = message.mentions.users.has(client.user.id);
  const isDM = message.channel.type === 1;
  logger.debug({ isDirectlyMentioned, isDM, channelType: message.channel.type });
  
  if (!isDirectlyMentioned && !isDM) { logger.debug("Not mentioned, not DM - ignoring"); return; }

  const authorDisplayName = message.member?.displayName || (message.author as any).displayName || message.author.username;
  
  let messageContent = message.content;
  if (client.user && isDirectlyMentioned) {
    const botMention = `<@${client.user.id}>`;
    const botNicknameMention = `<@!${client.user.id}>`;
    messageContent = messageContent.replace(botNicknameMention, "").replace(botMention, "").trim();
  }
  
  try { ctx.logMessage(`discord-${message.channel.id}`, `${authorDisplayName}: ${message.content}`, { from: authorDisplayName, channel: { type: "discord", id: message.channel.id, name: (message.channel as any).name } }); } catch (e) {}
  try { await message.react("👀"); } catch (e) {}
  
  const sessionKey = `discord-${message.channel.id}`;
  logger.info({ msg: "Cleaning up old stream", sessionKey, hadExisting: streams.has(sessionKey) });
  streams.delete(sessionKey);
  
  const state: StreamState = {
    channel: message.channel as TextChannel | ThreadChannel | DMChannel,
    replyTo: message,
    message: null,
    buffer: "",
    lastUpdateTime: Date.now(),
    lastEditLength: 0,
    isReply: true,
    isFinalized: false,
    messageCount: 0,
  };
  streams.set(sessionKey, state);
  logger.info({ msg: "NEW STREAM CREATED", sessionKey, messageContent: messageContent.slice(0, 100) });
  
  try {
    logger.info({ msg: "Calling ctx.inject", sessionKey });
    await ctx.inject(sessionKey, messageContent, {
      from: authorDisplayName,
      channel: { type: "discord", id: message.channel.id, name: (message.channel as any).name },
      onStream: (msg: StreamMessage) => {
        handleChunk(msg, sessionKey).catch((e) => logger.error({ msg: "Chunk error", error: String(e) }));
      }
    });
    
    logger.info({ msg: "ctx.inject completed", sessionKey });
    const finalState = streams.get(sessionKey);
    if (finalState && !finalState.isFinalized) {
      logger.info({ msg: "Final update", sessionKey, finalBufferLength: finalState.buffer.length });
      await updateMessage(finalState, sessionKey);
    }
    streams.delete(sessionKey);
    logger.info({ msg: "Stream cleaned up", sessionKey });
    
    try {
      await message.reactions.cache.get("👀")?.users.remove(client.user.id);
      await message.react("✅");
    } catch (e) {}
    
  } catch (error: any) {
    logger.error({ msg: "INJECT FAILED", sessionKey, error: String(error) });
    streams.delete(sessionKey);
    try {
      await message.reactions.cache.get("👀")?.users.remove(client.user.id);
      await message.react("❌");
    } catch (e) {}
    await message.reply("Error processing your request.");
  }
  
  logger.info({ msg: "=== handleMessage END ===", sessionKey });
}

const plugin: WOPRPlugin = {
  name: "wopr-plugin-discord",
  version: "2.7.0",
  description: "Discord bot with full debug logging",

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
      intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.DirectMessages, GatewayIntentBits.GuildMessageReactions],
    });

    client.on(Events.MessageCreate, (msg) => { handleMessage(msg).catch((e) => logger.error({ msg: "Handler error", error: String(e) })); });
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
