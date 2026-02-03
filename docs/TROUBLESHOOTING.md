# Troubleshooting Discord Plugin

Common issues and solutions for the WOPR Discord plugin.

## Quick Diagnostics

```bash
# Check if plugin is enabled
wopr plugin list

# View recent logs
wopr daemon logs | grep -i discord

# Check configuration
wopr config get plugins.data.wopr-plugin-discord

# Test bot token (replace YOUR_TOKEN)
curl -H "Authorization: Bot YOUR_TOKEN" \
  https://discord.com/api/v10/users/@me
```

## Bot Won't Connect

### "Invalid token"

**Symptoms:** Plugin fails to start, token errors in logs.

**Solutions:**
1. Go to [Discord Developer Portal](https://discord.com/developers/applications)
2. Select your application -> Bot
3. Click "Reset Token" to generate a new one
4. Update config:
   ```bash
   wopr config set plugins.data.wopr-plugin-discord.token "NEW_TOKEN"
   ```
5. Restart daemon: `wopr daemon restart`

### "Disallowed intent"

**Symptoms:** Connection fails with intent-related error.

**Solution:**
1. Go to Discord Developer Portal
2. Select your application -> Bot
3. Scroll to "Privileged Gateway Intents"
4. Enable **MESSAGE CONTENT INTENT**
5. Enable **SERVER MEMBERS INTENT**
6. Save changes
7. Restart WOPR daemon

### "Connection timeout"

**Symptoms:** Bot takes long to connect or times out.

**Solutions:**
- Check internet connection
- Verify Discord API status: https://discordstatus.com
- Check firewall allows outbound HTTPS (port 443)
- Try restarting daemon

## Bot Not Responding

### "Bot appears offline"

**Checklist:**
1. Is WOPR daemon running? `wopr daemon status`
2. Is plugin enabled? `wopr plugin list`
3. Is token valid? Check logs for auth errors
4. Is bot in the server? Check server member list

### "Bot online but not responding"

**Common causes:**

1. **Not @mentioned**
   - Bot only responds to direct @mentions or DMs
   - Regular messages are logged to context only

2. **Missing intents**
   - Verify MESSAGE CONTENT INTENT is enabled in Developer Portal

3. **No clientId configured**
   - Slash commands require `clientId` to be set
   - Mentions still work without it

4. **Rate limited**
   - Check logs for rate limit warnings
   - Wait a few minutes and try again

### "Bot responds but times out"

**Possible causes:**

1. **WOPR session issues**
   - Reset the session: `/reset`
   - Check session exists: `wopr session list | grep discord`

2. **AI provider down**
   - Check Anthropic status: https://status.anthropic.com
   - Try switching models: `/model haiku`

3. **Large context**
   - Compact the session: `/compact`
   - Reset if needed: `/reset`

## Slash Commands Issues

### Commands not appearing

1. **Check `clientId` is set:**
   ```bash
   wopr config get plugins.data.wopr-plugin-discord.clientId
   ```

2. **Set `guildId` for instant registration:**
   ```bash
   wopr config set plugins.data.wopr-plugin-discord.guildId "YOUR_GUILD_ID"
   wopr daemon restart
   ```

3. **Verify bot permissions:**
   - Bot needs `applications.commands` OAuth scope
   - May need to re-invite bot with correct scope

4. **Wait for propagation:**
   - Global commands can take up to 1 hour
   - Guild-specific commands are instant

### "Unknown command" error

Command was registered but not recognized by the handler:

1. Check daemon logs for registration errors
2. Restart daemon to re-register commands
3. Kick and re-add the bot to force refresh

### "/claim not working"

1. **Must be in DMs** - not server channels
2. **No owner set** - if owner already configured, claim is rejected
3. **Valid pairing code** - DM the bot first to get a code
4. **Code not expired** - codes expire after 15 minutes

## Message Issues

### "Messages too long"

Discord has a 2000 character limit. The plugin automatically:
- Splits long responses into multiple messages
- Uses edit-in-place for streaming (up to 2000 chars)
- Creates new messages when exceeded

If responses seem cut off:
1. Check if multiple messages were sent
2. The final message may still be streaming

### "Context not working"

**Symptoms:** Bot doesn't remember previous messages.

**Solutions:**
1. Messages ARE being logged - check with mentions
2. Context buffer holds last 20 messages per channel
3. Session may have been reset
4. Check correct session is being used: `/status`

### "Attachments not processing"

**Symptoms:** Uploaded images/files not recognized.

**Solutions:**
1. Check attachments directory exists:
   - In Docker: `/data/attachments/`
   - Locally: `./attachments/`
2. Check directory is writable
3. Check daemon logs for download errors
4. Verify attachment URL is accessible

## Session Issues

### "Wrong session"

Sessions are based on channel names, not IDs:
- `discord:guild-name:#channel-name`
- `discord:guild-name:#parent/thread-name`
- `discord:dm:username`

If session seems wrong:
1. Check current session: `/status`
2. Sessions are sanitized (lowercase, dashes for spaces)
3. Guild/channel name changes affect session key

### "Session not found"

```bash
# List discord sessions
wopr session list | grep discord

# Create if missing
wopr session create "discord:my-server:#general"
```

### "Session state lost"

Per-session state (thinking level, verbose, model) is stored in memory:
- Lost when daemon restarts
- Use `/model` to persist model choice

## Owner & Pairing Issues

### "Pairing code not received"

1. **DM the bot** - pairing only triggers in DMs
2. **No owner configured** - if owner exists, no pairing code
3. **Check DMs are enabled** - must allow DMs from server members

### "Claim failed: Invalid code"

1. **Code expired** - codes last 15 minutes
2. **Wrong code** - case-insensitive, but check for typos
3. **Already claimed** - codes can only be used once

### "Not receiving owner notifications"

1. Verify `ownerUserId` is set:
   ```bash
   wopr config get plugins.data.wopr-plugin-discord.ownerUserId
   ```
2. Ensure DMs are enabled from the bot
3. Check you share a server with the bot

## Permission Issues

### "Missing Access"

**Symptoms:** 403 errors in logs.

**Solution:**
1. Check bot has required permissions:
   - Send Messages
   - Read Message History
   - Add Reactions
2. Check channel-specific permission overwrites
3. Re-invite bot with correct permissions

### "Cannot send messages"

**Symptoms:** Bot reads but can't respond.

**Solutions:**
1. Check bot has "Send Messages" permission
2. Check channel isn't read-only for bots
3. Verify no channel-specific role restrictions

### "Cannot add reactions"

**Symptoms:** No processing emoji appears.

**Solutions:**
1. Check bot has "Add Reactions" permission
2. Some emoji may be rate-limited
3. Check for role restrictions on reactions

## Performance Issues

### "Slow responses"

**Causes & Solutions:**

1. **Large context**
   - Compact: `/compact`
   - Reset: `/reset`

2. **Complex model**
   - Switch to faster model: `/model haiku`

3. **Rate limiting**
   - Wait between messages
   - Check logs for rate limit warnings

4. **Network latency**
   - Check connection to Discord
   - Check connection to AI provider

### "Bot-to-bot conversation stuck"

The plugin has flow control for bot-to-bot:
- 5 second cooldown between bot responses
- Pauses when humans are typing (15s window)
- Human messages take priority

If stuck:
1. Have a human send a message (resets queue)
2. Wait for cooldowns to expire
3. Check logs for queue state

## Debug Mode

Enable debug logging:

```bash
# View all discord logs
wopr daemon logs | grep -i discord

# Watch live logs
wopr daemon logs -f | grep -i discord
```

Log file locations:
- Error log: `$WOPR_HOME/logs/discord-plugin-error.log`
- Debug log: `$WOPR_HOME/logs/discord-plugin.log`

## Common Error Messages

| Error | Meaning | Solution |
|-------|---------|----------|
| `Authentication failed` | Invalid token | Reset and update token |
| `Missing Access` | No permissions | Check bot permissions |
| `Unknown Channel` | Channel not found | Verify channel exists |
| `Cannot reply` | Missing reply permission | Check send permissions |
| `Rate limited` | Too many requests | Wait and retry |
| `Disallowed intent` | Missing privileged intent | Enable in Developer Portal |
| `Not configured` | Token not set | Set token in config |

## Getting Help

1. Check daemon logs: `wopr daemon logs | grep -i discord`
2. Check [Discord.js Documentation](https://discord.js.org/)
3. Check [Discord API Docs](https://discord.com/developers/docs)
4. Open an issue with logs and config (remove token first!)

When reporting issues, include:
- WOPR version: `wopr --version`
- Plugin version: Check package.json
- Error messages from logs
- Steps to reproduce
- Configuration (without token!)
