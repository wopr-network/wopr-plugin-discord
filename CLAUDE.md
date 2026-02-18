# wopr-plugin-discord

`@wopr-network/wopr-plugin-discord` — Discord channel plugin for WOPR. **Reference implementation** — use this as the template for all other plugins.

## Commands

```bash
npm run build     # tsc
npm run dev       # tsc --watch
npm run check     # biome check + tsc --noEmit (run before committing)
npm run lint:fix  # biome check --fix src/
npm run format    # biome format --write src/
npm test          # vitest run
```

**Linter/formatter is Biome.** Never add ESLint/Prettier config.

## Architecture

```
src/
  index.ts              # Plugin entry — exports WOPRPlugin default
  channel-provider.ts   # Implements ChannelProvider interface
  channel-queue.ts      # Message queuing and rate limiting
  event-handlers.ts     # Discord.js event wiring
  slash-commands.ts     # /ask, /pair, etc.
  message-streaming.ts  # Token streaming to Discord
  identity-manager.ts   # User identity and pairing
  pairing.ts            # Device pairing flow
  reaction-manager.ts   # Reaction-based UX
  friend-buttons.ts     # Button component handlers
  attachments.ts        # File/image attachment handling
  typing-manager.ts     # Typing indicator management
  discord-utils.ts      # Shared helpers
  discord-extension.ts  # Extension hooks
  webmcp-discord.ts     # WebMCP integration
  compat/
    v15-shim.ts         # discord.js v15 compatibility shim
    v15-audit.ts        # Audit for v15 API usage
  logger.ts             # Winston logger instance
  types.ts              # Plugin-local types
```

## Plugin Contract

This plugin imports ONLY from `@wopr-network/plugin-types` — never from wopr core internals.

```typescript
import type { WOPRPlugin, WOPRPluginContext, ChannelProvider } from "@wopr-network/plugin-types";
```

The default export must satisfy `WOPRPlugin`. The plugin receives `WOPRPluginContext` at `init()` time.

## Key Conventions

- discord.js v14 (v15 shim exists in `compat/` for forward compatibility)
- Winston for logging (not console.log)
- Node ≥ 24, ESM (`"type": "module"`)
- Conventional commits with issue key: `feat: add voice support (WOP-123)`
- `npm run check` must pass before every commit

## Issue Tracking

All issues in **Linear** (team: WOPR). No GitHub issues. Issue descriptions start with `**Repo:** wopr-network/wopr-plugin-discord`.
