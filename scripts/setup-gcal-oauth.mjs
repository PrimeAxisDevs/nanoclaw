#!/usr/bin/env node
/**
 * Google Calendar OAuth setup
 *
 * Reads gcp-oauth.keys.json, starts a local callback server,
 * opens the browser for authorization (Calendar + Gmail scopes),
 * and saves credentials.json to ~/.gmail-mcp/.
 *
 * Usage:
 *   node scripts/setup-gcal-oauth.mjs [path/to/gcp-oauth.keys.json]
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import http from 'http';
import { execSync } from 'child_process';

const CREDS_DIR = path.join(os.homedir(), '.gmail-mcp');
const TOKENS_PATH = path.join(CREDS_DIR, 'credentials.json');
const PORT = 4142;
const REDIRECT_URI = `http://localhost:${PORT}/callback`;

// Scopes: Calendar (full) + Gmail (optional, for the Gmail channel)
const SCOPES = [
  'https://www.googleapis.com/auth/calendar',
  'https://mail.google.com/',
].join(' ');

const keysArg = process.argv[2];
const keysPath = keysArg
  ? path.resolve(keysArg)
  : path.join(CREDS_DIR, 'gcp-oauth.keys.json');

if (!fs.existsSync(keysPath)) {
  console.error(`
OAuth keys file not found: ${keysPath}

Steps to get it:
  1. Open https://console.cloud.google.com
  2. APIs & Services > Library → enable "Google Calendar API" (and "Gmail API" if needed)
  3. APIs & Services > Credentials → + CREATE CREDENTIALS > OAuth client ID
     - Application type: Desktop app
  4. Download JSON → save it somewhere
  5. Re-run: node scripts/setup-gcal-oauth.mjs /path/to/downloaded-file.json
`);
  process.exit(1);
}

const raw = JSON.parse(fs.readFileSync(keysPath, 'utf-8'));
const cfg = raw.installed || raw.web || raw;
const { client_id, client_secret } = cfg;

// Copy keys to ~/.gmail-mcp if not already there
fs.mkdirSync(CREDS_DIR, { recursive: true });
const destKeys = path.join(CREDS_DIR, 'gcp-oauth.keys.json');
if (!fs.existsSync(destKeys) || destKeys !== keysPath) {
  fs.copyFileSync(keysPath, destKeys);
  console.log(`Copied OAuth keys to ${destKeys}`);
}

// Build authorization URL
const params = new URLSearchParams({
  client_id,
  redirect_uri: REDIRECT_URI,
  response_type: 'code',
  scope: SCOPES,
  access_type: 'offline',
  prompt: 'consent',
});
const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?${params}`;

// Start local server to capture the auth code
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (url.pathname !== '/callback') {
    res.end('Not found');
    return;
  }

  const code = url.searchParams.get('code');
  const error = url.searchParams.get('error');

  if (error) {
    res.end(`<h2>Authorization failed: ${error}</h2><p>Close this tab.</p>`);
    console.error('Authorization denied:', error);
    server.close();
    process.exit(1);
  }

  if (!code) {
    res.end('<h2>No code received.</h2>');
    server.close();
    process.exit(1);
  }

  // Exchange code for tokens
  try {
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id,
        client_secret,
        redirect_uri: REDIRECT_URI,
        grant_type: 'authorization_code',
      }),
    });
    const tokens = await tokenRes.json();
    if (!tokenRes.ok) throw new Error(JSON.stringify(tokens));

    tokens.expiry_date = Date.now() + tokens.expires_in * 1000;
    fs.writeFileSync(TOKENS_PATH, JSON.stringify(tokens, null, 2));

    res.end('<h2>Authorization complete! You can close this tab.</h2>');
    console.log(`\nTokens saved to ${TOKENS_PATH}`);
    console.log('Scopes authorized:', tokens.scope || SCOPES);
    console.log('\nGoogle Calendar (and Gmail) is ready. Restart NanoClaw to apply:\n  systemctl --user restart nanoclaw');
    server.close();
  } catch (err) {
    res.end(`<h2>Token exchange failed</h2><pre>${err.message}</pre>`);
    console.error('Token exchange failed:', err.message);
    server.close();
    process.exit(1);
  }
});

server.listen(PORT, () => {
  console.log(`\nOpening browser for Google authorization...`);
  console.log(`URL: ${authUrl}\n`);

  // Open browser
  try {
    const platform = process.platform;
    if (platform === 'darwin') execSync(`open "${authUrl}"`);
    else if (platform === 'linux') execSync(`xdg-open "${authUrl}" 2>/dev/null || sensible-browser "${authUrl}" 2>/dev/null || true`);
    else execSync(`start "" "${authUrl}"`);
  } catch {
    console.log('Could not open browser automatically. Please open the URL above manually.');
  }

  console.log('Waiting for authorization... (Ctrl+C to cancel)');
});
