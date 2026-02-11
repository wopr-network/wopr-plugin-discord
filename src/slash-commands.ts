import type { AutocompleteInteraction, ChatInputCommandInteraction, Client } from "discord.js";
import type { ChannelQueueManager } from "./channel-queue.js";
import { getSessionKeyFromInteraction } from "./discord-utils.js";
import { logger } from "./logger.js";
import { DISCORD_LIMIT } from "./message-streaming.js";
import type { ChannelCommand, StreamMessage, WOPRPluginContext } from "./types.js";

interface ResolvedModel {
  provider: string;
  id: string;
  name: string;
}

export class SlashCommandHandler {
  constructor(
    private getClient: () => Client | null,
    private ctx: WOPRPluginContext,
    private queueManager: ChannelQueueManager,
    private getRegisteredCommands: () => Map<string, ChannelCommand>,
  ) {}

  // Get all available models from all registered providers
  private getAllModels(): ResolvedModel[] {
    const results: ResolvedModel[] = [];
    const providerIds = ["anthropic", "openai", "kimi", "opencode", "codex"];
    for (const pid of providerIds) {
      const provider = (this.ctx as any)?.getProvider?.(pid);
      if (!provider?.supportedModels) continue;
      for (const modelId of provider.supportedModels) {
        results.push({
          provider: pid,
          id: modelId,
          name: this.modelIdToDisplayName(modelId),
        });
      }
    }
    return results;
  }

  // Convert a model ID to a human-readable display name
  private modelIdToDisplayName(id: string): string {
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

  // Resolve user input to a model
  private resolveModel(input: string): ResolvedModel | null {
    const models = this.getAllModels();
    if (models.length === 0) return null;

    const q = input.toLowerCase().trim();

    // Exact ID match (case-insensitive)
    const exact = models.find((m) => m.id.toLowerCase() === q);
    if (exact) return exact;

    // Substring match on model ID (case-insensitive)
    const partial = models.find((m) => m.id.toLowerCase().includes(q));
    if (partial) return partial;

    // Substring match on display name
    const byName = models.find((m) => m.name.toLowerCase().includes(q));
    if (byName) return byName;

    return null;
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
            `\u{1F4CA} **Session Status**\n\n` +
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
          content: "\u{1F504} **Session Reset**\n\nStarting fresh! Your conversation history has been cleared.",
          ephemeral: false,
        });
        break;
      }

      case "compact": {
        await interaction.reply({
          content: "\u{1F4E6} **Compacting Session**\n\nTriggering context compaction...",
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

          let response = "\u{1F4E6} **Session Compacted**\n\n";
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
          await interaction.editReply("\u274C Failed to compact session.");
        }
        break;
      }

      case "think": {
        const level = interaction.options.getString("level", true);
        state.thinkingLevel = level;
        const levelEmoji =
          (
            {
              off: "\u{1F6D1}",
              minimal: "\u{1F4A1}",
              low: "\u{1F914}",
              medium: "\u{1F9E0}",
              high: "\u{1F52C}",
              xhigh: "\u{1F52E}",
            } as Record<string, string>
          )[level] || "\u{1F9E0}";
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
          content: enabled ? "\u{1F50A} **Verbose mode enabled**" : "\u{1F507} **Verbose mode disabled**",
          ephemeral: true,
        });
        break;
      }

      case "usage": {
        const mode = interaction.options.getString("mode", true);
        state.usageMode = mode;
        await interaction.reply({
          content: `\u{1F4C8} **Usage tracking set to:** ${mode}`,
          ephemeral: true,
        });
        break;
      }

      case "session": {
        const name = interaction.options.getString("name", true);
        const baseKey = getSessionKeyFromInteraction(interaction);
        const newSessionKey = `${baseKey}/${name}`;
        await interaction.reply({
          content: `\u{1F4AC} **Switched to session:** ${newSessionKey}\n\nNote: Each session maintains separate context.`,
          ephemeral: false,
        });
        break;
      }

      case "wopr": {
        const message = interaction.options.getString("message", true);
        await this.handleWoprMessage(interaction, message);
        break;
      }

      case "help": {
        await interaction.reply({
          content:
            `**\u{1F916} WOPR Discord Commands**\n\n` +
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
            content: "\u274C The /claim command only works in DMs. Please DM me to claim ownership.",
            ephemeral: true,
          });
          break;
        }

        // Delegated to index.ts - this case is handled via the claimHandler callback
        // We import the pairing functions in index.ts and pass them through
        // For now, this is a stub that gets overridden by the orchestrator
        await interaction.reply({
          content: "\u274C Claim handler not configured.",
          ephemeral: true,
        });
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
          let msg = "\u23F9\uFE0F **Cancelled**\n\nThe current response has been stopped.";
          if (pendingCount > 0) {
            msg += `\n\n_${pendingCount} queued message(s) also cleared._`;
          }
          await interaction.reply({
            content: msg,
            ephemeral: false,
          });
        } else {
          await interaction.reply({
            content: "\u2139\uFE0F **Nothing to cancel**\n\nNo response is currently in progress.",
            ephemeral: true,
          });
        }
        break;
      }

      case "model": {
        const modelChoice = interaction.options.getString("model", true);

        const resolved = this.resolveModel(modelChoice);
        if (!resolved) {
          const models = this.getAllModels();
          const list =
            models.length > 0
              ? models.map((m) => `\`${m.id}\` \u2014 ${m.name}`).join("\n")
              : "_No models discovered yet. Try again in a moment._";
          await interaction.reply({
            content: `\u274C Unknown model: \`${modelChoice}\`\n\n**Available models:**\n${list}`,
            ephemeral: true,
          });
          break;
        }

        state.model = resolved.id;

        try {
          if (this.ctx.setSessionProvider) {
            await this.ctx.setSessionProvider(sessionKey, resolved.provider, { model: resolved.id });
          } else {
            throw new Error("Session provider switching not available in this environment");
          }

          await interaction.reply({
            content: `\u{1F504} **Model switched to:** ${resolved.name} (\`${resolved.id}\`)\n\nAll future responses will use this model.`,
            ephemeral: false,
          });
        } catch (e) {
          logger.error({ msg: "Failed to switch model", error: String(e) });
          await interaction.reply({
            content: `\u274C Failed to switch model: ${e}`,
            ephemeral: true,
          });
        }
        break;
      }

      default: {
        // Check if this is a dynamically registered command from another plugin
        const registeredCmd = this.getRegisteredCommands().get(commandName);
        if (registeredCmd) {
          await this.handleDynamicCommand(interaction, registeredCmd);
        } else {
          logger.warn({ msg: "Unknown slash command", command: commandName });
        }
        break;
      }
    }
  }

  async handleAutocomplete(interaction: AutocompleteInteraction): Promise<void> {
    if (interaction.commandName === "model") {
      const focused = interaction.options.getFocused().toLowerCase();
      const models = this.getAllModels();
      const filtered = models
        .filter((m) => m.id.includes(focused) || m.name.toLowerCase().includes(focused) || focused === "")
        .slice(0, 25); // Discord max 25 choices
      await interaction.respond(filtered.map((m) => ({ name: `${m.name} (${m.id})`, value: m.id })));
    }
  }

  private async handleDynamicCommand(
    interaction: ChatInputCommandInteraction,
    registeredCmd: ChannelCommand,
  ): Promise<void> {
    const client = this.getClient();

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
              value = user.username;
              logger.info({ msg: "Resolved mention to username", original: String(option.value), resolved: value });
            }
          } catch (err) {
            logger.warn({ msg: "Failed to resolve mention to username", value, error: String(err) });
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
      logger.error({ msg: "Channel command handler error", command: interaction.commandName, error: String(err) });
      if (!replied) {
        await interaction.reply({ content: `Error: ${err}`, ephemeral: true });
      }
    }
  }

  private async getSessionInfo(_sessionKey: string): Promise<string> {
    return "\u{1F4BE} Session active";
  }

  private async handleWoprMessage(interaction: ChatInputCommandInteraction, messageContent: string): Promise<void> {
    const client = this.getClient();
    if (!client) return;

    const sessionKey = getSessionKeyFromInteraction(interaction);
    const state = this.queueManager.getSessionState(sessionKey);
    state.messageCount++;

    // Defer reply since AI response takes time
    await interaction.deferReply();

    // Add thinking level context
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
    } catch (error: any) {
      logger.error({ msg: "Slash command inject failed", error: String(error) });
      await interaction.editReply("\u274C Error processing your request.");
    }
  }
}
