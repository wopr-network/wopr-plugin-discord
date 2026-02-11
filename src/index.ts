/**
 * WOPR Discord Plugin - With Slash Commands
 */

import { createWriteStream, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import {
  ChannelType,
  type ChatInputCommandInteraction,
  Client,
  type DMChannel,
  Events,
  GatewayIntentBits,
  type Message,
  Partials,
  REST,
  Routes,
  SlashCommandBuilder,
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
import {
  findChannelIdFromConversationLog,
  getSessionKey,
  getSessionKeyFromInteraction,
  resolveMentions,
} from "./discord-utils.js";
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
  REACTION_QUEUED,
  refreshIdentity,
} from "./identity-manager.js";
import { logger } from "./logger.js";
import { DISCORD_LIMIT, DiscordMessageStream, eventBusStreams, handleChunk, streams } from "./message-streaming.js";
import {
  buildPairingMessage,
  claimPairingCode,
  cleanupExpiredPairings,
  createPairingRequest,
  hasOwner,
  setOwner,
} from "./pairing.js";
import { clearMessageReactions, setMessageReaction, setReactionClient } from "./reaction-manager.js";
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

// Slash command definitions
const commands = [
  new SlashCommandBuilder().setName("status").setDescription("Show session status and configuration"),
  new SlashCommandBuilder().setName("new").setDescription("Start a new session (reset conversation)"),
  new SlashCommandBuilder().setName("reset").setDescription("Reset the current session (alias for /new)"),
  new SlashCommandBuilder().setName("compact").setDescription("Compact session context (summarize conversation)"),
  new SlashCommandBuilder()
    .setName("think")
    .setDescription("Set the thinking level for responses")
    .addStringOption((option) =>
      option
        .setName("level")
        .setDescription("Thinking level")
        .setRequired(true)
        .addChoices(
          { name: "Off", value: "off" },
          { name: "Minimal", value: "minimal" },
          { name: "Low", value: "low" },
          { name: "Medium", value: "medium" },
          { name: "High", value: "high" },
          { name: "Maximum", value: "xhigh" },
        ),
    ),
  new SlashCommandBuilder()
    .setName("verbose")
    .setDescription("Toggle verbose mode")
    .addBooleanOption((option) =>
      option.setName("enabled").setDescription("Enable or disable verbose mode").setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName("usage")
    .setDescription("Set usage tracking display")
    .addStringOption((option) =>
      option
        .setName("mode")
        .setDescription("Usage display mode")
        .setRequired(true)
        .addChoices(
          { name: "Off", value: "off" },
          { name: "Tokens only", value: "tokens" },
          { name: "Full", value: "full" },
        ),
    ),
  new SlashCommandBuilder()
    .setName("session")
    .setDescription("Switch to a different session")
    .addStringOption((option) => option.setName("name").setDescription("Session name").setRequired(true)),
  new SlashCommandBuilder()
    .setName("wopr")
    .setDescription("Send a message to WOPR")
    .addStringOption((option) => option.setName("message").setDescription("Your message").setRequired(true)),
  new SlashCommandBuilder().setName("help").setDescription("Show available commands and help"),
  new SlashCommandBuilder()
    .setName("claim")
    .setDescription("Claim ownership of this bot with a pairing code (DM only)")
    .addStringOption((option) =>
      option.setName("code").setDescription("The pairing code you received").setRequired(true),
    ),
  new SlashCommandBuilder().setName("cancel").setDescription("Cancel the current AI response in progress"),
  new SlashCommandBuilder()
    .setName("model")
    .setDescription("Switch the AI model for this session")
    .addStringOption((option) =>
      option
        .setName("model")
        .setDescription("Model name or ID (e.g. opus, haiku, gpt-5.2)")
        .setRequired(true)
        .setAutocomplete(true),
    ),
];

// Get all available models from all registered providers
// Returns { providerId, modelId, displayName } for each model
interface ResolvedModel {
  provider: string;
  id: string;
  name: string;
}

function getAllModels(): ResolvedModel[] {
  const results: ResolvedModel[] = [];
  // Get all registered providers via the plugin context
  // Iterate known provider IDs from the registry
  const providerIds = ["anthropic", "openai", "kimi", "opencode", "codex"];
  for (const pid of providerIds) {
    const provider = (ctx as any)?.getProvider?.(pid);
    if (!provider?.supportedModels) continue;
    for (const modelId of provider.supportedModels) {
      results.push({
        provider: pid,
        id: modelId,
        name: modelIdToDisplayName(modelId),
      });
    }
  }
  return results;
}

// Convert a model ID to a human-readable display name
// "claude-opus-4-6" -> "Opus 4.6"
// "claude-sonnet-4-5-20250929" -> "Sonnet 4.5"
// "gpt-5.2" -> "GPT 5.2"
// Unknown -> return as-is
function modelIdToDisplayName(id: string): string {
  // Claude models: claude-{tier}-{version}[-snapshot]
  const claude = id.match(/^claude-(\w+)-(\d[\d.-]*)(?:-\d{8})?$/);
  if (claude) {
    const tier = claude[1].charAt(0).toUpperCase() + claude[1].slice(1);
    const ver = claude[2].replace(/-/g, ".");
    return `${tier} ${ver}`;
  }
  // GPT models
  const gpt = id.match(/^gpt-(.+)$/i);
  if (gpt) return `GPT ${gpt[1]}`;
  // o-series (o1, o3, etc.)
  const o = id.match(/^o(\d.*)$/);
  if (o) return `o${o[1]}`;
  return id;
}

// Resolve user input to a model - supports:
// - Exact model ID: "claude-opus-4-6"
// - Shortcut name: "opus", "haiku", "sonnet", "gpt"
// - Partial match: "4.6", "codex"
function resolveModel(input: string): { provider: string; id: string; name: string } | null {
  const models = getAllModels();
  if (models.length === 0) return null;

  const q = input.toLowerCase().trim();

  // Exact ID match
  const exact = models.find((m) => m.id === q);
  if (exact) return exact;

  // Substring match on model ID
  const partial = models.find((m) => m.id.includes(q));
  if (partial) return partial;

  // Substring match on display name
  const byName = models.find((m) => m.name.toLowerCase().includes(q));
  if (byName) return byName;

  return null;
}

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
      placeholder: "🕐",
      default: "🕐",
      description: "Emoji shown when message is queued",
    },
    {
      name: "emojiActive",
      type: "text",
      label: "Active Emoji",
      placeholder: "⚡",
      default: "⚡",
      description: "Emoji shown when processing",
    },
    {
      name: "emojiDone",
      type: "text",
      label: "Done Emoji",
      placeholder: "✅",
      default: "✅",
      description: "Emoji shown when complete",
    },
    {
      name: "emojiError",
      type: "text",
      label: "Error Emoji",
      placeholder: "❌",
      default: "❌",
      description: "Emoji shown on error",
    },
    {
      name: "emojiCancelled",
      type: "text",
      label: "Cancelled Emoji",
      placeholder: "⏹️",
      default: "⏹️",
      description: "Emoji shown when cancelled",
    },
    { name: "pairingRequests", type: "object", hidden: true, default: {} },
    { name: "mappings", type: "object", hidden: true, default: {} },
  ],
};

// Session state management per channel
interface SessionState {
  thinkingLevel: string;
  verbose: boolean;
  usageMode: string;
  messageCount: number;
  model: string;
  lastBotInteraction?: Record<string, number>; // botId -> timestamp for cooldown
}

const sessionStates = new Map<string, SessionState>();

function getSessionState(sessionKey: string): SessionState {
  if (!sessionStates.has(sessionKey)) {
    sessionStates.set(sessionKey, {
      thinkingLevel: "medium",
      verbose: false,
      usageMode: "tokens",
      messageCount: 0,
      model: "claude-sonnet-4-20250514",
    });
  }
  return sessionStates.get(sessionKey)!;
}

// ============================================================================
// Channel Message Queue System - Promise chain for sequential message processing
// ============================================================================

interface BufferedMessage {
  from: string;
  content: string;
  timestamp: number;
  isBot: boolean;
  isMention: boolean; // was this bot directly @mentioned?
  originalMessage: Message;
}

interface QueuedInject {
  sessionKey: string;
  messageContent: string;
  authorDisplayName: string;
  replyToMessage: Message;
  isBot: boolean;
  queuedAt: number;
  cooldownUntil?: number; // for bot messages only
}

interface ChannelQueue {
  buffer: BufferedMessage[];
  // Promise chain - each inject waits for the previous to complete
  processingChain: Promise<void>;
  // Pending items waiting to be added to chain (for bot cooldown/human typing)
  pendingItems: QueuedInject[];
  humanTypingUntil: number;
  // Track if we're currently processing (for /cancel)
  currentInject: { cancelled: boolean } | null;
}

const channelQueues = new Map<string, ChannelQueue>();
const HUMAN_TYPING_WINDOW_MS = 15000; // 15s after human stops typing
const BOT_COOLDOWN_MS = 5000; // 5s between bot responses

function getChannelQueue(channelId: string): ChannelQueue {
  if (!channelQueues.has(channelId)) {
    channelQueues.set(channelId, {
      buffer: [],
      processingChain: Promise.resolve(),
      pendingItems: [],
      humanTypingUntil: 0,
      currentInject: null,
    });
  }
  return channelQueues.get(channelId)!;
}

function addToBuffer(channelId: string, msg: BufferedMessage) {
  const queue = getChannelQueue(channelId);
  queue.buffer.push(msg);
  // Keep buffer reasonable size (last 20 messages)
  if (queue.buffer.length > 20) {
    queue.buffer.shift();
  }
  logger.info({
    msg: "Buffer add",
    channelId,
    from: msg.from,
    isBot: msg.isBot,
    isMention: msg.isMention,
    bufferSize: queue.buffer.length,
  });
}

function getBufferContext(channelId: string): string {
  const queue = getChannelQueue(channelId);
  if (queue.buffer.length === 0) return "";

  // Build context from buffer (exclude the triggering message itself)
  const contextLines = queue.buffer.slice(0, -1).map((m) => `${m.from}: ${m.content}`);
  if (contextLines.length === 0) return "";

  return `[Recent conversation context]\n${contextLines.join("\n")}\n[End context]\n\n`;
}

function clearBuffer(channelId: string) {
  const queue = getChannelQueue(channelId);
  queue.buffer = [];
}

function setHumanTyping(channelId: string) {
  const queue = getChannelQueue(channelId);
  queue.humanTypingUntil = Date.now() + HUMAN_TYPING_WINDOW_MS;
  logger.info({ msg: "Human typing detected", channelId, pauseUntil: new Date(queue.humanTypingUntil).toISOString() });
}

/**
 * Queue an inject to the promise chain.
 * Human messages go directly to chain. Bot messages wait for cooldown.
 */
function queueInject(channelId: string, item: QueuedInject) {
  const queue = getChannelQueue(channelId);

  if (item.isBot) {
    // Bot messages: add to pending with cooldown, processor will add to chain
    item.cooldownUntil = Date.now() + BOT_COOLDOWN_MS;
    queue.pendingItems.push(item);
    // Show queued reaction
    setMessageReaction(item.replyToMessage, REACTION_QUEUED).catch(() => {});
    logger.info({
      msg: "Bot inject queued (pending cooldown)",
      channelId,
      from: item.authorDisplayName,
      queueSize: queue.pendingItems.length,
    });
  } else {
    // Human messages: add directly to promise chain (immediate priority)
    // Also clear any pending bot messages - human takes priority
    if (queue.pendingItems.length > 0) {
      logger.info({
        msg: "Clearing pending bot messages - human priority",
        channelId,
        cleared: queue.pendingItems.length,
      });
      // Clear queued reactions from cancelled bot messages
      for (const pending of queue.pendingItems) {
        clearMessageReactions(pending.replyToMessage).catch(() => {});
      }
      queue.pendingItems = [];
    }

    // Check if there's already something processing - if so, show queued first
    if (queue.currentInject) {
      setMessageReaction(item.replyToMessage, REACTION_QUEUED).catch(() => {});
    }

    addToChain(channelId, item);
    logger.info({ msg: "Human inject queued (direct to chain)", channelId, from: item.authorDisplayName });
  }
}

/**
 * Add an inject to the promise chain - it will execute after all previous injects complete.
 */
function addToChain(channelId: string, item: QueuedInject) {
  const queue = getChannelQueue(channelId);

  queue.processingChain = queue.processingChain.then(async () => {
    // Check if cancelled before starting
    if (queue.currentInject?.cancelled) {
      logger.info({ msg: "Inject skipped - queue was cancelled", channelId, from: item.authorDisplayName });
      return;
    }

    // Create cancellation token for this inject
    const cancelToken = { cancelled: false };
    queue.currentInject = cancelToken;

    try {
      await executeInjectInternal(item, cancelToken);
    } catch (error) {
      logger.error({ msg: "Chain inject failed", channelId, error: String(error) });
    } finally {
      // Clear current inject if it's still ours
      if (queue.currentInject === cancelToken) {
        queue.currentInject = null;
      }
    }
  });
}

/**
 * Cancel current and pending injects for a channel.
 * Returns true if there was something to cancel.
 */
function cancelChannelQueue(channelId: string): boolean {
  const queue = getChannelQueue(channelId);
  let hadSomething = false;

  // Cancel current inject (reaction will be set by executeInjectInternal when it detects cancellation)
  if (queue.currentInject) {
    queue.currentInject.cancelled = true;
    hadSomething = true;
    logger.info({ msg: "Current inject cancelled", channelId });
  }

  // Clear pending items and set cancelled reaction on each
  if (queue.pendingItems.length > 0) {
    hadSomething = true;
    logger.info({ msg: "Pending items cleared", channelId, count: queue.pendingItems.length });
    for (const item of queue.pendingItems) {
      setMessageReaction(item.replyToMessage, REACTION_CANCELLED).catch(() => {});
    }
    queue.pendingItems = [];
  }

  // Reset the chain to resolved (don't wait for cancelled items)
  queue.processingChain = Promise.resolve();

  return hadSomething;
}

/**
 * Get count of pending items in queue (for status display)
 */
function getQueuedCount(channelId: string): number {
  const queue = getChannelQueue(channelId);
  return queue.pendingItems.length + (queue.currentInject ? 1 : 0);
}

// Check and fire pending bot responses (called periodically)
async function processPendingBotResponses() {
  const now = Date.now();

  for (const [channelId, queue] of channelQueues.entries()) {
    // Skip if no pending items
    if (queue.pendingItems.length === 0) continue;

    // Skip if human is typing
    if (now < queue.humanTypingUntil) continue;

    // Find items ready to fire (past cooldown)
    const readyItems: QueuedInject[] = [];
    const stillPending: QueuedInject[] = [];

    for (const item of queue.pendingItems) {
      if (item.cooldownUntil && now < item.cooldownUntil) {
        stillPending.push(item);
      } else {
        readyItems.push(item);
      }
    }

    queue.pendingItems = stillPending;

    // Add ready items to chain
    for (const item of readyItems) {
      logger.info({ msg: "Moving pending item to chain", channelId, from: item.authorDisplayName });
      addToChain(channelId, item);
    }
  }
}

// Start periodic check for pending responses
let queueProcessorInterval: NodeJS.Timeout | null = null;
let cleanupInterval: NodeJS.Timeout | null = null;

function startQueueProcessor() {
  if (queueProcessorInterval) return;
  queueProcessorInterval = setInterval(() => {
    processPendingBotResponses().catch((err) => logger.error({ msg: "Queue processor error", error: String(err) }));
  }, 1000); // Check every second
  logger.info({ msg: "Queue processor started" });
}

function startCleanupInterval() {
  if (cleanupInterval) return;
  // Clean up expired pairings and button requests every minute
  cleanupInterval = setInterval(() => {
    cleanupExpiredPairings();
    cleanupExpiredButtonRequests();
  }, 60000);
  logger.info({ msg: "Cleanup interval started" });
}

function stopQueueProcessor() {
  if (queueProcessorInterval) {
    clearInterval(queueProcessorInterval);
    queueProcessorInterval = null;
    logger.info({ msg: "Queue processor stopped" });
  }
  if (cleanupInterval) {
    clearInterval(cleanupInterval);
    cleanupInterval = null;
  }
}

/**
 * Send a friend request notification to the owner with Accept/Deny buttons.
 * Returns true if notification was sent, false if no owner configured.
 */
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
    // Fetch the owner user
    const owner = await client.users.fetch(config.ownerUserId);
    if (!owner) {
      logger.warn({ msg: "Could not fetch owner user", ownerUserId: config.ownerUserId });
      return false;
    }

    // Validate and store pending request for button handling
    const validationError = storePendingButtonRequest(requestFrom, pubkey, encryptPub, channelId, signature);
    if (validationError) {
      logger.warn({ msg: "Friend request rejected: invalid keys", requestFrom, error: validationError });
      return false;
    }

    // Create the embed and buttons
    const pubkeyShort = `${pubkey.slice(0, 12)}...`;
    const embed = createFriendRequestEmbed(requestFrom, pubkeyShort, channelName);
    const buttons = createFriendRequestButtons(requestFrom);

    // Send DM to owner
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

// Expose Discord extension to other plugins and CLI
const discordExtension = {
  sendFriendRequestNotification,
  getBotUsername: () => client?.user?.username || "unknown",

  // Pairing methods for CLI
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

    // Set the owner in config
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
// Attachments directory
const ATTACHMENTS_DIR = existsSync("/data") ? "/data/attachments" : path.join(process.cwd(), "attachments");

/**
 * Download and save message attachments to disk
 * Returns array of file paths
 */
async function saveAttachments(message: Message): Promise<string[]> {
  if (!message.attachments.size) return [];

  // Ensure attachments directory exists
  if (!existsSync(ATTACHMENTS_DIR)) {
    mkdirSync(ATTACHMENTS_DIR, { recursive: true });
  }

  const savedPaths: string[] = [];

  for (const [, attachment] of message.attachments) {
    try {
      // Create unique filename: timestamp-originalname
      const timestamp = Date.now();
      const safeName = attachment.name?.replace(/[^a-zA-Z0-9._-]/g, "_") || "attachment";
      const filename = `${timestamp}-${message.author.id}-${safeName}`;
      const filepath = path.join(ATTACHMENTS_DIR, filename);

      // Download the attachment
      const response = await fetch(attachment.url);
      if (!response.ok) {
        logger.warn({ msg: "Failed to download attachment", url: attachment.url, status: response.status });
        continue;
      }

      // Save to disk
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

// Handle slash commands
async function handleSlashCommand(interaction: ChatInputCommandInteraction) {
  if (!ctx || !client) return;

  const { commandName } = interaction;
  const sessionKey = getSessionKeyFromInteraction(interaction);
  const state = getSessionState(sessionKey);

  logger.info({ msg: "Slash command received", command: commandName, user: interaction.user.tag });

  switch (commandName) {
    case "status": {
      const sessionInfo = await getSessionInfo(sessionKey);
      await interaction.reply({
        content:
          `📊 **Session Status**\n\n` +
          `**Session:** ${sessionKey}\n` +
          `**Thinking Level:** ${state.thinkingLevel}\n` +
          `**Verbose Mode:** ${state.verbose ? "On" : "Off"}\n` +
          `**Usage Tracking:** ${state.usageMode}\n` +
          `**Messages:** ${state.messageCount}\n` +
          `${sessionInfo}`,
        ephemeral: true,
      });
      break;
    }

    case "new":
    case "reset": {
      // Reset the session state (thinking level, verbose mode, etc.)
      // Note: Streams are keyed by message ID now, not session - nothing to clean up here
      sessionStates.delete(sessionKey);
      await interaction.reply({
        content: "🔄 **Session Reset**\n\nStarting fresh! Your conversation history has been cleared.",
        ephemeral: false,
      });
      break;
    }

    case "compact": {
      await interaction.reply({
        content: "📦 **Compacting Session**\n\nTriggering context compaction...",
        ephemeral: false,
      });

      try {
        let compactMetadata: { pre_tokens?: number; trigger?: string } | undefined;

        // Inject the actual /compact command to trigger Claude Code's internal compaction
        const result = await ctx.inject(sessionKey, "/compact", {
          silent: true,
          onStream: (msg: StreamMessage) => {
            // Capture compact_boundary metadata if available
            if (msg.type === "system" && msg.subtype === "compact_boundary" && msg.metadata) {
              compactMetadata = msg.metadata as { pre_tokens?: number; trigger?: string };
            }
          },
        });

        // Build response with metadata if available
        let response = "📦 **Session Compacted**\n\n";
        if (compactMetadata) {
          if (compactMetadata.pre_tokens) {
            response += `Compressed from ~${Math.round(compactMetadata.pre_tokens / 1000)}k tokens\n`;
          }
          response += `Trigger: ${compactMetadata.trigger || "manual"}`;
        } else {
          response += result || "Context has been compacted.";
        }

        await interaction.editReply(response);
      } catch (_e) {
        await interaction.editReply("❌ Failed to compact session.");
      }
      break;
    }

    case "think": {
      const level = interaction.options.getString("level", true);
      state.thinkingLevel = level;
      const levelEmoji = { off: "🛑", minimal: "💡", low: "🤔", medium: "🧠", high: "🔬", xhigh: "🔮" }[level] || "🧠";
      await interaction.reply({
        content: `${levelEmoji} **Thinking level set to:** ${level}`,
        ephemeral: true,
      });
      break;
    }

    case "verbose": {
      const enabled = interaction.options.getBoolean("enabled", true);
      state.verbose = enabled;
      await interaction.reply({
        content: enabled ? "🔊 **Verbose mode enabled**" : "🔇 **Verbose mode disabled**",
        ephemeral: true,
      });
      break;
    }

    case "usage": {
      const mode = interaction.options.getString("mode", true);
      state.usageMode = mode;
      await interaction.reply({
        content: `📈 **Usage tracking set to:** ${mode}`,
        ephemeral: true,
      });
      break;
    }

    case "session": {
      const name = interaction.options.getString("name", true);
      const baseKey = getSessionKeyFromInteraction(interaction);
      const newSessionKey = `${baseKey}/${name}`;
      await interaction.reply({
        content: `💬 **Switched to session:** ${newSessionKey}\n\nNote: Each session maintains separate context.`,
        ephemeral: false,
      });
      break;
    }

    case "wopr": {
      const message = interaction.options.getString("message", true);
      await handleWoprMessage(interaction, message);
      break;
    }

    case "help": {
      await interaction.reply({
        content:
          `**🤖 WOPR Discord Commands**\n\n` +
          `**/status** - Show session status\n` +
          `**/new** or **/reset** - Start fresh session\n` +
          `**/compact** - Summarize conversation\n` +
          `**/think <level>** - Set thinking level (off/minimal/low/medium/high/xhigh)\n` +
          `**/verbose <on/off>** - Toggle verbose mode\n` +
          `**/usage <mode>** - Set usage tracking (off/tokens/full)\n` +
          `**/model <model>** - Switch AI model (sonnet/opus/haiku)\n` +
          `**/cancel** - Stop the current AI response\n` +
          `**/session <name>** - Switch to named session\n` +
          `**/wopr <message>** - Send message to WOPR\n` +
          `**/claim <code>** - Claim bot ownership (DM only)\n` +
          `**/help** - Show this help\n\n` +
          `You can also mention me (@${client.user?.username}) to chat!`,
        ephemeral: true,
      });
      break;
    }

    case "claim": {
      // Only allow in DMs
      if (interaction.channel?.type !== 1) {
        await interaction.reply({
          content: "❌ The /claim command only works in DMs. Please DM me to claim ownership.",
          ephemeral: true,
        });
        break;
      }

      // Check if owner already set
      if (hasOwner(ctx)) {
        await interaction.reply({
          content: "❌ This bot already has an owner configured.",
          ephemeral: true,
        });
        break;
      }

      const code = interaction.options.getString("code", true);
      const result = await discordExtension.claimOwnership(code, interaction.user.id, interaction.user.id);

      if (result.success) {
        await interaction.reply({
          content:
            `✅ **Ownership claimed!**\n\n` +
            `You will receive private notifications for friend requests and other owner-only features.`,
          ephemeral: true,
        });
        logger.info({ msg: "Bot ownership claimed" });
      } else {
        await interaction.reply({
          content: `❌ **Claim failed:** ${result.error}\n\nMake sure you're using the correct code and it hasn't expired.`,
          ephemeral: true,
        });
      }
      break;
    }

    case "cancel": {
      const channelId = interaction.channelId;

      // Cancel the channel queue (current + pending)
      // Note: Stream cleanup happens automatically in executeInjectInternal when it detects cancellation
      const queueCancelled = cancelChannelQueue(channelId);

      // Also try to cancel the injection via WOPR
      let woprCancelled = false;
      if (ctx.cancelInject) {
        woprCancelled = ctx.cancelInject(sessionKey);
      }

      // Note: Streams are now keyed by message ID, not session. The stream for the cancelled
      // message will be finalized by executeInjectInternal when it detects cancelToken.cancelled

      const pendingCount = getQueuedCount(channelId);
      if (queueCancelled || woprCancelled) {
        let msg = "⏹️ **Cancelled**\n\nThe current response has been stopped.";
        if (pendingCount > 0) {
          msg += `\n\n_${pendingCount} queued message(s) also cleared._`;
        }
        await interaction.reply({
          content: msg,
          ephemeral: false,
        });
      } else {
        await interaction.reply({
          content: "ℹ️ **Nothing to cancel**\n\nNo response is currently in progress.",
          ephemeral: true,
        });
      }
      break;
    }

    case "model": {
      const modelChoice = interaction.options.getString("model", true);

      // Resolve input against all provider models
      const resolved = resolveModel(modelChoice);
      if (!resolved) {
        const models = getAllModels();
        const list =
          models.length > 0
            ? models.map((m) => `\`${m.id}\` — ${m.name}`).join("\n")
            : "_No models discovered yet. Try again in a moment._";
        await interaction.reply({
          content: `❌ Unknown model: \`${modelChoice}\`\n\n**Available models:**\n${list}`,
          ephemeral: true,
        });
        break;
      }

      state.model = resolved.id;

      // Update the session's provider model
      try {
        if (ctx.setSessionProvider) {
          await ctx.setSessionProvider(sessionKey, resolved.provider, { model: resolved.id });
        } else {
          const { exec } = await import("node:child_process");
          const { promisify } = await import("node:util");
          const execAsync = promisify(exec);
          await execAsync(
            `node /app/dist/cli.js session set-provider ${sessionKey} ${resolved.provider} --model ${resolved.id}`,
          );
        }

        await interaction.reply({
          content: `🔄 **Model switched to:** ${resolved.name} (\`${resolved.id}\`)\n\nAll future responses will use this model.`,
          ephemeral: false,
        });
      } catch (e) {
        logger.error({ msg: "Failed to switch model", error: String(e) });
        await interaction.reply({
          content: `❌ Failed to switch model: ${e}`,
          ephemeral: true,
        });
      }
      break;
    }

    default: {
      // Check if this is a dynamically registered command from another plugin
      const registeredCmd = getRegisteredCommand(commandName);
      if (registeredCmd) {
        // Build args from interaction options, resolving Discord mentions to usernames
        const args: string[] = [];
        for (const option of interaction.options.data) {
          if (option.value !== undefined) {
            let value = String(option.value);
            // Check for Discord user mention format <@USER_ID> or <@!USER_ID> and resolve to username
            const mentionMatch = value.match(/^<@!?(\d+)>$/);
            if (mentionMatch && client) {
              try {
                const user = await client.users.fetch(mentionMatch[1]);
                if (user) {
                  value = user.username; // Use the actual username
                  logger.info({ msg: "Resolved mention to username", original: String(option.value), resolved: value });
                }
              } catch (err) {
                logger.warn({ msg: "Failed to resolve mention to username", value, error: String(err) });
                // Fall back to stripping mention format manually
                value = value.replace(/^<@!?/, "").replace(/>$/, "");
              }
            }
            args.push(value);
          }
        }

        // Create a reply function that handles the interaction
        let replied = false;
        const reply = async (msg: string) => {
          if (!replied) {
            await interaction.reply({ content: msg, ephemeral: false });
            replied = true;
          } else {
            await interaction.followUp({ content: msg, ephemeral: false });
          }
        };

        try {
          // Execute the channel command handler
          await registeredCmd.handler({
            channel: interaction.channelId,
            channelType: "discord",
            sender: interaction.user.username,
            args,
            reply,
            getBotUsername: () => client?.user?.username || "unknown",
          });

          // If handler didn't reply, send a default acknowledgment
          if (!replied) {
            await interaction.reply({ content: "✓ Command executed", ephemeral: true });
          }
        } catch (err) {
          logger.error({ msg: "Channel command handler error", command: commandName, error: String(err) });
          if (!replied) {
            await interaction.reply({ content: `Error: ${err}`, ephemeral: true });
          }
        }
      } else {
        logger.warn({ msg: "Unknown slash command", command: commandName });
      }
      break;
    }
  }
}

async function getSessionInfo(_sessionKey: string): Promise<string> {
  // This would integrate with WOPR session API
  return "💾 Session active";
}

async function handleWoprMessage(interaction: ChatInputCommandInteraction, messageContent: string) {
  if (!ctx || !client) return;

  const sessionKey = getSessionKeyFromInteraction(interaction);
  const state = getSessionState(sessionKey);
  state.messageCount++;

  // Defer reply since AI response takes time
  await interaction.deferReply();

  // Add thinking level context
  let fullMessage = messageContent;
  if (state.thinkingLevel !== "medium") {
    fullMessage = `[Thinking level: ${state.thinkingLevel}] ${messageContent}`;
  }

  try {
    const response = await ctx.inject(sessionKey, fullMessage, {
      from: interaction.user.username,
      channel: { type: "discord", id: interaction.channelId, name: "slash-command" },
      // Skip conversation_history and channel_history - Discord handles its own context
      contextProviders: ["session_system", "skills", "bootstrap_files"],
    });

    // Final edit with complete response
    const usage = state.usageMode !== "off" ? `\n\n_Usage: ${state.messageCount} messages_` : "";
    await interaction.editReply((response + usage).slice(0, DISCORD_LIMIT));
  } catch (error: any) {
    logger.error({ msg: "Slash command inject failed", error: String(error) });
    await interaction.editReply("❌ Error processing your request.");
  }
}

// Handle @mention messages
async function handleMessage(message: Message) {
  if (!client || !ctx) return;
  if (!client.user) return;

  // Ignore our own messages
  if (message.author.id === client.user.id) return;

  // Check for registered message parsers FIRST - they need to see ALL messages
  // including slash command responses (which contain FRIEND_REQUEST/ACCEPT)
  if (await handleRegisteredParsers(message)) {
    return; // Parser handled
  }

  // Ignore slash command interactions (for everything else)
  if (message.interaction) return;

  const isDM = message.channel.type === 1;

  // Handle owner pairing via DM when no owner is configured
  if (isDM && !hasOwner(ctx)) {
    const code = createPairingRequest(message.author.id, message.author.username);
    const pairingMessage = buildPairingMessage(code);
    await message.reply(pairingMessage);
    logger.info({ msg: "Pairing code generated", userId: message.author.id, username: message.author.username });
    return;
  }

  // Check for registered channel commands (e.g., /friend from P2P plugin)
  if (await handleRegisteredCommand(message)) {
    return; // Command handled
  }

  // Note: Message parsers already checked above (before interaction check)
  // to ensure FRIEND_REQUEST/ACCEPT messages from slash command responses are processed

  const channelId = message.channel.id;
  const isDirectlyMentioned = message.mentions.users.has(client.user.id);
  const isBot = message.author.bot;

  const authorDisplayName =
    message.member?.displayName || (message.author as any).displayName || message.author.username;

  // Resolve mentions in message content (@user -> @Username, #channel -> #channel-name)
  const resolvedContent = resolveMentions(message);

  // Log ALL messages to WOPR conversation context
  const sessionKey = getSessionKey(message.channel as TextChannel | ThreadChannel | DMChannel);
  try {
    ctx.logMessage(sessionKey, resolvedContent, {
      from: authorDisplayName,
      channel: { type: "discord", id: channelId, name: (message.channel as any).name },
    });
  } catch (_e) {}

  // Add ALL messages to our buffer (for context building)
  addToBuffer(channelId, {
    from: authorDisplayName,
    content: resolvedContent,
    timestamp: Date.now(),
    isBot,
    isMention: isDirectlyMentioned,
    originalMessage: message,
  });

  // === BOT MESSAGE HANDLING ===
  if (isBot) {
    if (!isDirectlyMentioned) return; // Bots must @mention us

    // Prepare message content (use resolved content with readable mentions)
    let messageContent = resolvedContent;
    // Remove bot's own @mention from the message
    const botDisplayName = message.guild?.members.me?.displayName || client.user?.username || "WOPR";
    messageContent = messageContent.replace(new RegExp(`@${botDisplayName}\\s*`, "gi"), "").trim();

    if (!messageContent) return; // Ignore empty bot mentions

    // Get accumulated context from buffer
    const bufferContext = getBufferContext(channelId);
    const fullMessage = bufferContext + messageContent;

    // Queue the bot response (will fire after cooldown + human typing check)
    queueInject(channelId, {
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

  // Human @mention = immediate priority
  if (isDirectlyMentioned || isDM) {
    // Get accumulated context from buffer
    const bufferContext = getBufferContext(channelId);

    // Use resolved content with readable mentions
    let messageContent = resolvedContent;
    if (client.user && isDirectlyMentioned) {
      // Remove bot's own @mention from the message
      const botDisplayName = message.guild?.members.me?.displayName || client.user?.username || "WOPR";
      messageContent = messageContent.replace(new RegExp(`@${botDisplayName}\\s*`, "gi"), "").trim();
    }

    // Handle attachments - save to disk and append paths
    if (message.attachments.size > 0) {
      const attachmentPaths = await saveAttachments(message);
      if (attachmentPaths.length > 0) {
        const attachmentInfo = attachmentPaths.map((p) => `[Attachment: ${p}]`).join("\n");
        messageContent = messageContent ? `${messageContent}\n\n${attachmentInfo}` : attachmentInfo;
        logger.info({ msg: "Attachments appended to message", count: attachmentPaths.length, channelId });
      }
    }

    // If message was just a mention with no text (and no attachments), use a default prompt
    if (!messageContent) {
      messageContent = "Hello! (You mentioned me without a message)";
      logger.info({ msg: "Human @mention - empty message, using default", channelId });
    }

    // Prepend buffer context
    const fullMessage = bufferContext + messageContent;

    logger.info({ msg: "Human @mention - queueing (priority)", channelId, hasContext: bufferContext.length > 0 });

    // Queue with human priority (goes directly to chain, clears pending bot messages)
    queueInject(channelId, {
      sessionKey,
      messageContent: fullMessage,
      authorDisplayName,
      replyToMessage: message,
      isBot: false,
      queuedAt: Date.now(),
    });
    return;
  }

  // Human message (no mention) = just logged to buffer above, nothing else to do
}

// Handle typing events - pause bot-to-bot when humans are typing
function handleTypingStart(typing: any) {
  if (!client) return;

  // Ignore bot typing
  if (typing.user.bot) return;

  const channelId = typing.channel.id;
  setHumanTyping(channelId);
}

// Core inject execution - called from promise chain with cancellation support
async function executeInjectInternal(item: QueuedInject, cancelToken: { cancelled: boolean }) {
  if (!ctx) return;

  const { sessionKey, messageContent: rawContent, authorDisplayName, replyToMessage } = item;
  const channelId = replyToMessage.channel.id;
  // Use message ID as stream key to prevent race conditions between concurrent messages
  const streamKey = replyToMessage.id;

  // Check cancellation before starting
  if (cancelToken.cancelled) {
    logger.info({ msg: "executeInjectInternal - cancelled before start", sessionKey, streamKey });
    await setMessageReaction(replyToMessage, REACTION_CANCELLED);
    return;
  }

  // Transition from queued (🕐) to active (⚡)
  await setMessageReaction(replyToMessage, REACTION_ACTIVE);

  // Start typing indicator
  const channel = replyToMessage.channel as TextChannel | ThreadChannel | DMChannel;
  await startTyping(channel);

  const state = getSessionState(sessionKey);
  state.messageCount++;

  // NOTE: No need to clean up existing stream - each message has unique streamKey
  // This prevents the race condition where concurrent messages would clobber each other's streams

  // Create new stream for THIS specific message
  const stream = new DiscordMessageStream(
    replyToMessage.channel as TextChannel | ThreadChannel | DMChannel,
    replyToMessage,
  );
  streams.set(streamKey, stream);

  // Add thinking level context
  let messageContent = rawContent;
  if (state.thinkingLevel !== "medium") {
    messageContent = `[Thinking level: ${state.thinkingLevel}] ${messageContent}`;
  }

  try {
    logger.info({ msg: "executeInjectInternal - inject starting", sessionKey, streamKey, from: authorDisplayName });
    await ctx.inject(sessionKey, messageContent, {
      from: authorDisplayName,
      channel: { type: "discord", id: channelId, name: (replyToMessage.channel as any).name },
      // Skip conversation_history and channel_history - Discord handles its own context buffer
      contextProviders: ["session_system", "skills", "bootstrap_files"],
      onStream: (msg: StreamMessage) => {
        // Check cancellation during streaming
        if (cancelToken.cancelled) return;
        // Tick typing indicator on each chunk
        tickTyping(channelId);
        // Use streamKey (message ID) not sessionKey to route chunks to correct stream
        handleChunk(msg, streamKey).catch((e) => logger.error({ msg: "Chunk error", streamKey, error: String(e) }));
      },
    });
    logger.info({ msg: "executeInjectInternal - inject complete", sessionKey, streamKey });

    // Finalize the stream
    await stream.finalize();
    streams.delete(streamKey);

    // Stop typing indicator (pass channel to force-clear Discord's typing state)
    stopTyping(channelId, channel);

    // Transition to done (✅)
    await setMessageReaction(replyToMessage, REACTION_DONE);

    // Clear buffer after successful response
    clearBuffer(channelId);
  } catch (error: any) {
    const errorStr = String(error);
    const isCancelled =
      cancelToken.cancelled ||
      errorStr.toLowerCase().includes("cancelled") ||
      errorStr.toLowerCase().includes("canceled");

    // Stop typing indicator (pass channel to force-clear Discord's typing state)
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

// Register slash commands
async function registerSlashCommands(token: string, clientId: string, guildId?: string) {
  const rest = new REST({ version: "10" }).setToken(token);

  try {
    logger.info("Registering slash commands...");

    if (guildId) {
      // Register to specific guild (faster for development)
      await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: commands.map((cmd) => cmd.toJSON()) });
      logger.info(`Registered ${commands.length} commands to guild ${guildId}`);
    } else {
      // Register globally (can take up to 1 hour to propagate)
      await rest.put(Routes.applicationCommands(clientId), { body: commands.map((cmd) => cmd.toJSON()) });
      logger.info(`Registered ${commands.length} global commands`);
    }
  } catch (error) {
    logger.error({ msg: "Failed to register commands", error: String(error) });
  }
}

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

          // Call the daemon API to claim ownership
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
              console.log(`✓ Discord ownership claimed!`);
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

    // Register as a channel provider so other plugins can add commands/parsers
    if (ctx.registerChannelProvider) {
      ctx.registerChannelProvider(discordChannelProvider);
      logger.info("Registered Discord channel provider");
    }

    // Register the Discord extension so other plugins can send notifications
    if (ctx.registerExtension) {
      ctx.registerExtension("discord", discordExtension);
      logger.info("Registered Discord extension");
    }

    // Subscribe to session events to deliver ALL session activity to Discord
    // This includes: crons, sessions_send, P2P injects, CLI injects, etc.
    // Uses the same streaming collapser as normal Discord messages via the event bus.
    logger.info({ msg: "Checking ctx.events availability", hasEvents: !!ctx.events });
    if (ctx.events) {
      // On inject start: send notification to Discord and create a stream for the response
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

        // Format the source label
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
          // Send the notification message directly to get the Message object back
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

          // Clean up any stale stream for this session
          const existing = eventBusStreams.get(payload.session);
          if (existing) {
            await existing.finalize().catch(() => {});
            eventBusStreams.delete(payload.session);
          }

          // Create a streaming collapser that replies to the notification message
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

      // On inject complete: safety net for stream finalization
      // Primary finalization happens on the "complete" stream event (immediate).
      // This handler catches edge cases where the stream event was missed.
      ctx.events.on("session:afterInject", async (payload: SessionResponseEvent) => {
        if (!payload.session.startsWith("discord:")) return;
        if ((payload as any).channel?.type === "discord") return;

        const stream = eventBusStreams.get(payload.session);
        if (stream) {
          // Core doesn't emit "stream" events to plugins, so the event bus stream
          // created in beforeInject never receives content via ctx.on("stream").
          // Deliver the full response here instead.
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
          // No stream was created (e.g., channel not found) — fall back to bulk send
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

    // Subscribe to stream events on the plugin event bus
    // This routes streaming tokens from ALL injects (including sessions_send, cron, CLI)
    // through the same Discord collapser used for normal messages
    if (ctx.on) {
      ctx.on("stream", (event: SessionStreamEvent) => {
        const stream = eventBusStreams.get(event.session);
        if (!stream) return;

        const msg = event.message;

        // Handle completion/error — finalize immediately (don't wait for afterInject
        // which is delayed by other handlers like semantic memory embeddings)
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

        // Handle auto-compaction notifications
        if (msg.type === "system" && msg.subtype === "compact_boundary") {
          const metadata = msg.metadata as { pre_tokens?: number; trigger?: string } | undefined;
          if (metadata?.trigger === "auto") {
            let notification = "📦 **Auto-Compaction**\n";
            notification += metadata.pre_tokens
              ? `Context compressed from ~${Math.round(metadata.pre_tokens / 1000)}k tokens`
              : "Context has been automatically compressed";
            stream.append(`\n\n${notification}\n\n`);
          }
          return;
        }

        // Extract text content
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

    await refreshIdentity(ctx);
    let config = ctx.getConfig<{ token?: string; guildId?: string; clientId?: string }>();
    // Fall back to main config for Discord settings
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
        GatewayIntentBits.GuildMessageTyping, // For human typing detection
      ],
      partials: [Partials.Channel, Partials.Message], // Required for DMs
    });

    // Wire client into extracted modules
    setReactionClient(client);
    setChannelProviderClient(client);

    client.on(Events.MessageCreate, (m) =>
      handleMessage(m).catch((e) => logger.error({ msg: "Message handling failed", error: String(e) })),
    );
    client.on(Events.InteractionCreate, async (interaction) => {
      // Handle autocomplete for /model command
      if (interaction.isAutocomplete()) {
        if (interaction.commandName === "model") {
          const focused = interaction.options.getFocused().toLowerCase();
          const models = getAllModels();
          const filtered = models
            .filter((m) => m.id.includes(focused) || m.name.toLowerCase().includes(focused) || focused === "")
            .slice(0, 25); // Discord max 25 choices
          await interaction.respond(filtered.map((m) => ({ name: `${m.name} (${m.id})`, value: m.id })));
        }
        return;
      }

      // Handle slash commands
      if (interaction.isChatInputCommand()) {
        await handleSlashCommand(interaction).catch((e) => logger.error({ msg: "Command error", error: String(e) }));
        return;
      }

      // Handle button interactions (friend request accept/deny)
      if (interaction.isButton() && isFriendRequestButton(interaction.customId)) {
        // Get P2P extension for friend request handling
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
          // onAccept handler - returns the FRIEND_ACCEPT message to post
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
          // onDeny handler - `pending` is fetched inside handleFriendButtonInteraction before removal
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

    // Typing detection - pause bot-to-bot when humans are typing
    client.on(Events.TypingStart, (typing) => handleTypingStart(typing));

    // Start the queue processor for bot-to-bot responses
    startQueueProcessor();

    // Start cleanup interval for expired pairings and button requests
    startCleanupInterval();

    client.on(Events.ClientReady, async () => {
      logger.info({ tag: client?.user?.tag });

      // Register slash commands
      if (config.clientId && config.token) {
        await registerSlashCommands(config.token, config.clientId, config.guildId);
      } else {
        logger.warn("No clientId configured - slash commands not registered");
      }

      // Subscribe to session:create to auto-create Discord channels
      // Pattern: discord:{guild}:#{channel} -> create channel if it doesn't exist
      if (ctx?.events) {
        ctx.events.on("session:create", async (payload: SessionCreateEvent) => {
          const sessionName = payload.session;

          // Only handle Discord session patterns
          const match = sessionName.match(/^discord:([^:]+):#(.+)$/);
          if (!match) return;

          const [, guildName, channelName] = match;
          logger.info({ msg: "Session create for Discord pattern", sessionName, guildName, channelName });

          // Find the guild
          const guild = client?.guilds.cache.find(
            (g) =>
              g.name.toLowerCase().replace(/\s+/g, "-") === guildName.toLowerCase() ||
              g.name.toLowerCase() === guildName.toLowerCase(),
          );

          if (!guild) {
            logger.warn({ msg: "Guild not found for session", sessionName, guildName });
            return;
          }

          // Check if channel already exists
          const existingChannel = guild.channels.cache.find(
            (c) => c.name.toLowerCase() === channelName.toLowerCase() && c.type === ChannelType.GuildText,
          );

          if (existingChannel) {
            logger.debug({ msg: "Channel already exists", channelName, channelId: existingChannel.id });
            return;
          }

          // Find WOPR category (or create one)
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

          // Create the channel under WOPR category
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
    stopQueueProcessor();
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
