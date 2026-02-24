/**
 * WOPR Discord Plugin - Orchestrator
 *
 * Wires together extracted modules, handles event bus subscriptions,
 * and manages the Discord client lifecycle. All domain logic lives
 * in dedicated modules; this file is pure orchestration.
 */

import { Client, Events, GatewayIntentBits, Partials } from "discord.js";
import { discordChannelProvider, getRegisteredCommand, setChannelProviderClient } from "./channel-provider.js";
import { ChannelQueueManager } from "./channel-queue.js";
import { createDiscordExtension } from "./discord-extension.js";
import {
  executeInjectInternal,
  handleMessage,
  handleTypingStart,
  subscribeSessionCreateEvent,
  subscribeSessionEvents,
  subscribeStreamEvents,
} from "./event-handlers.js";
import {
  cleanupExpiredButtonRequests,
  getPendingButtonRequest,
  handleFriendButtonInteraction,
  isFriendRequestButton,
} from "./friend-buttons.js";
import { refreshIdentity } from "./identity-manager.js";
import { logger } from "./logger.js";
import { cleanupExpiredPairings, hasOwner } from "./pairing.js";
import { setReactionClient } from "./reaction-manager.js";
import { registerSlashCommands, SlashCommandHandler } from "./slash-commands.js";
import type { ConfigSchema, WOPRPlugin, WOPRPluginContext } from "./types.js";

let client: Client | null = null;
let ctx: WOPRPluginContext | null = null;
let queueManager: ChannelQueueManager | null = null;

// ============================================================================
// Config Schema
// ============================================================================

const configSchema: ConfigSchema = {
  title: "Discord Integration",
  description: "Configure Discord bot integration with slash commands",
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
      name: "clientId",
      type: "text",
      label: "Application ID",
      placeholder: "From Discord Developer Portal",
      description: "Discord Application ID (for slash commands)",
    },
    {
      name: "ownerUserId",
      type: "text",
      label: "Owner User ID (optional)",
      placeholder: "Your Discord user ID",
      description: "Receive private notifications for friend requests",
    },
    {
      name: "emojiQueued",
      type: "text",
      label: "Queued Emoji",
      placeholder: "\u{1f550}",
      default: "\u{1f550}",
      description: "Emoji shown when message is queued",
    },
    {
      name: "emojiActive",
      type: "text",
      label: "Active Emoji",
      placeholder: "\u26a1",
      default: "\u26a1",
      description: "Emoji shown when processing",
    },
    {
      name: "emojiDone",
      type: "text",
      label: "Done Emoji",
      placeholder: "\u2705",
      default: "\u2705",
      description: "Emoji shown when complete",
    },
    {
      name: "emojiError",
      type: "text",
      label: "Error Emoji",
      placeholder: "\u274c",
      default: "\u274c",
      description: "Emoji shown on error",
    },
    {
      name: "emojiCancelled",
      type: "text",
      label: "Cancelled Emoji",
      placeholder: "\u23f9\ufe0f",
      default: "\u23f9\ufe0f",
      description: "Emoji shown when cancelled",
    },
    // @ts-expect-error hidden not in shared ConfigField yet — needed to suppress config UI
    { name: "pairingRequests", type: "object", label: "Pairing Requests", hidden: true, default: {} },
    // @ts-expect-error hidden not in shared ConfigField yet — needed to suppress config UI
    { name: "mappings", type: "object", label: "Channel Mappings", hidden: true, default: {} },
  ],
};

// ============================================================================
// Plugin Definition
// ============================================================================

const plugin: WOPRPlugin = {
  name: "wopr-plugin-discord",
  version: "2.11.0",
  description: "Discord bot with slash commands and identity support",
  commands: [
    {
      name: "discord",
      description: "Discord plugin commands",
      usage: "wopr discord claim <code>",
      async handler(_context: WOPRPluginContext, args: string[]) {
        const [subcommand, ...rest] = args;

        if (subcommand === "claim") {
          const code = rest[0];
          if (!code) {
            // biome-ignore lint/suspicious/noConsole: CLI output
            console.log("Usage: wopr discord claim <code>");
            // biome-ignore lint/suspicious/noConsole: CLI output
            console.log("  Claim ownership of the Discord bot using a pairing code");
            process.exit(1);
          }

          try {
            const response = await fetch("http://localhost:7437/plugins/discord/claim", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ code }),
            });
            const result = (await response.json()) as {
              success?: boolean;
              userId?: string;
              username?: string;
              error?: string;
            };

            if (result.success) {
              // biome-ignore lint/suspicious/noConsole: CLI output
              console.log(`\u2713 Discord ownership claimed!`);
              // biome-ignore lint/suspicious/noConsole: CLI output
              console.log(`  Owner: ${result.username} (${result.userId})`);
              process.exit(0);
            } else {
              // biome-ignore lint/suspicious/noConsole: CLI output
              console.log(`Failed to claim: ${result.error || "Unknown error"}`);
              process.exit(1);
            }
          } catch (_err) {
            // biome-ignore lint/suspicious/noConsole: CLI output
            console.log(`Error: Could not connect to WOPR daemon. Is it running?`);
            // biome-ignore lint/suspicious/noConsole: CLI output
            console.log(`  Start it with: wopr daemon start`);
            process.exit(1);
          }
        } else {
          // biome-ignore lint/suspicious/noConsole: CLI output
          console.log("Discord plugin commands:");
          // biome-ignore lint/suspicious/noConsole: CLI output
          console.log("  wopr discord claim <code>  - Claim ownership using a pairing code");
          process.exit(subcommand ? 1 : 0);
        }
      },
    },
  ],
  async init(context: WOPRPluginContext) {
    ctx = context;
    ctx.registerConfigSchema("wopr-plugin-discord", configSchema);

    // 1. Create queue manager
    queueManager = new ChannelQueueManager((item, cancelToken) => {
      if (!ctx || !queueManager) return Promise.resolve();
      return executeInjectInternal(item, cancelToken, ctx, queueManager);
    });

    // 2. Create discord extension
    const discordExtension = createDiscordExtension(
      () => client,
      () => ctx,
    );

    // 3. Slash command handler
    const slashHandler = new SlashCommandHandler(
      () => client,
      ctx,
      queueManager,
      getRegisteredCommand,
      discordExtension.claimOwnership,
      () => (ctx ? hasOwner(ctx) : false),
    );

    // 4. Register channel provider
    if (ctx.registerChannelProvider) {
      ctx.registerChannelProvider(discordChannelProvider);
      logger.info("Registered Discord channel provider");
    }

    // 5. Register extension
    if (ctx.registerExtension) {
      ctx.registerExtension("discord", discordExtension);
      logger.info("Registered Discord extension");
    }

    // 6. Event bus subscriptions (session/stream events registered after client is created below)
    logger.info({ msg: "Checking ctx.events availability", hasEvents: !!ctx.events });

    // 7. Refresh identity
    await refreshIdentity(ctx);

    // 8. Load config and create Discord client
    let config = ctx.getConfig<{ token?: string; guildId?: string; clientId?: string }>();
    const mainDiscordConfig = ctx.getMainConfig("discord") as { token?: string; clientId?: string; guildId?: string };
    if (!config?.token && mainDiscordConfig?.token) {
      config = { ...config, token: mainDiscordConfig.token };
    }
    if (!config?.clientId && mainDiscordConfig?.clientId) {
      config = { ...config, clientId: mainDiscordConfig.clientId };
    }
    if (!config?.guildId && mainDiscordConfig?.guildId) {
      config = { ...config, guildId: mainDiscordConfig.guildId };
    }
    if (!config?.token) {
      logger.warn("Not configured");
      return;
    }

    client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.GuildMessageReactions,
        GatewayIntentBits.GuildMessageTyping,
      ],
      partials: [Partials.Channel, Partials.Message],
    });

    // Wire client into extracted modules
    setReactionClient(client);
    setChannelProviderClient(client);

    // Subscribe session/stream events now that client exists
    subscribeSessionEvents(ctx, client);
    subscribeStreamEvents(ctx);

    // 9. Register event handlers
    client.on(Events.MessageCreate, (m) => {
      if (!client || !ctx || !queueManager) return;
      return handleMessage(m, client, ctx, queueManager).catch((e) =>
        logger.error({ msg: "Message handling failed", error: String(e) }),
      );
    });
    client.on(Events.InteractionCreate, async (interaction) => {
      if (interaction.isAutocomplete()) {
        await slashHandler
          .handleAutocomplete(interaction)
          .catch((e) => logger.error({ msg: "Autocomplete error", error: String(e) }));
        return;
      }

      if (interaction.isChatInputCommand()) {
        await slashHandler.handle(interaction).catch((e) => logger.error({ msg: "Command error", error: String(e) }));
        return;
      }

      if (interaction.isButton() && isFriendRequestButton(interaction.customId)) {
        const p2pExt = ctx?.getExtension?.("p2p") as
          | {
              acceptFriendRequest?: (
                from: string,
                pubkey: string,
                encryptPub: string,
                signature: string,
                channelId: string,
              ) => Promise<{ friend: any; acceptMessage: string }>;
              denyFriendRequest?: (from: string, signature: string) => Promise<void>;
            }
          | undefined;

        await handleFriendButtonInteraction(
          interaction,
          ctx!,
          client?.user?.username || "unknown",
          async (from: string, pending) => {
            if (p2pExt?.acceptFriendRequest) {
              const result = await p2pExt.acceptFriendRequest(
                from,
                pending.requestPubkey,
                pending.encryptPub,
                pending.signature,
                pending.channelId,
              );
              logger.info({ msg: "Friend request accepted via button", from, friend: result.friend.name });
              return result.acceptMessage;
            } else {
              logger.warn({ msg: "P2P extension not available - cannot complete friendship" });
              return `Accepted friend request from @${from} (but P2P extension not available)`;
            }
          },
          async (from: string) => {
            if (p2pExt?.denyFriendRequest) {
              const pending = getPendingButtonRequest(from);
              if (pending?.signature) {
                await p2pExt.denyFriendRequest(from, pending.signature);
              } else {
                logger.warn({ msg: "No signature found for deny - skipping P2P deny call", from });
              }
            }
            logger.info({ msg: "Friend request denied via button", from });
          },
        ).catch((e) => logger.error({ msg: "Button interaction error", error: String(e) }));
        return;
      }
    });

    client.on(Events.TypingStart, (typing) => {
      if (client && queueManager) handleTypingStart(typing, client, queueManager);
    });

    // 10. Start processors
    queueManager.startProcessing(() => {
      cleanupExpiredPairings();
      cleanupExpiredButtonRequests();
    });

    client.on(Events.ClientReady, async () => {
      logger.info({ tag: client?.user?.tag });

      if (config.clientId && config.token) {
        await registerSlashCommands(config.token, config.clientId, config.guildId);
      } else {
        logger.warn("No clientId configured - slash commands not registered");
      }

      // Subscribe to session:create after client is ready (needs guild cache)
      if (client) {
        subscribeSessionCreateEvent(ctx!, client);
      }
    });

    try {
      await client.login(config.token);
      logger.info("Discord bot started");
    } catch (e) {
      logger.error({ msg: "Discord login failed", error: String(e) });
      throw e;
    }
  },
  async shutdown() {
    if (queueManager) {
      queueManager.stopProcessing();
      queueManager = null;
    }
    if (ctx?.unregisterChannelProvider) {
      ctx.unregisterChannelProvider("discord");
    }
    if (ctx?.unregisterExtension) {
      ctx.unregisterExtension("discord");
    }
    if (client) await client.destroy();
    setReactionClient(null);
    setChannelProviderClient(null);
  },
};

export default plugin;
