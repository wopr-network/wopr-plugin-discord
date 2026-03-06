/**
 * Slash Command Handler
 *
 * Handles all Discord slash command interactions including model resolution,
 * session management, and dynamically registered plugin commands.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AutocompleteInteraction, ChatInputCommandInteraction, Client } from "discord.js";
import { REST, Routes, SlashCommandBuilder } from "discord.js";
import type { ChannelQueueManager } from "./channel-queue.js";
import { getSessionKeyFromInteraction } from "./discord-utils.js";
import { logger } from "./logger.js";
import { DISCORD_LIMIT } from "./message-streaming.js";
import type { ChannelCommand, StreamMessage, WOPRPluginContext } from "./types.js";
import {
  autocompleteFocusedSchema,
  modelInputSchema,
  pairingCodeSchema,
  sanitize,
  sessionNameSchema,
  thinkLevelSchema,
  usageModeSchema,
  validateInput,
  woprMessageSchema,
} from "./validation.js";

const execFileAsync = promisify(execFile);

// ============================================================================
// Slash command definitions
// ============================================================================

export const commands = [
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

// ============================================================================
// Register slash commands with Discord API
// ============================================================================

export async function registerSlashCommands(token: string, clientId: string, guildId?: string): Promise<void> {
  const rest = new REST({ version: "10" }).setToken(token);

  try {
    logger.info("Registering slash commands...");

    if (guildId) {
      await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: commands.map((cmd) => cmd.toJSON()) });
      logger.info(`Registered ${commands.length} commands to guild ${guildId}`);
    } else {
      await rest.put(Routes.applicationCommands(clientId), { body: commands.map((cmd) => cmd.toJSON()) });
      logger.info(`Registered ${commands.length} global commands`);
    }
  } catch (error) {
    logger.error({ msg: "Failed to register commands", error: String(error) });
  }
}

// ============================================================================
// Model resolution
// ============================================================================

interface ResolvedModel {
  provider: string;
  id: string;
  name: string;
}

function getAllModels(ctx: WOPRPluginContext): ResolvedModel[] {
  const results: ResolvedModel[] = [];
  const providerIds = ["anthropic", "openai", "kimi", "opencode", "codex"];
  for (const pid of providerIds) {
    const provider = (ctx as { getProvider?: (id: string) => { supportedModels?: string[] } | null })?.getProvider?.(
      pid,
    );
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

function modelIdToDisplayName(id: string): string {
  const claude = id.match(/^claude-(\w+)-(\d[\d.-]*)(?:-\d{8})?$/);
  if (claude) {
    const tier = claude[1].charAt(0).toUpperCase() + claude[1].slice(1);
    const ver = claude[2].replace(/-/g, ".");
    return `${tier} ${ver}`;
  }
  const gpt = id.match(/^gpt-(.+)$/i);
  if (gpt) return `GPT ${gpt[1]}`;
  const o = id.match(/^o(\d.*)$/);
  if (o) return `o${o[1]}`;
  return id;
}

function resolveModel(ctx: WOPRPluginContext, input: string): ResolvedModel | null {
  const models = getAllModels(ctx);
  if (models.length === 0) return null;

  const q = input.toLowerCase().trim();

  const exact = models.find((m) => m.id === q);
  if (exact) return exact;

  const partial = models.find((m) => m.id.includes(q));
  if (partial) return partial;

  const byName = models.find((m) => m.name.toLowerCase().includes(q));
  if (byName) return byName;

  return null;
}

// ============================================================================
// Slash Command Handler
// ============================================================================

export class SlashCommandHandler {
  constructor(
    private getClient: () => Client | null,
    private ctx: WOPRPluginContext,
    private queueManager: ChannelQueueManager,
    private getRegisteredCommand: (name: string) => ChannelCommand | undefined,
    private claimOwnership: (
      code: string,
      sourceId?: string,
      claimingUserId?: string,
    ) => Promise<{ success: boolean; userId?: string; username?: string; error?: string }>,
    private hasOwner: () => boolean,
  ) {}

  async handleAutocomplete(interaction: AutocompleteInteraction): Promise<void> {
    if (interaction.commandName === "model") {
      const rawFocused = interaction.options.getFocused();
      const focusedResult = validateInput(autocompleteFocusedSchema, rawFocused);
      let focused = "";
      if (focusedResult.success) {
        focused = focusedResult.data.toLowerCase();
      }
      const models = getAllModels(this.ctx);
      const filtered = models
        .filter((m) => m.id.includes(focused) || m.name.toLowerCase().includes(focused) || focused === "")
        .slice(0, 25);
      await interaction.respond(filtered.map((m) => ({ name: `${m.name} (${m.id})`, value: m.id })));
    }
  }

  async handle(interaction: ChatInputCommandInteraction): Promise<void> {
    const client = this.getClient();
    if (!client) return;

    const { commandName } = interaction;
    const sessionKey = getSessionKeyFromInteraction(interaction);
    const state = this.queueManager.getSessionState(sessionKey);

    logger.info({ msg: "Slash command received", command: commandName, user: interaction.user.tag });

    switch (commandName) {
      case "status": {
        const sessionInfo = await this.getSessionInfo(sessionKey);
        await interaction.reply({
          content:
            `\u{1f4ca} **Session Status**\n\n` +
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
        this.queueManager.deleteSessionState(sessionKey);
        await interaction.reply({
          content: "\u{1f504} **Session Reset**\n\nStarting fresh! Your conversation history has been cleared.",
          ephemeral: false,
        });
        break;
      }

      case "compact": {
        await interaction.reply({
          content: "\u{1f4e6} **Compacting Session**\n\nTriggering context compaction...",
          ephemeral: false,
        });

        try {
          let compactMetadata: { pre_tokens?: number; trigger?: string } | undefined;

          const result = await this.ctx.inject(sessionKey, "/compact", {
            silent: true,
            onStream: (msg: StreamMessage) => {
              if (msg.type === "system" && msg.subtype === "compact_boundary" && msg.metadata) {
                compactMetadata = msg.metadata as { pre_tokens?: number; trigger?: string };
              }
            },
          });

          let response = "\u{1f4e6} **Session Compacted**\n\n";
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
          await interaction.editReply("\u274c Failed to compact session.");
        }
        break;
      }

      case "think": {
        const rawLevel = interaction.options.getString("level", true);
        const levelResult = validateInput(thinkLevelSchema, rawLevel);
        if (!levelResult.success) {
          await interaction.reply({
            content: `\u274c Invalid thinking level: ${levelResult.error}`,
            ephemeral: true,
          });
          break;
        }
        const level = levelResult.data;
        state.thinkingLevel = level;
        const levelEmoji =
          {
            off: "\u{1f6d1}",
            minimal: "\u{1f4a1}",
            low: "\u{1f914}",
            medium: "\u{1f9e0}",
            high: "\u{1f52c}",
            xhigh: "\u{1f52e}",
          }[level] || "\u{1f9e0}";
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
          content: enabled ? "\u{1f50a} **Verbose mode enabled**" : "\u{1f507} **Verbose mode disabled**",
          ephemeral: true,
        });
        break;
      }

      case "usage": {
        const rawMode = interaction.options.getString("mode", true);
        const modeResult = validateInput(usageModeSchema, rawMode);
        if (!modeResult.success) {
          await interaction.reply({
            content: `\u274c Invalid usage mode: ${modeResult.error}`,
            ephemeral: true,
          });
          break;
        }
        const mode = modeResult.data;
        state.usageMode = mode;
        await interaction.reply({
          content: `\u{1f4c8} **Usage tracking set to:** ${mode}`,
          ephemeral: true,
        });
        break;
      }

      case "session": {
        const rawName = sanitize(interaction.options.getString("name", true));
        const nameResult = validateInput(sessionNameSchema, rawName);
        if (!nameResult.success) {
          await interaction.reply({
            content: `\u274c Invalid session name: ${nameResult.error}\n\nSession names may only contain letters, numbers, hyphens, and underscores.`,
            ephemeral: true,
          });
          break;
        }
        const name = nameResult.data;
        const baseKey = getSessionKeyFromInteraction(interaction);
        const newSessionKey = `${baseKey}/${name}`;
        await interaction.reply({
          content: `\u{1f4ac} **Switched to session:** ${newSessionKey}\n\nNote: Each session maintains separate context.`,
          ephemeral: false,
        });
        break;
      }

      case "wopr": {
        const rawMessage = sanitize(interaction.options.getString("message", true));
        const messageResult = validateInput(woprMessageSchema, rawMessage);
        if (!messageResult.success) {
          await interaction.reply({
            content: `\u274c ${messageResult.error}`,
            ephemeral: true,
          });
          break;
        }
        await this.handleWoprMessage(interaction, messageResult.data);
        break;
      }

      case "help": {
        await interaction.reply({
          content:
            `**\u{1f916} WOPR Discord Commands**\n\n` +
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
        if (interaction.channel?.type !== 1) {
          await interaction.reply({
            content: "\u274c The /claim command only works in DMs. Please DM me to claim ownership.",
            ephemeral: true,
          });
          break;
        }

        if (this.hasOwner()) {
          await interaction.reply({
            content: "\u274c This bot already has an owner configured.",
            ephemeral: true,
          });
          break;
        }

        const rawCode = sanitize(interaction.options.getString("code", true));
        const codeResult = validateInput(pairingCodeSchema, rawCode);
        if (!codeResult.success) {
          await interaction.reply({
            content: `\u274c Invalid pairing code: ${codeResult.error}`,
            ephemeral: true,
          });
          break;
        }
        const result = await this.claimOwnership(codeResult.data, interaction.user.id, interaction.user.id);

        if (result.success) {
          await interaction.reply({
            content: `\u2705 **Ownership claimed!**\n\n` + `You now have access to owner-only features.`,
            ephemeral: true,
          });
          logger.info({ msg: "Bot ownership claimed" });
        } else {
          await interaction.reply({
            content: `\u274c **Claim failed:** ${result.error}\n\nMake sure you're using the correct code and it hasn't expired.`,
            ephemeral: true,
          });
        }
        break;
      }

      case "cancel": {
        const channelId = interaction.channelId;
        const queueCancelled = this.queueManager.cancelChannelQueue(channelId);

        let woprCancelled = false;
        if (this.ctx.cancelInject) {
          woprCancelled = this.ctx.cancelInject(sessionKey);
        }

        const pendingCount = this.queueManager.getQueuedCount(channelId);
        if (queueCancelled || woprCancelled) {
          let msg = "\u23f9\ufe0f **Cancelled**\n\nThe current response has been stopped.";
          if (pendingCount > 0) {
            msg += `\n\n_${pendingCount} queued message(s) also cleared._`;
          }
          await interaction.reply({
            content: msg,
            ephemeral: false,
          });
        } else {
          await interaction.reply({
            content: "\u2139\ufe0f **Nothing to cancel**\n\nNo response is currently in progress.",
            ephemeral: true,
          });
        }
        break;
      }

      case "model": {
        const rawModel = sanitize(interaction.options.getString("model", true));
        const modelResult = validateInput(modelInputSchema, rawModel);
        if (!modelResult.success) {
          await interaction.reply({
            content: `\u274c Invalid model name: ${modelResult.error}`,
            ephemeral: true,
          });
          break;
        }
        const modelChoice = modelResult.data;

        const resolved = resolveModel(this.ctx, modelChoice);
        if (!resolved) {
          const models = getAllModels(this.ctx);
          const list =
            models.length > 0
              ? models.map((m) => `\`${m.id}\` \u2014 ${m.name}`).join("\n")
              : "_No models discovered yet. Try again in a moment._";
          await interaction.reply({
            content: `\u274c Unknown model: \`${modelChoice}\`\n\n**Available models:**\n${list}`,
            ephemeral: true,
          });
          break;
        }

        state.model = resolved.id;

        try {
          const ctxAny = this.ctx as unknown as Record<string, unknown>;
          if (typeof ctxAny.setSessionProvider === "function") {
            await (
              ctxAny.setSessionProvider as (
                session: string,
                provider: string,
                opts?: { model?: string },
              ) => Promise<void>
            )(sessionKey, resolved.provider, { model: resolved.id });
          } else {
            // Security: use execFile instead of exec to prevent shell injection
            await execFileAsync("node", [
              "/app/dist/cli.js",
              "session",
              "set-provider",
              sessionKey,
              resolved.provider,
              "--model",
              resolved.id,
            ]);
          }

          await interaction.reply({
            content: `\u{1f504} **Model switched to:** ${resolved.name} (\`${resolved.id}\`)\n\nAll future responses will use this model.`,
            ephemeral: false,
          });
        } catch (e) {
          logger.error({ msg: "Failed to switch model", error: String(e) });
          await interaction.reply({
            content: "\u274c Failed to switch model. Please try again later.",
            ephemeral: true,
          });
        }
        break;
      }

      default: {
        const registeredCmd = this.getRegisteredCommand(commandName);
        if (registeredCmd) {
          const args: string[] = [];
          for (const option of interaction.options.data) {
            if (option.value !== undefined) {
              let value = sanitize(String(option.value));
              const mentionMatch = value.match(/^<@!?(\d+)>$/);
              if (mentionMatch && client) {
                try {
                  const user = await client.users.fetch(mentionMatch[1]);
                  if (user) {
                    value = user.username;
                    logger.info({
                      msg: "Resolved mention to username",
                      original: String(option.value),
                      resolved: value,
                    });
                  }
                } catch (err) {
                  logger.warn({ msg: "Failed to resolve mention to username", value, error: String(err) });
                  value = value.replace(/^<@!?/, "").replace(/>$/, "");
                }
              }
              args.push(value);
            }
          }

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
            await registeredCmd.handler({
              channel: interaction.channelId,
              channelType: "discord",
              sender: interaction.user.username,
              args,
              reply,
              getBotUsername: () => client?.user?.username || "unknown",
            });

            if (!replied) {
              await interaction.reply({ content: "\u2713 Command executed", ephemeral: true });
            }
          } catch (err) {
            logger.error({ msg: "Channel command handler error", command: commandName, error: String(err) });
            if (!replied) {
              await interaction.reply({
                content: "An internal error occurred. Please try again later.",
                ephemeral: true,
              });
            }
          }
        } else {
          logger.warn({ msg: "Unknown slash command", command: commandName });
        }
        break;
      }
    }
  }

  private async getSessionInfo(_sessionKey: string): Promise<string> {
    return "\u{1f4be} Session active";
  }

  private async handleWoprMessage(interaction: ChatInputCommandInteraction, messageContent: string): Promise<void> {
    const sessionKey = getSessionKeyFromInteraction(interaction);
    const state = this.queueManager.getSessionState(sessionKey);
    state.messageCount++;

    await interaction.deferReply();

    let fullMessage = messageContent;
    if (state.thinkingLevel !== "medium") {
      fullMessage = `[Thinking level: ${state.thinkingLevel}] ${messageContent}`;
    }

    try {
      const response = await this.ctx.inject(sessionKey, fullMessage, {
        from: interaction.user.username,
        channel: { type: "discord", id: interaction.channelId, name: "slash-command" },
        contextProviders: ["session_system", "skills", "bootstrap_files"],
      });

      const usage = state.usageMode !== "off" ? `\n\n_Usage: ${state.messageCount} messages_` : "";
      await interaction.editReply((response + usage).slice(0, DISCORD_LIMIT));
    } catch (error: unknown) {
      logger.error({ msg: "Slash command inject failed", error: String(error) });
      await interaction.editReply("\u274c Error processing your request.");
    }
  }
}
