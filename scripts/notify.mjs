#!/usr/bin/env node
// Queue a message to the NanoClaw main group via the IPC watcher.
// Usage: node scripts/notify.mjs "your message text"
// Looks up the main group (registered_groups.is_main = 1) and drops a
// {type:"message"} file into data/ipc/<folder>/messages, which the running
// NanoClaw process delivers to that chat on its next poll.
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

const text = process.argv.slice(2).join(' ').trim();
if (!text) {
  console.error('notify: no message text given');
  process.exit(1);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dbPath = path.join(root, 'store', 'messages.db');
if (!fs.existsSync(dbPath)) {
  console.error(`notify: database not found at ${dbPath}`);
  process.exit(1);
}

const db = new Database(dbPath, { readonly: true });
const main = db
  .prepare('SELECT jid, folder FROM registered_groups WHERE is_main = 1 LIMIT 1')
  .get();
if (!main) {
  console.error('notify: no main group registered — nothing to notify');
  process.exit(1);
}

const messagesDir = path.join(root, 'data', 'ipc', main.folder, 'messages');
fs.mkdirSync(messagesDir, { recursive: true });
const file = path.join(messagesDir, `sync-${Date.now()}.json`);
fs.writeFileSync(
  file,
  JSON.stringify({ type: 'message', chatJid: main.jid, text }),
);
console.log(`notify: queued message to ${main.jid}`);
