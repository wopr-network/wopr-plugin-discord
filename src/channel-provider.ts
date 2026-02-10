import type { Client, Message } from "discord.js";
import { logger } from "./logger.js";
import type {
  ChannelCommand,
  ChannelCommandContext,
  ChannelMessageContext,
  ChannelMessageParser,
  ChannelProvider,
} from "./types.js";

/**
 * Discord Channel Provider - allows other plugins to register commands and message parsers
 */
export class DiscordChannelProviderImpl implements ChannelProvider {
  private registeredCommands = new Map<string, ChannelCommand>();
  private registeredParsers = new Map<string, ChannelMessageParser>();

  id = "discord";

  constructor(private getClient: () => Client | null) {}

  registerCommand(cmd: ChannelCommand): void {
    this.registeredCommands.set(cmd.name, cmd);
    logger.info({ msg: "Channel command registered", name: cmd.name });
  }

  unregisterCommand(name: string): void {
    this.registeredCommands.delete(name);
  }

  getCommands(): ChannelCommand[] {
    return Array.from(this.registeredCommands.values());
  }

  addMessageParser(parser: ChannelMessageParser): void {
    this.registeredParsers.set(parser.id, parser);
    logger.info({ msg: "Message parser registered", id: parser.id });
  }

  removeMessageParser(id: string): void {
    this.registeredParsers.delete(id);
  }

  getMessageParsers(): ChannelMessageParser[] {
    return Array.from(this.registeredParsers.values());
  }

  async send(channelId: string, content: string): Promise<void> {
    const client = this.getClient();
    if (!client) throw new Error("Discord client not initialized");
    const channel = await client.channels.fetch(channelId);
    if (channel?.isTextBased() && "send" in channel) {
      // Split content into chunks of 2000 chars (Discord limit)
      const chunks: string[] = [];
      let remaining = content;
      while (remaining.length > 0) {
        if (remaining.length <= 2000) {
          chunks.push(remaining);
          break;
        }
        // Try to split at a newline or space near the limit
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
  }

  getBotUsername(): string {
    return this.getClient()?.user?.username || "unknown";
  }

  /**
   * Get the registered commands map (for slash-commands.ts default case)
   */
  getRegisteredCommands(): Map<string, ChannelCommand> {
    return this.registeredCommands;
  }

  /**
   * Check if a message matches a registered command and handle it
   * Returns true if handled, false otherwise
   */
  async handleRegisteredCommand(message: Message): Promise<boolean> {
    const content = message.content.trim();

    // Check for /command format
    if (!content.startsWith("/")) return false;

    const parts = content.slice(1).split(/\s+/);
    const cmdName = parts[0].toLowerCase();
    const args = parts.slice(1);

    const cmd = this.registeredCommands.get(cmdName);
    if (!cmd) return false;

    const channelId = message.channelId;
    const client = this.getClient();

    const cmdCtx: ChannelCommandContext = {
      channel: channelId,
      channelType: "discord",
      sender: message.author.username,
      args,
      reply: async (msg: string) => {
        await message.reply(msg);
      },
      getBotUsername: () => client?.user?.username || "unknown",
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
   * Check if a message matches any registered parser and handle it
   * Returns true if handled, false otherwise
   */
  async handleRegisteredParsers(message: Message): Promise<boolean> {
    const content = message.content;
    const channelId = message.channelId;
    const client = this.getClient();

    for (const parser of this.registeredParsers.values()) {
      let matches = false;

      if (typeof parser.pattern === "function") {
        matches = parser.pattern(content);
      } else {
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
          getBotUsername: () => client?.user?.username || "unknown",
        };

        try {
          await parser.handler(msgCtx);
          return true;
        } catch (error) {
          logger.error({ msg: "Message parser error", id: parser.id, error: String(error) });
          // Don't reply with error for parsers - they're silent watchers
          return false;
        }
      }
    }

    return false;
  }
}
