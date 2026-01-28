/**
 * WOPR Discord Plugin
 * Talk to your WOPR sessions via Discord.
 */

import { Client, GatewayIntentBits, Events, Message } from "discord.js";
import type { WOPRPlugin, WOPRPluginContext, ConfigSchema } from "./types.js";

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

async function handleMessage(message: Message) {
  if (!client || !ctx) return;
  if (message.author.bot) return;
  if (!client.user) return;

  const isMentioned = message.mentions.has(client.user.id);
  const isDM = message.channel.type === 1;
  
  // Ignore @everyone and @here mentions (the bot is included but not directly mentioned)
  const isDirectlyMentioned = message.mentions.users.has(client.user.id);
  const isRoleMentioned = message.mentions.roles.size > 0;
  const hasEveryoneMention = message.content.includes("@everyone");
  const hasHereMention = message.content.includes("@here");
  
  // Only respond to direct mentions or DMs, not @everyone/@here
  const shouldRespond = isDirectlyMentioned || isDM;
  
  // Additional check: if it's just @everyone/@here without a direct mention, ignore
  if (!shouldRespond) return;

  const resolvedContent = message.content;
  
  // Add eyes reaction to show we're processing
  try {
    await message.react("👀");
  } catch (e) {
    ctx.log.warn("Failed to add eyes reaction:", e);
  }
  
  try {
    const response = await ctx.inject(`discord-${message.channel.id}`, resolvedContent);
    
    // Remove eyes and add checkmark when done
    try {
      await message.reactions.cache.get("👀")?.users.remove(client.user.id);
      await message.react("✅");
    } catch (e) {
      ctx.log.warn("Failed to update reactions:", e);
    }
    
    if (response) {
      await message.reply(response.slice(0, 2000));
    }
  } catch (error: any) {
    ctx.log.error("Discord inject error:", error);
    
    // Remove eyes and add X on error
    try {
      await message.reactions.cache.get("👀")?.users.remove(client.user.id);
      await message.react("❌");
    } catch (e) {
      ctx.log.warn("Failed to update reactions:", e);
    }
    
    await message.reply("Error processing your request.");
  }
}

const plugin: WOPRPlugin = {
  name: "wopr-plugin-discord",
  version: "2.0.7",
  description: "Discord bot integration for WOPR",

  async init(context: WOPRPluginContext) {
    ctx = context;
    ctx.registerConfigSchema("wopr-plugin-discord", configSchema);
    ctx.log.info("Discord config schema registered");

    // Try plugin-specific config first, then fall back to legacy
    let config = ctx.getConfig<{token?: string; guildId?: string}>();
    ctx.log.info("Plugin config:", JSON.stringify(config));

    if (!config?.token) {
      const legacyConfig = ctx.getMainConfig("discord") as {token?: string; guildId?: string};
      ctx.log.info("Legacy config:", JSON.stringify(legacyConfig));
      if (legacyConfig?.token) {
        config = { 
          token: legacyConfig.token, 
          guildId: legacyConfig.guildId,
        };
        ctx.log.info("Using legacy config location");
      }
    }

    if (!config?.token) {
      ctx.log.warn("Discord not configured. Add bot token via: wopr config set discord.token <token>");
      return;
    }

    ctx.log.info("Discord token found, initializing client...");

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
