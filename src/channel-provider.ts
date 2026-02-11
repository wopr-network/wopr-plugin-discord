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

let discordClient: Client | null = null;

export function setChannelProviderClient(c: Client | null): void {
  discordClient = c;
}

// Registered commands and parsers from other plugins (e.g., P2P friend commands)
const registeredCommands: Map<string, ChannelCommand> = new Map();

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
  const args = parts.slice(1);

  const cmd = registeredCommands.get(cmdName);
  if (!cmd) return false;

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
    await message.reply(`Error executing /${cmdName}: ${error}`);
    return true; // Still handled, just with error
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
