/**
 * WOPR Discord Plugin - Proper streaming with message separation
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
const EDIT_THRESHOLD = 800;  // Edit after 800 new chars
const IDLE_SPLIT_MS = 1000;  // New message after 1s idle

// Represents ONE discord message being built
class DiscordMessage {
  discordMsg: Message | null = null;
  buffer = "";
  lastEditLength = 0;
  isReply: boolean;
  isFinalized = false;
  
  constructor(isReply: boolean) {
    this.isReply = isReply;
  }
  
  addContent(text: string): void {
    this.buffer += text;
  }
  
  // Returns true if we should create a new message (hit limit)
  async flush(channel: TextChannel | ThreadChannel | DMChannel, replyTo: Message): Promise<boolean> {
    if (this.isFinalized || !this.buffer.trim()) return false;
    
    const content = this.buffer.trim();
    
    // Check if we hit Discord limit
    if (content.length > DISCORD_LIMIT) {
      // Send what fits
      const toSend = content.slice(0, DISCORD_LIMIT);
      if (this.discordMsg) {
        await this.discordMsg.edit(toSend);
      } else {
        this.discordMsg = this.isReply 
          ? await replyTo.reply(toSend)
          : await channel.send(toSend);
      }
      // Keep remainder for next message
      this.buffer = content.slice(DISCORD_LIMIT);
      this.lastEditLength = 0;
      this.isFinalized = true;
      return true; // Need new message
    }
    
    // Normal edit
    const newContent = content.slice(this.lastEditLength);
    if (newContent.length >= EDIT_THRESHOLD || !this.discordMsg) {
      if (this.discordMsg) {
        await this.discordMsg.edit(content);
      } else {
        this.discordMsg = this.isReply 
          ? await replyTo.reply(content)
          : await channel.send(content);
      }
      this.lastEditLength = content.length;
    }
    return false;
  }
  
  async finalize(): Promise<void> {
    if (this.isFinalized || !this.buffer.trim()) return;
    const content = this.buffer.trim();
    if (this.discordMsg) {
      await this.discordMsg.edit(content);
    } else {
      this.discordMsg = this.isReply 
        ? await (this.discordMsg as any)?.channel?.send?.(content) || await (this as any).channel?.send?.(content)
        : await (this as any).channel?.send?.(content);
    }
    this.isFinalized = true;
  }
}

interface StreamState {
  channel: TextChannel | ThreadChannel | DMChannel;
  replyTo: Message;
  messages: DiscordMessage[];
  currentMsg: DiscordMessage;
  lastTokenTime: number;
  processing: boolean;
  pending: { msg: StreamMessage; sessionKey: string }[];
}

const streams = new Map<string, StreamState>();

async function processPending(state: StreamState, sessionKey: string) {
  while (state.pending.length > 0) {
    const { msg } = state.pending.shift()!;
    await processChunk(msg, state, sessionKey);
  }
  state.processing = false;
}

async function processChunk(msg: StreamMessage, state: StreamState, sessionKey: string) {
  if (msg.type !== "text" || !msg.content) return;
  
  const now = Date.now();
  const timeSinceLast = now - state.lastTokenTime;
  
  // Check for idle gap - finalize current and start new message
  if (timeSinceLast > IDLE_SPLIT_MS && state.currentMsg.buffer.length > 0) {
    logger.info({ msg: "Idle gap detected", sessionKey, gapMs: timeSinceLast });
    await state.currentMsg.finalize();
    const newMsg = new DiscordMessage(false); // Follow-ups aren't replies
    state.messages.push(state.currentMsg);
    state.currentMsg = newMsg;
  }
  
  state.lastTokenTime = now;
  state.currentMsg.addContent(msg.content);
  
  // Flush current message
  const needsNewMsg = await state.currentMsg.flush(state.channel, state.replyTo);
  
  if (needsNewMsg) {
    // Current hit limit, create new one with remainder
    const newMsg = new DiscordMessage(false);
    newMsg.buffer = state.currentMsg.buffer; // Transfer remainder
    state.messages.push(state.currentMsg);
    state.currentMsg = newMsg;
    // Flush the remainder
    await state.currentMsg.flush(state.channel, state.replyTo);
  }
}

async function handleChunk(msg: StreamMessage, sessionKey: string) {
  const state = streams.get(sessionKey);
  if (!state) return;
  
  // Queue the chunk
  state.pending.push({ msg, sessionKey });
  
  // If not already processing, start
  if (!state.processing) {
    state.processing = true;
    processPending(state, sessionKey).catch(e => {
      logger.error({ msg: "Chunk processing error", error: String(e) });
      state.processing = false;
    });
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
  
  try { ctx.logMessage(`discord-${message.channel.id}`, `${authorDisplayName}: ${message.content}`, { from: authorDisplayName, channel: { type: "discord", id: message.channel.id, name: (message.channel as any).name } }); } catch (e) {}
  try { await message.react("👀"); } catch (e) {}
  
  const sessionKey = `discord-${message.channel.id}`;
  streams.delete(sessionKey);
  
  const currentMsg = new DiscordMessage(true); // First message is a reply
  const state: StreamState = {
    channel: message.channel as TextChannel | ThreadChannel | DMChannel,
    replyTo: message,
    messages: [],
    currentMsg,
    lastTokenTime: Date.now(),
    processing: false,
    pending: [],
  };
  streams.set(sessionKey, state);
  
  logger.info({ msg: "New stream", sessionKey });
  
  try {
    await ctx.inject(sessionKey, messageContent, {
      from: authorDisplayName,
      channel: { type: "discord", id: message.channel.id, name: (message.channel as any).name },
      onStream: (msg: StreamMessage) => {
        handleChunk(msg, sessionKey).catch((e) => logger.error({ msg: "Chunk error", error: String(e) }));
      }
    });
    
    // Finalize last message
    await state.currentMsg.finalize();
    streams.delete(sessionKey);
    
    try { await message.reactions.cache.get("👀")?.users.remove(client.user.id); await message.react("✅"); } catch (e) {}
  } catch (error: any) {
    logger.error({ msg: "Inject failed", error: String(error) });
    streams.delete(sessionKey);
    try { await message.reactions.cache.get("👀")?.users.remove(client.user.id); await message.react("❌"); } catch (e) {}
    await message.reply("Error processing your request.");
  }
}

const plugin: WOPRPlugin = {
  name: "wopr-plugin-discord",
  version: "2.9.0",
  description: "Discord bot with proper message separation",
  async init(context: WOPRPluginContext) {
    ctx = context;
    ctx.registerConfigSchema("wopr-plugin-discord", configSchema);
    let config = ctx.getConfig<{token?: string; guildId?: string}>();
    if (!config?.token) { const legacy = ctx.getMainConfig("discord") as {token?: string}; if (legacy?.token) config = { token: legacy.token }; }
    if (!config?.token) { logger.warn("Not configured"); return; }
    client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.DirectMessages, GatewayIntentBits.GuildMessageReactions] });
    client.on(Events.MessageCreate, (m) => handleMessage(m).catch((e) => logger.error(e)));
    client.on(Events.ClientReady, () => logger.info({ tag: client?.user?.tag }));
    try { await client.login(config.token); logger.info("Started"); } catch (e) { logger.error(e); throw e; }
  },
  async shutdown() { if (client) await client.destroy(); },
};

export default plugin;
