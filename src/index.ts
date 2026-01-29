/**
 * WOPR Discord Plugin - Proper streaming with message separation
 */

import { Client, GatewayIntentBits, Events, Message, TextChannel, ThreadChannel, DMChannel } from "discord.js";
import winston from "winston";
import path from "path";
import type { WOPRPlugin, WOPRPluginContext, ConfigSchema, StreamMessage, AgentIdentity } from "./types.js";

const logger = winston.createLogger({
  level: "debug",
  format: winston.format.combine(winston.format.timestamp(), winston.format.errors({ stack: true }), winston.format.json()),
  defaultMeta: { service: "wopr-plugin-discord" },
  transports: [
    new winston.transports.File({ filename: path.join(process.env.WOPR_HOME || "/tmp/wopr-test", "logs", "discord-plugin-error.log"), level: "error" }),
    new winston.transports.File({ filename: path.join(process.env.WOPR_HOME || "/tmp/wopr-test", "logs", "discord-plugin.log"), level: "debug" }),
    new winston.transports.Console({ format: winston.format.combine(winston.format.colorize(), winston.format.simple()), level: "warn" }),
  ],
});

let client: Client | null = null;
let ctx: WOPRPluginContext | null = null;
let agentIdentity: AgentIdentity = { name: "WOPR", emoji: "👀" };

// Cache identity on init
async function refreshIdentity() {
  if (!ctx) return;
  try {
    const identity = await ctx.getAgentIdentity();
    if (identity) {
      agentIdentity = { ...agentIdentity, ...identity };
      logger.info({ msg: "Identity refreshed", identity: agentIdentity });
    }
  } catch (e) {
    logger.warn({ msg: "Failed to refresh identity", error: String(e) });
  }
}

// Get the reaction emoji (from identity or default)
function getAckReaction(): string {
  return agentIdentity.emoji?.trim() || "👀";
}

// Get message prefix from identity name
function getMessagePrefix(): string {
  const name = agentIdentity.name?.trim();
  return name ? `[${name}]` : "[WOPR]";
}

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
    logger.debug({ msg: "DiscordMessage.flush called", bufferLength: this.buffer.length, isFinalized: this.isFinalized, hasDiscordMsg: !!this.discordMsg });
    if (this.isFinalized || !this.buffer.trim()) {
      logger.debug({ msg: "Flush early return", isFinalized: this.isFinalized, bufferEmpty: !this.buffer.trim() });
      return false;
    }
    
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
    
    // Only create/edit message if we have enough content (EDIT_THRESHOLD)
    // OR if we already have a message (continue updating it)
    const newContent = content.slice(this.lastEditLength);
    if (this.discordMsg) {
      // Already have message, edit it if enough new content
      if (newContent.length >= EDIT_THRESHOLD) {
        await this.discordMsg.edit(content);
        this.lastEditLength = content.length;
      }
    } else {
      // No message yet - wait for EDIT_THRESHOLD before creating
      if (content.length >= EDIT_THRESHOLD) {
        this.discordMsg = this.isReply 
          ? await replyTo.reply(content)
          : await channel.send(content);
        this.lastEditLength = content.length;
      }
    }
    return false;
  }
  
  async finalize(channel: TextChannel | ThreadChannel | DMChannel, replyTo: Message): Promise<void> {
    logger.debug({ msg: "DiscordMessage.finalize called", bufferLength: this.buffer.length, isFinalized: this.isFinalized, hasDiscordMsg: !!this.discordMsg, isReply: this.isReply });
    if (this.isFinalized || !this.buffer.trim()) {
      logger.debug({ msg: "Finalize early return", isFinalized: this.isFinalized, bufferEmpty: !this.buffer.trim() });
      return;
    }
    const content = this.buffer.trim();
    if (this.discordMsg) {
      await this.discordMsg.edit(content);
    } else {
      this.discordMsg = this.isReply 
        ? await replyTo.reply(content)
        : await channel.send(content);
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
  finalizeTimer: NodeJS.Timeout | null;
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
  logger.debug({ msg: "processChunk START", sessionKey, msgType: msg.type, msgKeys: Object.keys(msg) });
  
  // Extract text content from various provider formats
  let textContent = "";
  if (msg.type === "text" && msg.content) {
    textContent = msg.content;
    logger.debug({ msg: "Extracted text content (flat)", textContent: textContent?.substring(0, 50) });
  } else if (msg.type === "assistant" && (msg as any).message?.content) {
    // Handle nested content array from providers like Kimi
    const content = (msg as any).message.content;
    logger.debug({ msg: "Processing assistant message", contentType: typeof content, isArray: Array.isArray(content) });
    if (Array.isArray(content)) {
      textContent = content.map((c: any) => c.text || "").join("");
      logger.debug({ msg: "Extracted from array", textContent: textContent?.substring(0, 50), parts: content.length });
    } else if (typeof content === "string") {
      textContent = content;
      logger.debug({ msg: "Extracted string content", textContent: textContent?.substring(0, 50) });
    }
  }
  
  if (!textContent) {
    logger.debug({ msg: "No text content extracted, skipping", msgType: msg.type });
    return;
  }
  
  const now = Date.now();
  const timeSinceLast = now - state.lastTokenTime;
  
  // Check for idle gap - finalize current and start new message
  if (timeSinceLast > IDLE_SPLIT_MS && state.currentMsg.buffer.length > 0) {
    logger.info({ msg: "Idle gap detected", sessionKey, gapMs: timeSinceLast });
    await state.currentMsg.finalize(state.channel, state.replyTo);
    const newMsg = new DiscordMessage(false); // Follow-ups aren't replies
    state.messages.push(state.currentMsg);
    state.currentMsg = newMsg;
  }
  
  state.lastTokenTime = now;
  state.currentMsg.addContent(textContent);
  
  // Reset finalize timer after each chunk
  if ((state as any).setupFinalizeTimer) {
    (state as any).setupFinalizeTimer();
  }
  
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
  logger.debug({ msg: "handleChunk called", sessionKey, hasState: !!streams.get(sessionKey), msgType: msg.type });
  const state = streams.get(sessionKey);
  if (!state) {
    logger.warn({ msg: "No state found for session", sessionKey });
    return;
  }
  
  // Queue the chunk
  state.pending.push({ msg, sessionKey });
  logger.debug({ msg: "Chunk queued", sessionKey, queueSize: state.pending.length, processing: state.processing });
  
  // If not already processing, start
  if (!state.processing) {
    state.processing = true;
    logger.debug({ msg: "Starting processPending", sessionKey });
    processPending(state, sessionKey).catch(e => {
      logger.error({ msg: "Chunk processing error", error: String(e) });
      state.processing = false;
    });
  }
}

async function handleMessage(message: Message) {
  logger.debug({ msg: "RECEIVED MESSAGE", content: message.content?.substring(0,100), author: message.author?.tag, bot: message.author?.bot, isBot: message.author?.id === client?.user?.id });
  
  if (!client || !ctx) return;
  if (message.author.bot) return;
  if (!client.user) return;

  const isDirectlyMentioned = message.mentions.users.has(client.user.id);
  const isDM = message.channel.type === 1;
  
  const authorDisplayName = message.member?.displayName || (message.author as any).displayName || message.author.username;
  
  // ALWAYS log the message to session (for context history)
  try { 
    ctx.logMessage(`discord-${message.channel.id}`, message.content, { 
      from: authorDisplayName, 
      channel: { type: "discord", id: message.channel.id, name: (message.channel as any).name } 
    }); 
  } catch (e) {}
  
  // Only respond/inject if mentioned or DM
  if (!isDirectlyMentioned && !isDM) return;

  let messageContent = message.content;
  if (client.user && isDirectlyMentioned) {
    const botMention = `<@${client.user.id}>`;
    const botNicknameMention = `<@!${client.user.id}>`;
    messageContent = messageContent.replace(botNicknameMention, "").replace(botMention, "").trim();
  }
  
  const ackEmoji = getAckReaction();
  try { await message.react(ackEmoji); } catch (e) {}
  
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
    finalizeTimer: null,
  };
  
  // Setup finalize timer - sends message after 2s of inactivity even if buffer < 800 chars
  const setupFinalizeTimer = () => {
    if (state.finalizeTimer) clearTimeout(state.finalizeTimer);
    state.finalizeTimer = setTimeout(async () => {
      if (state.currentMsg.buffer.length > 0 && !state.currentMsg.isFinalized) {
        logger.info({ msg: "Finalize timer triggered", sessionKey, bufferLength: state.currentMsg.buffer.length });
        await state.currentMsg.finalize(state.channel, state.replyTo);
      }
    }, 2000); // 2 seconds
  };
  
  // Store timer setup function on state for processChunk to use
  (state as any).setupFinalizeTimer = setupFinalizeTimer;
  setupFinalizeTimer(); // Start initial timer
  
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
    await state.currentMsg.finalize(state.channel, state.replyTo);
    if (state.finalizeTimer) clearTimeout(state.finalizeTimer);
    streams.delete(sessionKey);
    
    try { 
      const ackEmoji = getAckReaction();
      await message.reactions.cache.get(ackEmoji)?.users.remove(client.user.id); 
      await message.react("✅"); 
    } catch (e) {}
  } catch (error: any) {
    logger.error({ msg: "Inject failed", error: String(error) });
    if (state.finalizeTimer) clearTimeout(state.finalizeTimer);
    streams.delete(sessionKey);
    try { 
      const ackEmoji = getAckReaction();
      await message.reactions.cache.get(ackEmoji)?.users.remove(client.user.id); 
      await message.react("❌"); 
    } catch (e) {}
    await message.reply("Error processing your request.");
  }
}

const plugin: WOPRPlugin = {
  name: "wopr-plugin-discord",
  version: "2.10.0",
  description: "Discord bot with identity support (AGENTS.md/SOUL.md)",
  async init(context: WOPRPluginContext) {
    ctx = context;
    ctx.registerConfigSchema("wopr-plugin-discord", configSchema);
    
    // Load agent identity for reactions/prefixes
    await refreshIdentity();
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
