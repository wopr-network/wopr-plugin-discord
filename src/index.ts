/**
 * WOPR Discord Plugin
 * Talk to your WOPR sessions via Discord.
 */

import { Client, GatewayIntentBits, Events, Message, TextChannel, ThreadChannel, DMChannel } from "discord.js";
import type { WOPRPlugin, WOPRPluginContext, ConfigSchema, StreamMessage } from "./types.js";

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
const IDLE_TIMEOUT_MS = 600;  // If no tokens for 600ms, message is complete
const MAX_MESSAGE_CHARS = 1800; // Split if message gets too long

// Track streaming state per session
interface StreamState {
  channel: Message["channel"];
  replyTo: Message;
  messages: Message[];  // Multiple messages for this session
  currentBuffer: string;
  lastTokenTime: number;
  idleTimer: NodeJS.Timeout | null;
  isFirstMessage: boolean;
}

const streams = new Map<string, StreamState>();

async function flushCurrentMessage(state: StreamState, force: boolean = false) {
  if (!state.currentBuffer.trim()) return;
  
  const text = state.currentBuffer.trim();
  
  // Check if we need to split this message
  if (text.length > MAX_MESSAGE_CHARS && !force) {
    // Send what fits, keep rest for next message
    const sendNow = text.slice(0, MAX_MESSAGE_CHARS);
    state.currentBuffer = text.slice(MAX_MESSAGE_CHARS);
    await sendMessageChunk(state, sendNow);
    // Don't clear buffer - there's more to send
  } else {
    // Send all and clear buffer
    await sendMessageChunk(state, text);
    state.currentBuffer = "";
  }
}

async function sendMessageChunk(state: StreamState, text: string) {
  if (!text) return;
  
  try {
    if (state.isFirstMessage && state.messages.length === 0) {
      // First message is a reply
      const msg = await state.replyTo.reply(text.slice(0, DISCORD_LIMIT));
      state.messages.push(msg);
      state.isFirstMessage = false;
    } else {
      // Subsequent messages are just sent to channel
      const msg = await sendToChannel(state.channel, text.slice(0, DISCORD_LIMIT));
      if (msg) state.messages.push(msg);
    }
  } catch (e) {}
}

async function sendToChannel(channel: Message["channel"], text: string): Promise<Message | undefined> {
  if (channel.isTextBased() && "send" in channel) {
    return await (channel as TextChannel | ThreadChannel | DMChannel).send(text);
  }
  return undefined;
}

function resetIdleTimer(sessionKey: string, state: StreamState) {
  if (state.idleTimer) clearTimeout(state.idleTimer);
  
  state.idleTimer = setTimeout(() => {
    // Idle timeout - message is complete, flush it
    flushCurrentMessage(state, true).then(() => {
      // Buffer is now empty, ready for next message
    }).catch(() => {});
  }, IDLE_TIMEOUT_MS);
}

async function handleStream(msg: StreamMessage, sessionKey: string) {
  if (msg.type !== "text" || !msg.content) return;
  
  const state = streams.get(sessionKey);
  if (!state) return;
  
  state.lastTokenTime = Date.now();
  
  // Check if this is a new burst after idle (previous message was flushed)
  // If buffer is empty and we have existing messages, this is a new thought
  if (!state.currentBuffer && state.messages.length > 0) {
    // Starting a new message
  }
  
  // Append with spacing logic
  const text = msg.content;
  const needsSpace = state.currentBuffer.length > 0 && 
    !state.currentBuffer.endsWith(" ") && 
    !state.currentBuffer.endsWith("\n") &&
    !text.startsWith(" ") &&
    !text.startsWith("\n") &&
    !text.startsWith(",") &&
    !text.startsWith(".") &&
    !text.startsWith("!") &&
    !text.startsWith("?");
  
  state.currentBuffer += (needsSpace ? " " : "") + text;
  
  // Reset idle timer on every token
  resetIdleTimer(sessionKey, state);
}

async function handleMessage(message: Message) {
  if (!client || !ctx) return;
  if (message.author.bot) return;
  if (!client.user) return;

  const isDirectlyMentioned = message.mentions.users.has(client.user.id);
  const isDM = message.channel.type === 1;
  
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
  } catch (e) {}
  
  if (!shouldRespond) return;

  try {
    await message.react("👀");
  } catch (e) {}
  
  const sessionKey = `discord-${message.channel.id}`;
  
  // Clean up any existing stream
  const existing = streams.get(sessionKey);
  if (existing?.idleTimer) clearTimeout(existing.idleTimer);
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
  };
  streams.set(sessionKey, state);
  
  try {
    await ctx.inject(
      sessionKey,
      messageContent,
      {
        from: authorDisplayName,
        channel: { type: "discord", id: message.channel.id, name: (message.channel as any).name },
        onStream: (msg: StreamMessage) => {
          handleStream(msg, sessionKey);
        }
      }
    );
    
    // Injection complete - flush any remaining content
    if (state.idleTimer) clearTimeout(state.idleTimer);
    await flushCurrentMessage(state, true);
    streams.delete(sessionKey);
    
    try {
      await message.reactions.cache.get("👀")?.users.remove(client.user.id);
      await message.react("✅");
    } catch (e) {}
    
  } catch (error: any) {
    ctx.log.error("Discord inject error:", error);
    
    const state = streams.get(sessionKey);
    if (state?.idleTimer) clearTimeout(state.idleTimer);
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
  version: "2.2.7",
  description: "Discord bot integration for WOPR with temporal gap detection",

  async init(context: WOPRPluginContext) {
    ctx = context;
    ctx.registerConfigSchema("wopr-plugin-discord", configSchema);
    ctx.log.info("Discord config schema registered");

    let config = ctx.getConfig<{token?: string; guildId?: string}>();

    if (!config?.token) {
      const legacyConfig = ctx.getMainConfig("discord") as {token?: string; guildId?: string};
      if (legacyConfig?.token) {
        config = { 
          token: legacyConfig.token, 
          guildId: legacyConfig.guildId,
        };
      }
    }

    if (!config?.token) {
      ctx.log.warn("Discord not configured.");
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

    client.on(Events.MessageCreate, handleMessage);
    client.on(Events.ClientReady, () => {
      ctx!.log.info(`Discord bot logged in as ${client!.user?.tag}`);
    });

    try {
      await client.login(config.token);
      ctx.log.info("Discord bot started");
    } catch (error: any) {
      ctx.log.error("Failed to start Discord bot:", error.message);
    }
  },

  async shutdown() {
    if (client) await client.destroy();
    ctx?.log.info("Discord plugin shut down");
  },
};

export default plugin;
