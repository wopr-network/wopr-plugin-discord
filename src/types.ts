/**
 * Type definitions for the WOPR Discord plugin.
 *
 * Shared types are re-exported from @wopr-network/plugin-types.
 * Plugin-specific types that don't exist in the shared package are defined here.
 */

// Re-export all shared types that this plugin uses
export type {
  AgentIdentity,
  ChannelCommand,
  ChannelCommandContext,
  ChannelMessageContext,
  ChannelMessageParser,
  ChannelProvider,
  ChannelRef,
  ConfigField,
  ConfigSchema,
  EventHandler,
  PluginCommand,
  PluginInjectOptions,
  PluginLogger,
  SessionCreateEvent,
  SessionInjectEvent,
  SessionResponseEvent,
  StreamMessage,
  UserProfile,
  WOPREvent,
  WOPREventBus,
  WOPRPlugin,
  WOPRPluginContext,
} from "@wopr-network/plugin-types";

import type { ChannelRef, StreamMessage } from "@wopr-network/plugin-types";

// ============================================================================
// Plugin-specific types (not in shared package)
// ============================================================================

/**
 * @deprecated Use ChannelRef from @wopr-network/plugin-types instead.
 */
export type ChannelInfo = ChannelRef;

/**
 * Stream event from plugin context on() subscription.
 * This is specific to how the Discord plugin consumes stream events.
 */
export interface SessionStreamEvent {
  session: string;
  from: string;
  message: StreamMessage;
}

/**
 * Provider info returned by getProviders() — not in shared types.
 */
export interface ProviderInfo {
  id: string;
  name: string;
  available: boolean;
  models?: string[];
}
