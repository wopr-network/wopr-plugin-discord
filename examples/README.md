# Discord Plugin Examples

Example configurations for the WOPR Discord plugin.

## Files

- `basic-config.json` - Simple single-server setup
- `multi-server-config.json` - Multi-server/channel setup

## Usage

```bash
# Apply a configuration
wopr config set plugins.data.wopr-plugin-discord \
  "$(cat examples/basic-config.json)"

# Or manually copy values
```

## Getting Channel IDs

1. Enable Developer Mode in Discord:
   - Settings → Advanced → Developer Mode

2. Right-click channel → Copy ID

## Finding Your User ID

1. Enable Developer Mode (see above)
2. Right-click your username → Copy ID
