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
const EDIT_BATCH_SIZE = 600;  // Edit every 600 new chars

// Track streaming state per session
interface StreamState {
  channel: Message["channel"];
  replyTo: Message;
  message: Message | null;
  buffer: string;
  lastEditLength: number;  // Buffer length at last Discord edit
  pendingEdit: boolean;    // Is an edit currently pending?
}

const streams = new Map<string, StreamState>();

async function updateDiscordMessage(state: StreamState) {
  if (!state.buffer.trim()) return;
  if (state.pendingEdit) return; // Don't queue multiple edits
  
  const fullText = state.buffer.trim();
  
  // Only update if we have substantial new content
  if (fullText.length - state.lastEditLength < 50) return;
  
  state.pendingEdit = true;
  
  try {
    if (!state.message) {
      // First message
      const chunk = fullText.slice(0, DISCORD_LIMIT);
      state.message = await state.replyTo.reply(chunk);
      state.lastEditLength = chunk.length;
    } else if (fullText.length <= DISCORD_LIMIT) {
      // Still fits - edit in place
      await state.message.edit(fullText);
      state.lastEditLength = fullText.length;
    } else {
      // Would exceed limit - append as new message
      const newContent = fullText.slice(state.lastEditLength);
      if (newContent) {
        await sendToChannel(state.channel, newContent.slice(0, DISCORD_LIMIT));
        state.lastEditLength += newContent.length;
      }
    }
  } catch (e) {}
  
  state.pendingEdit = false;
}

async function flushFinal(state: StreamState) {
  const fullText = state.buffer.trim();
  if (!fullText) return;
  
  try {
    if (!state.message) {
      // No message yet - send all
      const chunks = splitMessage(fullText, DISCORD_LIMIT);
      for (let i = 0; i < chunks.length; i++) {
        if (i === 0) {
          state.message = await state.replyTo.reply(chunks[i]);
        } else {
          await sendToChannel(state.channel, chunks[i]);
        }
      }
    } else if (fullText.length > state.lastEditLength) {
      // Has new content since last edit
      if (fullText.length <= DISCORD_LIMIT) {
        await state.message.edit(fullText);
      } else {
        const newContent = fullText.slice(state.lastEditLength);
        if (newContent) {
          await sendToChannel(state.channel, newContent.slice(0, DISCORD_LIMIT));
        }
      }
    }
  } catch (e) {}
}

function splitMessage(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];
  
  const chunks: string[] = [];
  let remaining = text;
  
  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }
    
    let breakPoint = remaining.lastIndexOf("\n\n", maxLen);
    if (breakPoint < maxLen * 0.5) breakPoint = remaining.lastIndexOf("\n", maxLen);
    if (breakPoint < maxLen * 0.5) breakPoint = remaining.lastIndexOf(" ", maxLen);
    if (breakPoint < maxLen * 0.5) breakPoint = maxLen;
    
    chunks.push(remaining.slice(0, breakPoint));
    remaining = remaining.slice(breakPoint).trim();
  }
  
  return chunks;
}

async function handleStream(msg: StreamMessage, sessionKey: string) {
  if (msg.type !== "text" || !msg.content) return;
  
  const state = streams.get(sessionKey);
  if (!state) return;
  
  // Append to buffer with spacing logic
  const text = msg.content;
  const needsSpace = state.buffer.length > 0 && 
    !state.buffer.endsWith(" ") && 
    !state.buffer.endsWith("\n") &&
    !text.startsWith(" ") &&
    !text.startsWith("\n") &&
    !text.startsWith(",") &&
    !text.startsWith(".") &&
    !text.startsWith("!") &&
    !text.startsWith("?");
  
  state.buffer += (needsSpace ? " " : "") + text;
  
  // Only edit if we have EDIT_BATCH_SIZE new chars and no pending edit
  const newChars = state.buffer.length - state.lastEditLength;
  if (newChars >= EDIT_BATCH_SIZE && !state.pendingEdit) {
    // Fire and forget - don't await, don't block streaming
    updateDiscordMessage(state).catch(() => {});
  }
}

async function sendToChannel(channel: Message["channel"], text: string): Promise<Message | undefined> {
  if (channel.isTextBased() && "send" in channel) {
    return await (channel as TextChannel | ThreadChannel | DMChannel).send(text);
  }
  return undefined;
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
  streams.delete(sessionKey);
  
  // Create new stream state
  const state: StreamState = {
    channel: message.channel,
    replyTo: message,
    message: null,
    buffer: "",
    lastEditLength: 0,
    pendingEdit: false,
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
    
    // Final flush when complete
    await flushFinal(state);
    streams.delete(sessionKey);
    
    try {
      await message.reactions.cache.get("👀")?.users.remove(client.user.id);
      await message.react("✅");
    } catch (e) {}
    
  } catch (error: any) {
    ctx.log.error("Discord inject error:", error);
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
  version: "2.2.5",
  description: "Discord bot integration for WOPR with streaming support",

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
