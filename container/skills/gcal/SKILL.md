---
name: gcal
description: Read and write Google Calendar events. Use for scheduling, checking upcoming events, creating/updating/deleting events. Always preview event details before creating or deleting — wait for user confirmation first.
allowed-tools: Bash(node /home/node/.claude/skills/gcal/gcal.mjs:*)
---

# Google Calendar

Use `node /home/node/.claude/skills/gcal/gcal.mjs` for all calendar operations. The `TZ` environment variable sets the timezone.

## Quick reference

```bash
# List upcoming events (default: next 7 days)
node /home/node/.claude/skills/gcal/gcal.mjs list

# List next 14 days
node /home/node/.claude/skills/gcal/gcal.mjs list --days 14

# List all calendars (get non-primary calendar IDs)
node /home/node/.claude/skills/gcal/gcal.mjs calendars

# Get a specific event
node /home/node/.claude/skills/gcal/gcal.mjs get EVENT_ID

# Create an event (datetime)
node /home/node/.claude/skills/gcal/gcal.mjs create \
  --title "Team standup" \
  --start "2026-04-15T09:00:00" \
  --end "2026-04-15T09:30:00" \
  --desc "Daily sync" \
  --location "Zoom"

# Create an all-day event (date only, no time)
node /home/node/.claude/skills/gcal/gcal.mjs create \
  --title "Public Holiday" \
  --start "2026-04-25" \
  --end "2026-04-26"

# Update an event
node /home/node/.claude/skills/gcal/gcal.mjs update EVENT_ID \
  --title "New title" \
  --start "2026-04-15T10:00:00" \
  --end "2026-04-15T10:30:00"

# Delete an event
node /home/node/.claude/skills/gcal/gcal.mjs delete EVENT_ID

# Use a non-primary calendar
node /home/node/.claude/skills/gcal/gcal.mjs list --cal "work@example.com"
```

## Notes

- Requires the same Google OAuth credentials as Gmail (`~/.gmail-mcp/`). The Calendar API scope (`https://www.googleapis.com/auth/calendar`) must be included — if it's missing, re-run OAuth setup with that scope added.
- Times are interpreted in the container's `TZ` timezone (matches the host).
- `list` output includes the event ID in brackets — use it for `update`/`delete`/`get`.
- For the **Confirmation Protocol** (as defined in your system instructions): always show the event preview from `create`/`update` and wait for the user's "book it" / "confirmed" / "👍" before proceeding.
