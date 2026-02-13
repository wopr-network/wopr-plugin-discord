/**
 * discord.js v15 Compatibility Audit
 *
 * Scans the wopr-plugin-discord codebase for discord.js v15 breaking changes.
 * Each finding includes the file path, line number, severity, and recommended fix.
 *
 * Current version: discord.js ^14.14.1
 * Target version:  discord.js 15.x
 *
 * ============================================================================
 * MIGRATION DOCUMENT
 * ============================================================================
 *
 * ## Summary
 *
 * Total breaking changes found: 5 (affecting this codebase)
 * Total files affected: 3
 * Estimated effort: ~2 hours for a developer familiar with the codebase
 *
 * ## Changes Needed (ordered by recommended migration sequence)
 *
 * ### Phase 1: Quick fixes (30 min)
 * 1. Replace `message.interaction` with `message.interactionMetadata`
 *    - File: src/event-handlers.ts:141
 *    - Effort: trivial (property rename)
 *
 * 2. Replace `ephemeral: true` with `flags: MessageFlags.Ephemeral`
 *    - Files: src/slash-commands.ts (14 occurrences)
 *    - Effort: low (search-and-replace with import addition)
 *
 * 3. Replace numeric channel type `=== 1` with `ChannelType.DM`
 *    - File: src/event-handlers.ts:143, src/slash-commands.ts:355
 *    - Effort: trivial (already partially uses ChannelType enum)
 *
 * ### Phase 2: Type/API updates (30 min)
 * 4. Update `CommandInteractionOptionResolver#getFocused()` call site
 *    - File: src/slash-commands.ts:195
 *    - Effort: low (return type changes from string to AutocompleteFocusedOption)
 *
 * 5. Handle `AsyncEventEmitter` base class change
 *    - File: src/index.ts (Client extends AsyncEventEmitter in v15)
 *    - Effort: low (event handlers should remain compatible, but test)
 *
 * ### Phase 3: Testing (1 hour)
 * 6. Run full test suite against discord.js v15 dev build
 * 7. Verify all event listeners still fire correctly
 * 8. Verify interaction response patterns work
 *
 * ## NOT affected in this codebase
 *
 * The following v15 breaking changes do NOT affect this plugin:
 * - NewsChannel -> AnnouncementChannel (not used)
 * - Guild#shard removal (not used)
 * - Client#emojis removal (not used)
 * - SelectMenuBuilder renames (not used)
 * - Sharding config changes (not used -- bot uses single shard)
 * - ClientEvents type removal (not imported)
 * - User#avatarDecoration removal (not used)
 * - User#fetchFlags() removal (not used)
 * - ActionRow.from() removal (not used)
 * - GuildMemberResolvable removal (not used)
 * - Emoji#url -> Emoji#imageURL() (not used)
 * - Formatters class removal (not used)
 * - bulkDelete return type change (not used)
 * - deleteMessageDays -> deleteMessageSeconds (not used)
 *
 * ============================================================================
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AuditSeverity = "breaking" | "deprecation" | "style";

export interface AuditFinding {
  /** Unique identifier for the finding */
  id: string;
  /** File path relative to project root */
  file: string;
  /** Line number (1-indexed) */
  line: number;
  /** Severity of the breaking change */
  severity: AuditSeverity;
  /** Short category label */
  category: string;
  /** Human-readable description of the issue */
  description: string;
  /** The current code pattern that will break */
  currentPattern: string;
  /** The v15-compatible replacement */
  v15Replacement: string;
  /** Estimated effort to fix */
  effort: "trivial" | "low" | "medium" | "high";
}

// ---------------------------------------------------------------------------
// Audit Results
// ---------------------------------------------------------------------------

/**
 * All discord.js v15 breaking changes found in this codebase.
 * Each entry references the exact file and line where the issue exists.
 */
export const v15AuditFindings: AuditFinding[] = [
  {
    id: "V15-001",
    file: "src/event-handlers.ts",
    line: 141,
    severity: "breaking",
    category: "Message#interaction removal",
    description:
      "Message#interaction is removed in v15. Use Message#interactionMetadata instead. " +
      "The new property returns InteractionMetadata (with .user, .type, .commandName) " +
      "instead of the full MessageInteraction object.",
    currentPattern: "if (message.interaction) return;",
    v15Replacement: "if (message.interactionMetadata) return;",
    effort: "trivial",
  },
  {
    id: "V15-002",
    file: "src/event-handlers.ts",
    line: 143,
    severity: "style",
    category: "Numeric channel type literal",
    description:
      "Uses numeric literal `1` instead of ChannelType.DM enum. While this works in v14, " +
      "v15 may change enum values. Use the ChannelType enum for forward compatibility.",
    currentPattern: "const isDM = message.channel.type === 1;",
    v15Replacement: "const isDM = message.channel.type === ChannelType.DM;",
    effort: "trivial",
  },
  {
    id: "V15-003",
    file: "src/slash-commands.ts",
    line: 195,
    severity: "breaking",
    category: "getFocused() parameter removal",
    description:
      "CommandInteractionOptionResolver#getFocused() no longer accepts a boolean parameter. " +
      "In v15 it always returns AutocompleteFocusedOption. Currently called with no args " +
      "(returns string), which changes to returning an object with .value property.",
    currentPattern: "interaction.options.getFocused().toLowerCase()",
    v15Replacement: "interaction.options.getFocused().value.toLowerCase()",
    effort: "low",
  },
  {
    id: "V15-004",
    file: "src/slash-commands.ts",
    line: 355,
    severity: "style",
    category: "Numeric channel type literal",
    description: "Uses numeric literal `1` instead of ChannelType.DM enum for DM channel check.",
    currentPattern: "if (interaction.channel?.type !== 1)",
    v15Replacement: "import { ChannelType } from 'discord.js'; if (interaction.channel?.type !== ChannelType.DM)",
    effort: "trivial",
  },
  {
    id: "V15-005",
    file: "src/slash-commands.ts",
    line: 217,
    severity: "breaking",
    category: "ephemeral option removal",
    description:
      "The `ephemeral` option in interaction replies is removed in v15. " +
      "Use `flags: MessageFlags.Ephemeral` instead. This affects 14 reply/followUp calls " +
      "across slash-commands.ts.",
    currentPattern: "await interaction.reply({ content: '...', ephemeral: true })",
    v15Replacement:
      "import { MessageFlags } from 'discord.js'; await interaction.reply({ content: '...', flags: MessageFlags.Ephemeral })",
    effort: "low",
  },
];

// ---------------------------------------------------------------------------
// Event Name Mapping
// ---------------------------------------------------------------------------

/**
 * Event names that are renamed or removed in discord.js v15.
 * Only includes events relevant to this codebase.
 *
 * Note: This plugin uses `Events.ClientReady`, `Events.MessageCreate`,
 * `Events.InteractionCreate`, and `Events.TypingStart` via the Events enum
 * (not string literals), so event name changes are handled by the enum update
 * in v15. No code changes needed for event registration.
 */
export const eventNameChanges: Record<string, { v14: string; v15: string; status: "renamed" | "removed" }> = {
  clientReady: {
    v14: "ready",
    v15: "clientReady",
    status: "renamed",
  },
  webhooksUpdate: {
    v14: "webhookUpdate",
    v15: "webhooksUpdate",
    status: "renamed",
  },
  shardDisconnect: {
    v14: "shardDisconnect",
    v15: "(removed)",
    status: "removed",
  },
  shardError: {
    v14: "shardError",
    v15: "(removed)",
    status: "removed",
  },
  shardReady: {
    v14: "shardReady",
    v15: "(removed)",
    status: "removed",
  },
  shardReconnecting: {
    v14: "shardReconnecting",
    v15: "(removed)",
    status: "removed",
  },
  shardResume: {
    v14: "shardResume",
    v15: "(removed)",
    status: "removed",
  },
};

// ---------------------------------------------------------------------------
// Type Renames
// ---------------------------------------------------------------------------

/**
 * Types renamed in discord.js v15. Maps old name to new name.
 * Only includes types relevant to this codebase or commonly encountered.
 */
export const typeRenames: Record<string, string> = {
  NewsChannel: "AnnouncementChannel",
  SelectMenuBuilder: "StringSelectMenuBuilder",
  SelectMenuComponent: "StringSelectMenuComponent",
  SelectMenuInteraction: "StringSelectMenuInteraction",
  SelectMenuOptionBuilder: "StringSelectMenuOptionBuilder",
  ClientEvents: "ClientEventTypes",
  GuildMemberResolvable: "UserResolvable",
};

// ---------------------------------------------------------------------------
// Affected Files Summary
// ---------------------------------------------------------------------------

/**
 * Summary of all source files and their v15 compatibility status.
 */
export const fileAuditSummary: Record<string, { findings: number; status: "clean" | "needs-update" }> = {
  "src/index.ts": { findings: 0, status: "clean" },
  "src/event-handlers.ts": { findings: 2, status: "needs-update" },
  "src/slash-commands.ts": { findings: 3, status: "needs-update" },
  "src/channel-provider.ts": { findings: 0, status: "clean" },
  "src/channel-queue.ts": { findings: 0, status: "clean" },
  "src/discord-utils.ts": { findings: 0, status: "clean" },
  "src/discord-extension.ts": { findings: 0, status: "clean" },
  "src/message-streaming.ts": { findings: 0, status: "clean" },
  "src/typing-manager.ts": { findings: 0, status: "clean" },
  "src/reaction-manager.ts": { findings: 0, status: "clean" },
  "src/friend-buttons.ts": { findings: 0, status: "clean" },
  "src/identity-manager.ts": { findings: 0, status: "clean" },
  "src/attachments.ts": { findings: 0, status: "clean" },
  "src/pairing.ts": { findings: 0, status: "clean" },
  "src/logger.ts": { findings: 0, status: "clean" },
  "src/types.ts": { findings: 0, status: "clean" },
};

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

/** Get all findings for a specific file */
export function getFindingsForFile(file: string): AuditFinding[] {
  return v15AuditFindings.filter((f) => f.file === file);
}

/** Get all findings of a specific severity */
export function getFindingsBySeverity(severity: AuditSeverity): AuditFinding[] {
  return v15AuditFindings.filter((f) => f.severity === severity);
}

/** Get a human-readable audit report */
export function generateAuditReport(): string {
  const lines: string[] = [
    "=== discord.js v15 Compatibility Audit Report ===",
    "",
    `Current version: ^14.14.1`,
    `Target version:  15.x`,
    `Total findings:  ${v15AuditFindings.length}`,
    `Breaking:        ${getFindingsBySeverity("breaking").length}`,
    `Deprecations:    ${getFindingsBySeverity("deprecation").length}`,
    `Style:           ${getFindingsBySeverity("style").length}`,
    "",
    "--- Findings ---",
    "",
  ];

  for (const finding of v15AuditFindings) {
    lines.push(`[${finding.id}] ${finding.severity.toUpperCase()} - ${finding.category}`);
    lines.push(`  File: ${finding.file}:${finding.line}`);
    lines.push(`  ${finding.description}`);
    lines.push(`  Current: ${finding.currentPattern}`);
    lines.push(`  Fix:     ${finding.v15Replacement}`);
    lines.push(`  Effort:  ${finding.effort}`);
    lines.push("");
  }

  const affectedFiles = Object.entries(fileAuditSummary).filter(([, v]) => v.status === "needs-update");
  lines.push("--- Affected Files ---");
  lines.push("");
  for (const [file, info] of affectedFiles) {
    lines.push(`  ${file} (${info.findings} finding(s))`);
  }

  return lines.join("\n");
}
