/**
 * WOPR Discord Plugin - Orchestrator
 *
 * Wires together extracted modules, handles event bus subscriptions,
 * and manages the Discord client lifecycle. All domain logic lives
 * in dedicated modules; this file is pure orchestration.
 */

import { createWriteStream, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import {
  ChannelType,
  Client,
  type DMChannel,
  Events,
  GatewayIntentBits,
  type Message,
  Partials,
  type TextChannel,
  type ThreadChannel,
} from "discord.js";
import {
  discordChannelProvider,
  getRegisteredCommand,
  handleRegisteredCommand,
  handleRegisteredParsers,
  setChannelProviderClient,
} from "./channel-provider.js";
import type { QueuedInject } from "./channel-queue.js";
import { ChannelQueueManager } from "./channel-queue.js";
import { findChannelIdFromConversationLog, getSessionKey, resolveMentions } from "./discord-utils.js";
import {
  cleanupExpiredButtonRequests,
  createFriendRequestButtons,
  createFriendRequestEmbed,
  getOwnerUserId,
  getPendingButtonRequest,
  handleFriendButtonInteraction,
  isFriendRequestButton,
  storePendingButtonRequest,
} from "./friend-buttons.js";
import {
  REACTION_ACTIVE,
  REACTION_CANCELLED,
  REACTION_DONE,
  REACTION_ERROR,
  refreshIdentity,
} from "./identity-manager.js";
import { logger } from "./logger.js";
import { DiscordMessageStream, eventBusStreams, handleChunk, streams } from "./message-streaming.js";
import {
  buildPairingMessage,
  claimPairingCode,
  cleanupExpiredPairings,
  createPairingRequest,
  hasOwner,
  setOwner,
} from "./pairing.js";
import { setMessageReaction, setReactionClient } from "./reaction-manager.js";
import { registerSlashCommands, SlashCommandHandler } from "./slash-commands.js";
import type {
  ConfigSchema,
  SessionCreateEvent,
  SessionInjectEvent,
  SessionResponseEvent,
  SessionStreamEvent,
  StreamMessage,
  WOPRPlugin,
  WOPRPluginContext,
} from "./types.js";
import { startTyping, stopTyping, tickTyping } from "./typing-manager.js";

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
    { name: "pairingRequests", type: "object", hidden: true, default: {} },
    { name: "mappings", type: "object", hidden: true, default: {} },
  ],
};

// ============================================================================
// Attachments
// ============================================================================

const ATTACHMENTS_DIR = existsSync("/data") ? "/data/attachments" : path.join(process.cwd(), "attachments");

async function saveAttachments(message: Message): Promise<string[]> {
  if (!message.attachments.size) return [];

  if (!existsSync(ATTACHMENTS_DIR)) {
    mkdirSync(ATTACHMENTS_DIR, { recursive: true });
  }

  const savedPaths: string[] = [];

  for (const [, attachment] of message.attachments) {
    try {
      const timestamp = Date.now();
      const safeName = attachment.name?.replace(/[^a-zA-Z0-9._-]/g, "_") || "attachment";
      const filename = `${timestamp}-${message.author.id}-${safeName}`;
      const filepath = path.join(ATTACHMENTS_DIR, filename);

      const response = await fetch(attachment.url);
      if (!response.ok) {
        logger.warn({ msg: "Failed to download attachment", url: attachment.url, status: response.status });
        continue;
      }

      const fileStream = createWriteStream(filepath);
      await pipeline(response.body as any, fileStream);

      savedPaths.push(filepath);
      logger.info({ msg: "Attachment saved", filename, size: attachment.size, contentType: attachment.contentType });
    } catch (err) {
      logger.error({ msg: "Error saving attachment", name: attachment.name, error: String(err) });
    }
  }

  return savedPaths;
}

// ============================================================================
// Friend Request Notification
// ============================================================================

async function sendFriendRequestNotification(
  requestFrom: string,
  pubkey: string,
  encryptPub: string,
  channelId: string,
  channelName: string,
  signature: string,
): Promise<boolean> {
  if (!ctx || !client) return false;

  const config = ctx.getConfig<{ ownerUserId?: string }>();
  if (!config.ownerUserId) {
    logger.warn({ msg: "No ownerUserId configured - friend request notification not sent" });
    return false;
  }

  try {
    const owner = await client.users.fetch(config.ownerUserId);
    if (!owner) {
      logger.warn({ msg: "Could not fetch owner user", ownerUserId: config.ownerUserId });
      return false;
    }

    const validationError = storePendingButtonRequest(requestFrom, pubkey, encryptPub, channelId, signature);
    if (validationError) {
      logger.warn({ msg: "Friend request rejected: invalid keys", requestFrom, error: validationError });
      return false;
    }

    const pubkeyShort = `${pubkey.slice(0, 12)}...`;
    const embed = createFriendRequestEmbed(requestFrom, pubkeyShort, channelName);
    const buttons = createFriendRequestButtons(requestFrom);

    await owner.send({
      embeds: [embed],
      components: [buttons],
    });

    logger.info({ msg: "Friend request notification sent to owner", requestFrom, ownerUserId: config.ownerUserId });
    return true;
  } catch (err) {
    logger.error({ msg: "Failed to send friend request notification", error: String(err) });
    return false;
  }
}

// ============================================================================
// Discord Extension (cross-plugin API)
// ============================================================================

const discordExtension = {
  sendFriendRequestNotification,
  getBotUsername: () => client?.user?.username || "unknown",

  claimOwnership: async (
    code: string,
    sourceId?: string,
    claimingUserId?: string,
  ): Promise<{ success: boolean; userId?: string; username?: string; error?: string }> => {
    if (!ctx) return { success: false, error: "Discord plugin not initialized" };

    const result = claimPairingCode(code, sourceId, claimingUserId);
    if (!result.request) {
      return { success: false, error: result.error || "Invalid or expired pairing code" };
    }

    await setOwner(ctx, result.request.discordUserId);

    return {
      success: true,
      userId: result.request.discordUserId,
      username: result.request.discordUsername,
    };
  },

  hasOwner: () => (ctx ? hasOwner(ctx) : false),
  getOwnerId: () => (ctx ? getOwnerUserId(ctx) : null),
};

// ============================================================================
// Core Inject Execution (orchestrator glue)
// ============================================================================

async function executeInjectInternal(item: QueuedInject, cancelToken: { cancelled: boolean }): Promise<void> {
  if (!ctx || !queueManager) return;

  const { sessionKey, messageContent: rawContent, authorDisplayName, replyToMessage } = item;
  const channelId = replyToMessage.channel.id;
  const streamKey = replyToMessage.id;

  if (cancelToken.cancelled) {
    logger.info({ msg: "executeInjectInternal - cancelled before start", sessionKey, streamKey });
    await setMessageReaction(replyToMessage, REACTION_CANCELLED);
    return;
  }

  await setMessageReaction(replyToMessage, REACTION_ACTIVE);

  const channel = replyToMessage.channel as TextChannel | ThreadChannel | DMChannel;
  await startTyping(channel);

  const state = queueManager.getSessionState(sessionKey);
  state.messageCount++;

  const stream = new DiscordMessageStream(
    replyToMessage.channel as TextChannel | ThreadChannel | DMChannel,
    replyToMessage,
  );
  streams.set(streamKey, stream);

  let messageContent = rawContent;
  if (state.thinkingLevel !== "medium") {
    messageContent = `[Thinking level: ${state.thinkingLevel}] ${messageContent}`;
  }

  try {
    logger.info({ msg: "executeInjectInternal - inject starting", sessionKey, streamKey, from: authorDisplayName });
    await ctx.inject(sessionKey, messageContent, {
      from: authorDisplayName,
      channel: { type: "discord", id: channelId, name: (replyToMessage.channel as any).name },
      contextProviders: ["session_system", "skills", "bootstrap_files"],
      onStream: (msg: StreamMessage) => {
        if (cancelToken.cancelled) return;
        tickTyping(channelId);
        handleChunk(msg, streamKey).catch((e) => logger.error({ msg: "Chunk error", streamKey, error: String(e) }));
      },
    });
    logger.info({ msg: "executeInjectInternal - inject complete", sessionKey, streamKey });

    await stream.finalize();
    streams.delete(streamKey);

    stopTyping(channelId, channel);

    await setMessageReaction(replyToMessage, REACTION_DONE);

    queueManager.clearBuffer(channelId);
  } catch (error: any) {
    const errorStr = String(error);
    const isCancelled =
      cancelToken.cancelled ||
      errorStr.toLowerCase().includes("cancelled") ||
      errorStr.toLowerCase().includes("canceled");

    stopTyping(channelId, channel);

    if (isCancelled) {
      logger.info({ msg: "executeInjectInternal - inject was cancelled", sessionKey, streamKey });
      try {
        await stream.finalize();
        streams.delete(streamKey);
        await setMessageReaction(replyToMessage, REACTION_CANCELLED);
      } catch (_e) {}
    } else {
      logger.error({ msg: "executeInjectInternal - inject failed", sessionKey, streamKey, error: errorStr });
      try {
        await stream.finalize();
        streams.delete(streamKey);
        await setMessageReaction(replyToMessage, REACTION_ERROR);
      } catch (_e) {}
    }
  }
}

// ============================================================================
// Message + Typing Handlers
// ============================================================================

async function handleMessage(message: Message) {
  if (!client || !ctx || !queueManager) return;
  if (!client.user) return;

  if (message.author.id === client.user.id) return;

  if (await handleRegisteredParsers(message)) {
    return;
  }

  if (message.interaction) return;

  const isDM = message.channel.type === 1;

  if (isDM && !hasOwner(ctx)) {
    const code = createPairingRequest(message.author.id, message.author.username);
    const pairingMessage = buildPairingMessage(code);
    await message.reply(pairingMessage);
    logger.info({ msg: "Pairing code generated", userId: message.author.id, username: message.author.username });
    return;
  }

  if (await handleRegisteredCommand(message)) {
    return;
  }

  const channelId = message.channel.id;
  const isDirectlyMentioned = message.mentions.users.has(client.user.id);
  const isBot = message.author.bot;

  const authorDisplayName =
    message.member?.displayName || (message.author as any).displayName || message.author.username;

  const resolvedContent = resolveMentions(message);

  const sessionKey = getSessionKey(message.channel as TextChannel | ThreadChannel | DMChannel);
  try {
    ctx.logMessage(sessionKey, resolvedContent, {
      from: authorDisplayName,
      channel: { type: "discord", id: channelId, name: (message.channel as any).name },
    });
  } catch (_e) {}

  queueManager.addToBuffer(channelId, {
    from: authorDisplayName,
    content: resolvedContent,
    timestamp: Date.now(),
    isBot,
    isMention: isDirectlyMentioned,
    originalMessage: message,
  });

  // === BOT MESSAGE HANDLING ===
  if (isBot) {
    if (!isDirectlyMentioned) return;

    let messageContent = resolvedContent;
    const botDisplayName = message.guild?.members.me?.displayName || client.user?.username || "WOPR";
    messageContent = messageContent.replace(new RegExp(`@${botDisplayName}\\s*`, "gi"), "").trim();

    if (!messageContent) return;

    const bufferContext = queueManager.getBufferContext(channelId);
    const fullMessage = bufferContext + messageContent;

    queueManager.queueInject(channelId, {
      sessionKey,
      messageContent: fullMessage,
      authorDisplayName,
      replyToMessage: message,
      isBot: true,
      queuedAt: Date.now(),
    });
    logger.info({ msg: "Bot @mention queued", channelId, botId: message.author.id, authorDisplayName });
    return;
  }

  // === HUMAN MESSAGE HANDLING ===
  if (isDirectlyMentioned || isDM) {
    const bufferContext = queueManager.getBufferContext(channelId);

    let messageContent = resolvedContent;
    if (client.user && isDirectlyMentioned) {
      const botDisplayName = message.guild?.members.me?.displayName || client.user?.username || "WOPR";
      messageContent = messageContent.replace(new RegExp(`@${botDisplayName}\\s*`, "gi"), "").trim();
    }

    if (message.attachments.size > 0) {
      const attachmentPaths = await saveAttachments(message);
      if (attachmentPaths.length > 0) {
        const attachmentInfo = attachmentPaths.map((p) => `[Attachment: ${p}]`).join("\n");
        messageContent = messageContent ? `${messageContent}\n\n${attachmentInfo}` : attachmentInfo;
        logger.info({ msg: "Attachments appended to message", count: attachmentPaths.length, channelId });
      }
    }

    if (!messageContent) {
      messageContent = "Hello! (You mentioned me without a message)";
      logger.info({ msg: "Human @mention - empty message, using default", channelId });
    }

    const fullMessage = bufferContext + messageContent;

    logger.info({ msg: "Human @mention - queueing (priority)", channelId, hasContext: bufferContext.length > 0 });

    queueManager.queueInject(channelId, {
      sessionKey,
      messageContent: fullMessage,
      authorDisplayName,
      replyToMessage: message,
      isBot: false,
      queuedAt: Date.now(),
    });
    return;
  }
}

function handleTypingStart(typing: any) {
  if (!client || !queueManager) return;
  if (typing.user.bot) return;
  queueManager.setHumanTyping(typing.channel.id);
}

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
            console.log("Usage: wopr discord claim <code>");
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
              console.log(`\u2713 Discord ownership claimed!`);
              console.log(`  Owner: ${result.username} (${result.userId})`);
              process.exit(0);
            } else {
              console.log(`Failed to claim: ${result.error || "Unknown error"}`);
              process.exit(1);
            }
          } catch (_err) {
            console.log(`Error: Could not connect to WOPR daemon. Is it running?`);
            console.log(`  Start it with: wopr daemon start`);
            process.exit(1);
          }
        } else {
          console.log("Discord plugin commands:");
          console.log("  wopr discord claim <code>  - Claim ownership using a pairing code");
          process.exit(subcommand ? 1 : 0);
        }
      },
    },
  ],
  async init(context: WOPRPluginContext) {
    ctx = context;
    ctx.registerConfigSchema("wopr-plugin-discord", configSchema);

    // 1. Create queue manager (executeInjectInternal reads module-level queueManager)
    queueManager = new ChannelQueueManager(executeInjectInternal);

    // 2. Slash command handler
    const slashHandler = new SlashCommandHandler(
      () => client,
      ctx,
      queueManager,
      getRegisteredCommand,
      discordExtension.claimOwnership,
      () => (ctx ? hasOwner(ctx) : false),
    );

    // 3. Register channel provider
    if (ctx.registerChannelProvider) {
      ctx.registerChannelProvider(discordChannelProvider);
      logger.info("Registered Discord channel provider");
    }

    // 4. Register extension
    if (ctx.registerExtension) {
      ctx.registerExtension("discord", discordExtension);
      logger.info("Registered Discord extension");
    }

    // 5. Event bus subscriptions
    logger.info({ msg: "Checking ctx.events availability", hasEvents: !!ctx.events });
    if (ctx.events) {
      ctx.events.on("session:beforeInject", async (payload: SessionInjectEvent) => {
        if (!payload.session.startsWith("discord:")) return;
        if (!payload.message) return;
        if (payload.channel?.type === "discord") return;
        if (!client) return;

        logger.info({ msg: "Session inject for Discord (streaming)", session: payload.session, from: payload.from });

        const channelId = findChannelIdFromConversationLog(payload.session);
        if (!channelId) {
          logger.warn({ msg: "Could not find Discord channel ID for inject", session: payload.session });
          return;
        }

        let sourceLabel = payload.from;
        if (payload.from === "cron") {
          sourceLabel = "Cron";
        } else if (payload.from === "cli") {
          sourceLabel = "CLI";
        } else if (payload.from?.startsWith("p2p:")) {
          sourceLabel = "P2P";
        } else if (payload.from?.startsWith("discord:")) {
          sourceLabel = `Session: ${payload.from}`;
        }

        try {
          const channel = await client.channels.fetch(channelId);
          if (!channel || !channel.isTextBased() || !("send" in channel)) {
            logger.warn({ msg: "Channel not sendable for streaming", session: payload.session, channelId });
            return;
          }
          const notificationMsg = await (channel as TextChannel | ThreadChannel | DMChannel).send(
            `**[${sourceLabel}]** ${payload.message.slice(0, 1900)}`,
          );
          logger.info({
            msg: "Sent inject notification, creating stream",
            session: payload.session,
            channelId,
            msgId: notificationMsg.id,
          });

          const existing = eventBusStreams.get(payload.session);
          if (existing) {
            await existing.finalize().catch(() => {});
            eventBusStreams.delete(payload.session);
          }

          const stream = new DiscordMessageStream(channel as TextChannel | ThreadChannel | DMChannel, notificationMsg);
          eventBusStreams.set(payload.session, stream);
        } catch (err) {
          logger.error({
            msg: "Failed to set up streaming for inject",
            session: payload.session,
            channelId,
            error: String(err),
          });
        }
      });

      ctx.events.on("session:afterInject", async (payload: SessionResponseEvent) => {
        if (!payload.session.startsWith("discord:")) return;
        if ((payload as any).channel?.type === "discord") return;

        const stream = eventBusStreams.get(payload.session);
        if (stream) {
          if (payload.response) {
            logger.info({
              msg: "Delivering inject response to Discord stream",
              session: payload.session,
              from: payload.from,
              responseLen: payload.response.length,
            });
            stream.append(payload.response);
          } else {
            logger.warn({
              msg: "afterInject: no response content to deliver",
              session: payload.session,
              from: payload.from,
            });
          }
          await stream.finalize().catch((err) => {
            logger.error({ msg: "Failed to finalize event bus stream", session: payload.session, error: String(err) });
          });
          eventBusStreams.delete(payload.session);
        } else if (payload.response) {
          logger.info({ msg: "No stream, falling back to bulk send", session: payload.session, from: payload.from });
          const channelId = findChannelIdFromConversationLog(payload.session);
          if (channelId) {
            try {
              await discordChannelProvider.send(channelId, payload.response);
            } catch (err) {
              logger.error({
                msg: "Failed to deliver response to Discord",
                session: payload.session,
                error: String(err),
              });
            }
          }
        }
      });
      logger.info("Subscribed to session events for Discord delivery (streaming)");
    }

    // 6. Stream event subscriptions
    if (ctx.on) {
      ctx.on("stream", (event: SessionStreamEvent) => {
        const stream = eventBusStreams.get(event.session);
        if (!stream) return;

        const msg = event.message;

        if (msg.type === "complete" || msg.type === "error") {
          logger.info({ msg: "Event bus stream complete, finalizing", session: event.session, type: msg.type });
          eventBusStreams.delete(event.session);
          stream.finalize().catch((err) => {
            logger.error({
              msg: "Failed to finalize event bus stream on complete",
              session: event.session,
              error: String(err),
            });
          });
          return;
        }

        if (msg.type === "system" && msg.subtype === "compact_boundary") {
          const metadata = msg.metadata as { pre_tokens?: number; trigger?: string } | undefined;
          if (metadata?.trigger === "auto") {
            let notification = "\u{1f4e6} **Auto-Compaction**\n";
            notification += metadata.pre_tokens
              ? `Context compressed from ~${Math.round(metadata.pre_tokens / 1000)}k tokens`
              : "Context has been automatically compressed";
            stream.append(`\n\n${notification}\n\n`);
          }
          return;
        }

        let textContent = "";
        if (msg.type === "text" && msg.content) {
          textContent = msg.content;
        } else if (msg.type === "assistant" && (msg as any).message?.content) {
          const content = (msg as any).message.content;
          if (Array.isArray(content)) {
            textContent = content.map((c: any) => c.text || "").join("");
          } else if (typeof content === "string") {
            textContent = content;
          }
        }

        if (textContent) {
          stream.append(textContent);
        }
      });
      logger.info("Subscribed to stream events for Discord streaming");
    }

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

    // 9. Register event handlers
    client.on(Events.MessageCreate, (m) =>
      handleMessage(m).catch((e) => logger.error({ msg: "Message handling failed", error: String(e) })),
    );
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

    client.on(Events.TypingStart, (typing) => handleTypingStart(typing));

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

      if (ctx?.events) {
        ctx.events.on("session:create", async (payload: SessionCreateEvent) => {
          const sessionName = payload.session;

          const match = sessionName.match(/^discord:([^:]+):#(.+)$/);
          if (!match) return;

          const [, guildName, channelName] = match;
          logger.info({ msg: "Session create for Discord pattern", sessionName, guildName, channelName });

          const guild = client?.guilds.cache.find(
            (g) =>
              g.name.toLowerCase().replace(/\s+/g, "-") === guildName.toLowerCase() ||
              g.name.toLowerCase() === guildName.toLowerCase(),
          );

          if (!guild) {
            logger.warn({ msg: "Guild not found for session", sessionName, guildName });
            return;
          }

          const existingChannel = guild.channels.cache.find(
            (c) => c.name.toLowerCase() === channelName.toLowerCase() && c.type === ChannelType.GuildText,
          );

          if (existingChannel) {
            logger.debug({ msg: "Channel already exists", channelName, channelId: existingChannel.id });
            return;
          }

          let woprCategory = guild.channels.cache.find(
            (c) => c.name.toLowerCase() === "wopr" && c.type === ChannelType.GuildCategory,
          );

          if (!woprCategory) {
            try {
              woprCategory = await guild.channels.create({
                name: "WOPR",
                type: ChannelType.GuildCategory,
              });
              logger.info({ msg: "Created WOPR category", categoryId: woprCategory.id });
            } catch (err) {
              logger.error({ msg: "Failed to create WOPR category", error: String(err) });
              return;
            }
          }

          try {
            const newChannel = await guild.channels.create({
              name: channelName,
              type: ChannelType.GuildText,
              parent: woprCategory.id,
            });
            logger.info({
              msg: "Created Discord channel for session",
              channelName,
              channelId: newChannel.id,
              sessionName,
            });
          } catch (err) {
            logger.error({ msg: "Failed to create Discord channel", channelName, error: String(err) });
          }
        });
        logger.info("Subscribed to session:create for auto-channel creation");
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
