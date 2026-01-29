# Troubleshooting Discord Plugin

Common issues and solutions.

## Quick Diagnostics

```bash
# Check if plugin is enabled
wopr plugin list

# View recent logs
wopr daemon logs | grep -i discord

# Check configuration
wopr config get plugins.data.wopr-plugin-discord

# Test bot token
curl -H "Authorization: Bot YOUR_TOKEN" \
  https://discord.com/api/v10/users/@me
```

## Bot Won't Connect

### "Invalid token"

**Symptoms:** Plugin fails to start, token errors in logs.

**Solutions:**
1. Reset token in Discord Developer Portal
2. Update WOPR config: `wopr config set plugins.data.wopr-plugin-discord.token "NEW_TOKEN"`
3. Restart daemon: `wopr daemon restart`

### "Disallowed intent"

**Symptoms:** Connection fails with intent-related error.

**Solution:**
1. Go to [Discord Developer Portal](https://discord.com/developers/applications)
2. Select your application → Bot
3. Enable **MESSAGE CONTENT INTENT**
4. Enable **SERVER MEMBERS INTENT**
5. Save changes
6. Restart WOPR daemon

### "Connection timeout"

**Symptoms:** Bot takes long to connect or times out.

**Solutions:**
- Check internet connection
- Verify Discord API status: https://discordstatus.com
- Check firewall (outbound HTTPS on 443)
- Try restarting daemon

## Bot Not Responding

### "Bot appears offline"

**Checklist:**
1. Is WOPR daemon running? `wopr daemon status`
2. Is plugin enabled? `wopr plugin list`
3. Is token valid?
4. Is bot in the server?

### "Bot online but not responding"

**Common causes:**

1. **Wrong session mapping**
   ```bash
   # Check current mapping
   wopr config get plugins.data.wopr-plugin-discord.sessionMapping
   ```

2. **DM policy blocking**
   ```bash
   # Check DM policy
   wopr config get plugins.data.wopr-plugin-discord.dmPolicy
   # Try: "open" for testing
   ```

3. **No @mention**
   - Bot only responds to @mentions by default
   - Check if mention format is correct

### "Bot responds in wrong session"

**Solution:** Update session mapping:

```bash
# Get channel ID (right-click channel → Copy ID)
# Enable Developer Mode in Discord first

# Set mapping
wopr config set plugins.data.wopr-plugin-discord.sessionMapping \
  '{"CHANNEL_ID":"session-name"}'
```

## Message Issues

### "Messages too long"

Discord has a 2000 character limit. The plugin auto-splits messages.

To adjust chunk size:
```json
{
  "responseChunkSize": 1900
}
```

### "Context not working"

**Symptoms:** Bot doesn't remember previous messages.

**Solutions:**
1. Check `maxContextMessages` setting
2. Ensure bot has `READ_MESSAGE_HISTORY` permission
3. Verify session persistence is working

### "Reactions not showing"

**Symptoms:** No 👀/✅ reactions.

**Solutions:**
1. Check `enableReactions` is true
2. Verify bot has `ADD_REACTIONS` permission
3. Check rate limits (too many reactions)

## Permission Issues

### "Missing Access"

**Symptoms:** 403 errors in logs.

**Solution:**
1. Check bot permissions in server
2. Re-invite with correct permissions:
   - Send Messages
   - Read Message History
   - Add Reactions
   - Use External Emojis

### "Cannot send messages to this user"

**Symptoms:** DM responses fail.

**Solution:**
1. User may have DMs disabled
2. Bot may not share a server with user
3. Check DM policy settings

## Performance Issues

### "Slow responses"

**Causes & Solutions:**

1. **Large context window**
   - Reduce `maxContextMessages`
   - Default is 50, try 20

2. **AI provider slow**
   - Check provider status
   - Switch to faster model

3. **Rate limiting**
   - Discord rate limits: ~5 requests/second
   - Check WOPR logs for rate limit warnings

### "High memory usage"

**Solutions:**
- Reduce `maxContextMessages`
- Disable typing indicator: `enableTyping: false`
- Restart daemon periodically

## Configuration Issues

### Config not saving

```bash
# Verify config format
wopr config set plugins.data.wopr-plugin-discord \
  '{"token":"YOUR_TOKEN","dmPolicy":"open"}'

# Check for JSON syntax errors
```

### Session not found

```bash
# List available sessions
wopr session list

# Create session if missing
wopr session create discord "You are a helpful Discord bot."
```

## Common Error Messages

| Error | Meaning | Solution |
|-------|---------|----------|
| `Authentication failed` | Invalid token | Reset and update token |
| `Missing Access` | No permissions | Check server permissions |
| `Unknown Channel` | Channel not found | Check channel ID |
| `Cannot reply` | Missing reply perm | Check permissions |
| `Rate limited` | Too many requests | Wait and retry |

## Debug Mode

Enable debug logging:

```bash
# Start daemon with debug
DEBUG=wopr:* wopr daemon start

# Or set environment
export DEBUG=wopr:*
wopr daemon start
```

## Getting Help

1. Check [WOPR Troubleshooting](../../docs/TROUBLESHOOTING.md)
2. Search [Discord.js Documentation](https://discord.js.org/)
3. Check [Discord API Docs](https://discord.com/developers/docs)
4. Open an issue with logs and config (remove token!)
