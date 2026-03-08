/**
 * Discord Channel Provider
 *
 * Implements the ChannelProvider interface, allowing other plugins to
 * register commands and message parsers that work within Discord channels.
 */

import type { Client, Message } from "discord.js";
import { logger } from "./logger.js";
import type {
  ChannelCommand,
  ChannelCommandContext,
  ChannelMessageContext,
  ChannelMessageParser,
  ChannelProvider,
} from "./types.js";
import { sanitize } from "./validation.js";

let discordClient: Client | null = null;

export function setChannelProviderClient(c: Client | null): void {
  discordClient = c;
}

// Registered commands and parsers from other plugins
const registeredCommands: Map<string, ChannelCommand> = new Map();

interface CommandAuthConfig {
  allowedUserIds: string[];
  allowedRoleIds: string[];
}

let commandAuthConfig: CommandAuthConfig = {
  allowedUserIds: [],
  allowedRoleIds: [],
};
let commandAuthConfigGetter: (() => CommandAuthConfig) | null = null;

export function setCommandAuthConfig(config: CommandAuthConfig): void {
  commandAuthConfig = config;
  commandAuthConfigGetter = null;
}

export function setCommandAuthConfigGetter(getter: () => CommandAuthConfig): void {
  commandAuthConfigGetter = getter;
}

function getCommandAuthConfig(): CommandAuthConfig {
  return commandAuthConfigGetter ? commandAuthConfigGetter() : commandAuthConfig;
}

const MAX_ARG_LENGTH = 512;

export function getRegisteredCommand(name: string): ChannelCommand | undefined {
  return registeredCommands.get(name);
}
const registeredParsers: Map<string, ChannelMessageParser> = new Map();

/**
 * Discord Channel Provider - allows other plugins to register commands and message parsers
 */
export const discordChannelProvider: ChannelProvider = {
  id: "discord",

  registerCommand(cmd: ChannelCommand): void {
    registeredCommands.set(cmd.name, cmd);
    logger.info({ msg: "Channel command registered", name: cmd.name });
  },

  unregisterCommand(name: string): void {
    registeredCommands.delete(name);
  },

  getCommands(): ChannelCommand[] {
    return Array.from(registeredCommands.values());
  },

  addMessageParser(parser: ChannelMessageParser): void {
    registeredParsers.set(parser.id, parser);
    logger.info({ msg: "Message parser registered", id: parser.id });
  },

  removeMessageParser(id: string): void {
    registeredParsers.delete(id);
  },

  getMessageParsers(): ChannelMessageParser[] {
    return Array.from(registeredParsers.values());
  },

  async send(channelId: string, content: string): Promise<void> {
    if (!discordClient) throw new Error("Discord client not initialized");
    const channel = await discordClient.channels.fetch(channelId);
    if (channel?.isTextBased() && "send" in channel) {
      const chunks: string[] = [];
      let remaining = content;
      while (remaining.length > 0) {
        if (remaining.length <= 2000) {
          chunks.push(remaining);
          break;
        }
        let splitAt = remaining.lastIndexOf("\n", 2000);
        if (splitAt < 1500) splitAt = remaining.lastIndexOf(" ", 2000);
        if (splitAt < 1500) splitAt = 2000;
        chunks.push(remaining.slice(0, splitAt));
        remaining = remaining.slice(splitAt).trimStart();
      }
      for (const chunk of chunks) {
        if (chunk.trim()) {
          await channel.send(chunk);
        }
      }
    }
  },

  getBotUsername(): string {
    return discordClient?.user?.username || "unknown";
  },
};

/**
 * Check if a message matches a registered command and handle it.
 * Returns true if handled, false otherwise.
 */
export async function handleRegisteredCommand(message: Message): Promise<boolean> {
  const content = message.content.trim();

  if (!content.startsWith("/")) return false;

  const parts = content.slice(1).split(/\s+/);
  const cmdName = parts[0].toLowerCase();

  const cmd = registeredCommands.get(cmdName);
  if (!cmd) return false;

  // --- Auth check ---
  const authConfig = getCommandAuthConfig();
  const userId = message.author.id;
  const userAllowed = authConfig.allowedUserIds.includes(userId);

  let roleAllowed = false;
  if (authConfig.allowedRoleIds.length > 0 && message.member) {
    const memberRoles = message.member.roles.cache;
    roleAllowed = authConfig.allowedRoleIds.some((roleId) => memberRoles.has(roleId));
  }

  if (!userAllowed && !roleAllowed) {
    logger.warn({
      msg: "Channel command blocked",
      cmd: cmdName,
      userId,
      username: message.author.username,
      reason: "not in allowlist",
    });
    try {
      await message.reply(`You are not authorized to use /${cmdName}.`);
    } catch (err) {
      logger.warn({ msg: "reply failed", error: String(err) });
    }
    return true;
  }

  // --- Sanitize args ---
  const rawArgs = parts.slice(1);
  const args = rawArgs.map((a) => sanitize(a).slice(0, MAX_ARG_LENGTH)).filter((a) => a.length > 0);

  const channelId = message.channelId;

  const cmdCtx: ChannelCommandContext = {
    channel: channelId,
    channelType: "discord",
    sender: message.author.username,
    args,
    reply: async (msg: string) => {
      await message.reply(msg);
    },
    getBotUsername: () => discordClient?.user?.username || "unknown",
  };

  try {
    await cmd.handler(cmdCtx);
    return true;
  } catch (error) {
    logger.error({ msg: "Channel command error", cmd: cmdName, error: String(error) });
    try {
      await message.reply(`Error executing /${cmdName}. Please try again later.`);
    } catch (replyErr) {
      logger.warn({ msg: "reply failed", error: String(replyErr) });
    }
    return true;
  }
}

/**
 * Check if a message matches any registered parser and handle it.
 * Returns true if handled, false otherwise.
 */
export async function handleRegisteredParsers(message: Message): Promise<boolean> {
  const content = message.content;
  const channelId = message.channelId;

  for (const parser of registeredParsers.values()) {
    let matches = false;

    if (typeof parser.pattern === "function") {
      matches = parser.pattern(content);
    } else {
      parser.pattern.lastIndex = 0;
      matches = parser.pattern.test(content);
    }

    if (matches) {
      const msgCtx: ChannelMessageContext = {
        channel: channelId,
        channelType: "discord",
        sender: message.author.username,
        content,
        reply: async (msg: string) => {
          await message.reply(msg);
        },
        getBotUsername: () => discordClient?.user?.username || "unknown",
      };

      try {
        await parser.handler(msgCtx);
        return true;
      } catch (error) {
        logger.error({ msg: "Message parser error", id: parser.id, error: String(error) });
        return false;
      }
    }
  }

  return false;
}
