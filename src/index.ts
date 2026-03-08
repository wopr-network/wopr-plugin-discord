/**
 * WOPR Discord Plugin - Orchestrator
 *
 * Wires together extracted modules, handles event bus subscriptions,
 * and manages the Discord client lifecycle. All domain logic lives
 * in dedicated modules; this file is pure orchestration.
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { Client, Events, GatewayIntentBits, Partials } from "discord.js";
import { DEFAULT_ALLOWED_CONTENT_TYPES, DEFAULT_MAX_PER_MESSAGE, DEFAULT_MAX_SIZE_BYTES } from "./attachments.js";
import {
  discordChannelProvider,
  getRegisteredCommand,
  setChannelProviderClient,
  setCommandAuthConfigGetter,
} from "./channel-provider.js";
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
import { refreshIdentity } from "./identity-manager.js";
import { logger } from "./logger.js";
import { cleanupExpiredPairings, hasOwner } from "./pairing.js";
import { RateLimiter } from "./rate-limiter.js";
import { setReactionClient } from "./reaction-manager.js";
import { registerSlashCommands, SlashCommandHandler } from "./slash-commands.js";
import type { ConfigSchema, WOPRPlugin, WOPRPluginContext } from "./types.js";

let client: Client | null = null;
let ctx: WOPRPluginContext | null = null;
let queueManager: ChannelQueueManager | null = null;
let rateLimiter: RateLimiter | null = null;
const cleanups: Array<() => void> = [];

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
      secret: true,
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
      description: "Discord user ID that owns this bot (used for /claim command)",
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
    {
      name: "useComponentsV2",
      type: "boolean",
      label: "Use Components v2",
      default: false,
      description: "Enable Discord Components v2 message layout (Containers, Sections). Cannot mix with legacy embeds.",
    },
    {
      name: "maxAttachmentSizeBytes",
      type: "number",
      label: "Max Attachment Size (bytes)",
      default: DEFAULT_MAX_SIZE_BYTES,
      description: "Maximum size in bytes for a single Discord attachment download (default 10MB)",
    },
    {
      name: "maxAttachmentsPerMessage",
      type: "number",
      label: "Max Attachments Per Message",
      default: DEFAULT_MAX_PER_MESSAGE,
      description: "Maximum number of attachments to download per message (default 5)",
    },
    {
      name: "allowedAttachmentTypes",
      type: "text",
      label: "Allowed Attachment Types",
      default: DEFAULT_ALLOWED_CONTENT_TYPES.join(","),
      description:
        "Comma-separated list of allowed MIME types for attachments (e.g. image/jpeg,image/png,text/plain,application/pdf)",
    },
    {
      name: "maxInjectionsPerUser",
      type: "number",
      label: "Max Injections Per User",
      default: 10,
      description: "Maximum number of AI requests a single user can make within the rate limit window (default 10)",
    },
    {
      name: "rateLimitWindowMs",
      type: "number",
      label: "Rate Limit Window (ms)",
      default: 60000,
      description: "Sliding window duration in milliseconds for per-user rate limiting (default 60000 = 60s)",
    },
    {
      name: "commandAllowedUserIds",
      type: "text",
      label: "Allowed User IDs for Channel Commands",
      placeholder: "Comma-separated Discord user IDs",
      default: "",
      description: "Discord user IDs allowed to invoke message-based /commands. Empty = deny all.",
    },
    {
      name: "commandAllowedRoleIds",
      type: "text",
      label: "Allowed Role IDs for Channel Commands",
      placeholder: "Comma-separated Discord role IDs",
      default: "",
      description:
        "Discord role IDs allowed to invoke message-based /commands. Empty = deny all (unless user IDs are set).",
    },
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
  manifest: {
    name: "wopr-plugin-discord",
    version: "2.11.0",
    description: "Discord bot with slash commands and identity support",
    capabilities: ["channel"],
    category: "channel",
    tags: ["discord", "chat", "bot", "messaging"],
    icon: "💬",
    requires: {},
    provides: {
      capabilities: [{ type: "channel", id: "discord", displayName: "Discord" }],
    },
    lifecycle: { shutdownBehavior: "graceful" },
    configSchema,
  },
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
            // Read daemon auth token from $WOPR_HOME/daemon-token
            // Default fallback mirrors the daemon's own convention (~/wopr)
            const woprHome = process.env.WOPR_HOME ?? join(homedir(), "wopr");
            const tokenPath = join(woprHome, "daemon-token");

            let authToken: string | null = null;
            try {
              const raw = await readFile(tokenPath, "utf-8");
              authToken = raw.trim() || null;
            } catch (err: unknown) {
              const fsCode = (err as NodeJS.ErrnoException).code;
              if (fsCode !== "ENOENT") {
                // File exists but is unreadable — warn so operators can diagnose
                console.warn(
                  `Warning: Could not read daemon auth token at ${tokenPath}: ${err instanceof Error ? err.message : String(err)}`,
                );
              }
              // ENOENT — token file absent, proceed without auth
            }

            // Guard against header injection via embedded newlines (outside the fs catch)
            if (authToken && (authToken.includes("\n") || authToken.includes("\r"))) {
              console.error(`Invalid daemon auth token (contains newline characters): ${tokenPath}`);
              process.exit(1);
            }

            const headers: Record<string, string> = { "Content-Type": "application/json" };
            if (authToken) {
              headers.Authorization = `Bearer ${authToken}`;
            }

            const response = await fetch("http://localhost:7437/plugins/discord/claim", {
              method: "POST",
              headers,
              body: JSON.stringify({ code }),
            });

            // Check HTTP status before parsing body to surface clear errors
            if (!response.ok) {
              const rawBody = await response.text().catch(() => "");
              let errorMsg: string;
              try {
                const errJson = rawBody ? (JSON.parse(rawBody) as { error?: string }) : {};
                errorMsg = errJson.error ?? `HTTP ${response.status}`;
              } catch {
                errorMsg = rawBody || `HTTP ${response.status}`;
              }
              if (response.status === 401 || response.status === 403) {
                console.error(`Authentication failed (${response.status}): ${errorMsg}`);
                if (!authToken) {
                  console.error(`  Daemon auth token not found at: ${tokenPath}`);
                  console.error(`  Ensure WOPR daemon has written a token to that path.`);
                }
              } else {
                console.error(`Failed to claim: ${errorMsg}`);
              }
              process.exit(1);
            }

            const rawBody = await response.text();
            let result: { success?: boolean; userId?: string; username?: string; error?: string } = {};
            try {
              result = rawBody ? (JSON.parse(rawBody) as typeof result) : {};
            } catch {
              result = { success: false, error: rawBody || "Invalid response from daemon" };
            }

            if (result.success) {
              // biome-ignore lint/suspicious/noConsole: CLI output
              console.log(`\u2713 Discord ownership claimed!`);
              // biome-ignore lint/suspicious/noConsole: CLI output
              console.log(`  Owner: ${result.username} (${result.userId})`);
              process.exit(0);
            } else {
              console.error(`Failed to claim: ${result.error || "Unknown error"}`);
              process.exit(1);
            }
          } catch (_err) {
            console.error(`Error: Could not connect to WOPR daemon. Is it running?`);
            console.error(`  Start it with: wopr daemon start`);
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
    // Register setup context provider for conversational setup
    if (ctx.registerSetupContextProvider) {
      ctx.registerSetupContextProvider(({ partialConfig }) => {
        const hasToken = !!partialConfig.token;
        const hasClientId = !!partialConfig.clientId;

        let instructions = `You are helping the user set up the Discord plugin for WOPR.\n\n## Discord Bot Setup Guide\n\n`;

        if (!hasToken) {
          instructions += `### Step 1: Create a Discord Bot\n1. Go to https://discord.com/developers/applications\n2. Click "New Application" and give it a name (e.g., "WOPR Bot")\n3. Go to the "Bot" tab in the left sidebar\n4. Click "Reset Token" to generate a new bot token\n5. Copy the token — you will need to paste it here\n6. Under "Privileged Gateway Intents", enable:\n   - MESSAGE CONTENT INTENT\n   - SERVER MEMBERS INTENT (optional, for user lookup)\n\nAsk the user to paste their bot token.\n`;
        } else {
          instructions += `### Step 1: Bot Token\nBot token is already configured. Moving on.\n\n`;
        }

        if (!hasClientId) {
          instructions += `### Step 2: Get the Application ID\n1. On the Discord Developer Portal, go to "General Information"\n2. Copy the "Application ID" (also called Client ID)\n3. Paste it here\n\nAsk the user for their Application ID.\n`;
        } else {
          instructions += `### Step 2: Application ID\nApplication ID is already configured. Moving on.\n\n`;
        }

        instructions += `### Step 3: Invite the Bot to a Server\n1. Go to the "OAuth2" tab, then "URL Generator"\n2. Select scopes: \`bot\`, \`applications.commands\`\n3. Select permissions: Send Messages, Read Message History, Add Reactions, Use Slash Commands\n4. Copy the generated URL and open it in a browser\n5. Select the server to add the bot to\n\nAsk the user to confirm they have invited the bot to their server.\n\n### Step 4: (Optional) Guild ID\nIf the user wants to restrict the bot to a single server, ask for the server's Guild ID.\nRight-click the server name in Discord > Copy Server ID (requires Developer Mode in Discord settings).\n`;

        return instructions;
      });
    }

    // 1. Create queue manager
    queueManager = new ChannelQueueManager((item, cancelToken) => {
      if (!ctx || !queueManager) return Promise.resolve();
      return executeInjectInternal(item, cancelToken, ctx, queueManager);
    });

    // Create rate limiter from config (WOP-1723)
    const rateLimitConfig = ctx.getConfig<{
      maxInjectionsPerUser?: number;
      rateLimitWindowMs?: number;
    }>();
    rateLimiter = new RateLimiter({
      maxRequests: rateLimitConfig.maxInjectionsPerUser ?? 10,
      windowMs: rateLimitConfig.rateLimitWindowMs ?? 60000,
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
    const mainDiscordConfig = ctx.getMainConfig("discord") as {
      token?: string;
      clientId?: string;
      guildId?: string;
    };
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

    // Wire command auth config — read dynamically so revocations take effect without restart
    const parseIdList = (csv: string | undefined): string[] =>
      (csv ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    setCommandAuthConfigGetter(() => {
      const cfg = ctx?.getConfig<{ commandAllowedUserIds?: string; commandAllowedRoleIds?: string }>();
      return {
        allowedUserIds: parseIdList(cfg?.commandAllowedUserIds),
        allowedRoleIds: parseIdList(cfg?.commandAllowedRoleIds),
      };
    });

    // Subscribe session/stream events now that client exists
    cleanups.push(subscribeSessionEvents(ctx, client));
    cleanups.push(subscribeStreamEvents(ctx));

    // 9. Register event handlers
    client.on(Events.MessageCreate, (m) => {
      if (!client || !ctx || !queueManager) return;
      return handleMessage(m, client, ctx, queueManager, rateLimiter ?? undefined).catch((e) =>
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
    });

    client.on(Events.TypingStart, (typing) => {
      if (client && queueManager) handleTypingStart(typing, client, queueManager);
    });

    // 10. Start processors
    queueManager.startProcessing(() => {
      cleanupExpiredPairings();
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
        // biome-ignore lint/style/noNonNullAssertion: ctx is initialized before ClientReady fires
        cleanups.push(subscribeSessionCreateEvent(ctx!, client));
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
    for (const cleanup of cleanups) {
      try {
        cleanup();
      } catch (_e) {
        /* ignore */
      }
    }
    cleanups.length = 0;

    if (queueManager) {
      queueManager.stopProcessing();
      queueManager = null;
    }
    if (rateLimiter) {
      rateLimiter.reset();
      rateLimiter = null;
    }
    if (ctx?.unregisterSetupContextProvider) {
      ctx.unregisterSetupContextProvider();
    }
    if (ctx?.unregisterChannelProvider) {
      ctx.unregisterChannelProvider("discord");
    }
    if (ctx?.unregisterExtension) {
      ctx.unregisterExtension("discord");
    }
    if (ctx?.unregisterConfigSchema) {
      ctx.unregisterConfigSchema("wopr-plugin-discord");
    }
    if (client) await client.destroy();
    setReactionClient(null);
    setChannelProviderClient(null);
    client = null;
    ctx = null;
  },
};

export default plugin;
