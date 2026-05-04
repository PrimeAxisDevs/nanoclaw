#!/usr/bin/env node
/**
 * gcal — Google Calendar CLI for NanoClaw containers
 *
 * Reads OAuth credentials from /home/node/.gmail-mcp/ (same credentials
 * already used by Gmail — Calendar scope must be included).
 *
 * Usage:
 *   gcal calendars
 *   gcal list [--days N] [--cal CALENDAR_ID]
 *   gcal create --title "..." --start "YYYY-MM-DDTHH:MM:SS" --end "YYYY-MM-DDTHH:MM:SS" [--desc "..."] [--location "..."] [--cal CALENDAR_ID]
 *   gcal update EVENT_ID [--title "..."] [--start "..."] [--end "..."] [--desc "..."] [--location "..."] [--cal CALENDAR_ID]
 *   gcal delete EVENT_ID [--cal CALENDAR_ID]
 *   gcal get EVENT_ID [--cal CALENDAR_ID]
 */

import fs from 'fs';
import path from 'path';
import os from 'os';

const CREDS_DIR = path.join(os.homedir(), '.gmail-mcp');
const KEYS_PATH = path.join(CREDS_DIR, 'gcp-oauth.keys.json');
const TOKENS_PATH = path.join(CREDS_DIR, 'credentials.json');
const CALENDAR_BASE = 'https://www.googleapis.com/calendar/v3';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';

// ── Credential helpers ────────────────────────────────────────────────────────

function loadKeys() {
  const raw = JSON.parse(fs.readFileSync(KEYS_PATH, 'utf-8'));
  const cfg = raw.installed || raw.web || raw;
  return { clientId: cfg.client_id, clientSecret: cfg.client_secret };
}

function loadTokens() {
  return JSON.parse(fs.readFileSync(TOKENS_PATH, 'utf-8'));
}

function saveTokens(tokens) {
  const current = loadTokens();
  const updated = { ...current, ...tokens };
  fs.writeFileSync(TOKENS_PATH, JSON.stringify(updated, null, 2));
  return updated;
}

async function getAccessToken() {
  const tokens = loadTokens();
  const now = Date.now();
  // Refresh if expired or within 60 s of expiry
  if (tokens.expiry_date && tokens.expiry_date - now > 60_000) {
    return tokens.access_token;
  }
  if (!tokens.refresh_token) {
    die('No refresh_token in credentials. Re-run OAuth setup.');
  }
  const { clientId, clientSecret } = loadKeys();
  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: tokens.refresh_token,
      grant_type: 'refresh_token',
    }),
  });
  const data = await res.json();
  if (!res.ok) die(`Token refresh failed: ${JSON.stringify(data)}`);
  const newTokens = {
    access_token: data.access_token,
    expiry_date: now + data.expires_in * 1000,
  };
  saveTokens(newTokens);
  return newTokens.access_token;
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────

async function calFetch(method, path, body) {
  const token = await getAccessToken();
  const url = `${CALENDAR_BASE}${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) die(`API error ${res.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}

// ── Formatting ────────────────────────────────────────────────────────────────

function fmtDatetime(dt) {
  if (!dt) return '';
  const d = dt.dateTime || dt.date;
  if (!d) return '';
  const date = new Date(d);
  if (isNaN(date.getTime())) return d;
  return date.toLocaleString('en-AU', { timeZone: process.env.TZ || 'UTC' });
}

function fmtEvent(e) {
  const start = fmtDatetime(e.start);
  const end = fmtDatetime(e.end);
  const loc = e.location ? `\n  Location: ${e.location}` : '';
  const desc = e.description ? `\n  Desc: ${e.description.slice(0, 120)}` : '';
  return `[${e.id}] ${e.summary || '(no title)'}\n  ${start} → ${end}${loc}${desc}`;
}

// ── CLI arg parser ────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        args[key] = next;
        i++;
      } else {
        args[key] = true;
      }
    } else {
      args._.push(a);
    }
  }
  return args;
}

function die(msg) {
  console.error('gcal error:', msg);
  process.exit(1);
}

function require_(args, ...keys) {
  for (const k of keys) {
    if (!args[k]) die(`--${k} is required`);
  }
}

// ── Commands ──────────────────────────────────────────────────────────────────

async function cmdCalendars() {
  const data = await calFetch('GET', '/users/me/calendarList?maxResults=50');
  const list = data.items || [];
  if (list.length === 0) { console.log('No calendars found.'); return; }
  console.log('Calendars:');
  for (const c of list) {
    const primary = c.primary ? ' [PRIMARY]' : '';
    console.log(`  ${c.id}${primary} — ${c.summary}`);
  }
}

async function cmdList(args) {
  const calId = args.cal || 'primary';
  const days = parseInt(args.days || '7', 10);
  const now = new Date();
  const then = new Date(now.getTime() + days * 86400_000);
  const qs = new URLSearchParams({
    timeMin: now.toISOString(),
    timeMax: then.toISOString(),
    singleEvents: 'true',
    orderBy: 'startTime',
    maxResults: '50',
  });
  const data = await calFetch('GET', `/calendars/${encodeURIComponent(calId)}/events?${qs}`);
  const events = data.items || [];
  if (events.length === 0) {
    console.log(`No events in the next ${days} day(s).`);
    return;
  }
  console.log(`Upcoming events (next ${days} day(s)):`);
  for (const e of events) {
    console.log(fmtEvent(e));
    console.log();
  }
}

async function cmdCreate(args) {
  require_(args, 'title', 'start', 'end');
  const calId = args.cal || 'primary';
  // Detect all-day (date-only) vs datetime
  const isAllDay = /^\d{4}-\d{2}-\d{2}$/.test(args.start);
  const body = {
    summary: args.title,
    start: isAllDay ? { date: args.start } : { dateTime: args.start, timeZone: process.env.TZ || 'UTC' },
    end: isAllDay ? { date: args.end } : { dateTime: args.end, timeZone: process.env.TZ || 'UTC' },
  };
  if (args.desc) body.description = args.desc;
  if (args.location) body.location = args.location;
  const e = await calFetch('POST', `/calendars/${encodeURIComponent(calId)}/events`, body);
  console.log('Event created:');
  console.log(fmtEvent(e));
}

async function cmdUpdate(args) {
  const eventId = args._[1];
  if (!eventId) die('EVENT_ID required: gcal update EVENT_ID [--title ...] ...');
  const calId = args.cal || 'primary';
  // Fetch existing first
  const existing = await calFetch('GET', `/calendars/${encodeURIComponent(calId)}/events/${encodeURIComponent(eventId)}`);
  const body = { ...existing };
  if (args.title) body.summary = args.title;
  if (args.desc !== undefined) body.description = args.desc;
  if (args.location !== undefined) body.location = args.location;
  if (args.start) {
    const isAllDay = /^\d{4}-\d{2}-\d{2}$/.test(args.start);
    body.start = isAllDay ? { date: args.start } : { dateTime: args.start, timeZone: process.env.TZ || 'UTC' };
  }
  if (args.end) {
    const isAllDay = /^\d{4}-\d{2}-\d{2}$/.test(args.end);
    body.end = isAllDay ? { date: args.end } : { dateTime: args.end, timeZone: process.env.TZ || 'UTC' };
  }
  const e = await calFetch('PUT', `/calendars/${encodeURIComponent(calId)}/events/${encodeURIComponent(eventId)}`, body);
  console.log('Event updated:');
  console.log(fmtEvent(e));
}

async function cmdDelete(args) {
  const eventId = args._[1];
  if (!eventId) die('EVENT_ID required: gcal delete EVENT_ID');
  const calId = args.cal || 'primary';
  await calFetch('DELETE', `/calendars/${encodeURIComponent(calId)}/events/${encodeURIComponent(eventId)}`);
  console.log(`Event ${eventId} deleted.`);
}

async function cmdGet(args) {
  const eventId = args._[1];
  if (!eventId) die('EVENT_ID required: gcal get EVENT_ID');
  const calId = args.cal || 'primary';
  const e = await calFetch('GET', `/calendars/${encodeURIComponent(calId)}/events/${encodeURIComponent(eventId)}`);
  console.log(fmtEvent(e));
  if (e.description) console.log('\nFull description:\n' + e.description);
  if (e.attendees) {
    console.log('\nAttendees:');
    for (const a of e.attendees) {
      console.log(`  ${a.displayName || a.email} <${a.email}> — ${a.responseStatus}`);
    }
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

const args = parseArgs(process.argv.slice(2));
const cmd = args._[0];

if (!fs.existsSync(KEYS_PATH) || !fs.existsSync(TOKENS_PATH)) {
  die('Google credentials not found at ~/.gmail-mcp/. Ensure Gmail is set up with Calendar scope.');
}

switch (cmd) {
  case 'calendars': await cmdCalendars(); break;
  case 'list':      await cmdList(args); break;
  case 'create':    await cmdCreate(args); break;
  case 'update':    await cmdUpdate(args); break;
  case 'delete':    await cmdDelete(args); break;
  case 'get':       await cmdGet(args); break;
  default:
    console.log(`Google Calendar CLI

Usage:
  gcal calendars                           List all calendars
  gcal list [--days N] [--cal ID]          Upcoming events (default: next 7 days, primary calendar)
  gcal get EVENT_ID [--cal ID]             Get event details
  gcal create --title "..." --start "YYYY-MM-DDTHH:MM:SS" --end "YYYY-MM-DDTHH:MM:SS" [--desc "..."] [--location "..."] [--cal ID]
  gcal update EVENT_ID [--title ...] [--start ...] [--end ...] [--desc ...] [--location ...] [--cal ID]
  gcal delete EVENT_ID [--cal ID]

  --cal defaults to "primary" calendar.
  All-day events: use date-only format for start/end (YYYY-MM-DD).`);
}
