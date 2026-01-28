/**
 * WOPR Discord Plugin
 * Talk to your WOPR sessions via Discord.
 */

import { Client, GatewayIntentBits, Events, Message, TextChannel, DMChannel } from "discord.js";
import { writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import type { WOPRPlugin, WOPRPluginContext } from "wopr";

let client: Client | null = null;
let ctx: WOPRPluginContext | null = null;

interface ConfigSchema {
  token?: string;
  guildId?: string;
  pairingRequests?: Record<string, any>;
  mappings?: Record<string, any>;
}

const configSchema = {
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

function generatePairingCode(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 8; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

async function handleMessage(message: Message) {
  if (!client || !ctx) return;
  if (message.author.bot) return;
  if (!client.user) return;

  const isMentioned = message.mentions.has(client.user.id);
  const isDM = message.channel.type === 1;

  if (!isMentioned && !isDM) return;

  const resolvedContent = message.content;
  
  try {
    const response = await ctx.inject(`discord-${message.channel.id}`, resolvedContent);
    if (response) {
      await message.reply(response.slice(0, 2000));
    }
  } catch (error: any) {
    ctx.log.error("Discord inject error:", error);
    await message.reply("Error processing your request.");
  }
}

const plugin: WOPRPlugin = {
  name: "wopr-plugin-discord",
  version: "2.0.4",
  description: "Discord bot integration for WOPR",

  async init(context: WOPRPluginContext) {
    ctx = context;
    ctx.registerConfigSchema("wopr-plugin-discord", configSchema);
    ctx.log.info("Discord config schema registered");

    // Try plugin-specific config first, then fall back to legacy
    let config = ctx.getConfig<ConfigSchema>();
    ctx.log.info("Plugin config:", JSON.stringify(config));

    if (!config?.token) {
      const legacyConfig = ctx.getMainConfig("discord") as ConfigSchema;
      ctx.log.info("Legacy config:", JSON.stringify(legacyConfig));
      if (legacyConfig?.token) {
        config = { 
          token: legacyConfig.token, 
          guildId: legacyConfig.guildId,
          pairingRequests: config?.pairingRequests,
          mappings: config?.mappings
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
      ],
    });

    client.on(Events.MessageCreate, handleMessage);
    client.on(Events.Ready, () => {
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
