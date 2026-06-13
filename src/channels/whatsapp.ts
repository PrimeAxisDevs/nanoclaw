import { exec } from 'child_process';
import fs from 'fs';
import path from 'path';

import {
  makeWASocket,
  Browsers,
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestWaWebVersion,
  jidEncode,
  makeCacheableSignalKeyStore,
  normalizeMessageContent,
  useMultiFileAuthState,
} from '@whiskeysockets/baileys';
import type {
  GroupMetadata,
  WAMessageKey,
  WASocket,
  proto as ProtoTypes,
} from '@whiskeysockets/baileys';
// proto is not statically analyzable as a named ESM export from this CJS module
import { createRequire } from 'module';
const { proto } = createRequire(import.meta.url)('@whiskeysockets/baileys') as {
  proto: typeof ProtoTypes;
};

import {
  ASSISTANT_HAS_OWN_NUMBER,
  ASSISTANT_NAME,
  GROUPS_DIR,
  STORE_DIR,
} from '../config.js';
import {
  getLastGroupSync,
  getMessageContentById,
  setLastGroupSync,
  updateChatName,
} from '../db.js';
import { isImageMessage, processImage } from '../image.js';
import { logger } from '../logger.js';
import pino from 'pino';

// Baileys requires a pino-compatible logger instance
const baileysLogger = pino({ level: 'silent' });
import {
  Channel,
  OnInboundMessage,
  OnChatMetadata,
  RegisteredGroup,
} from '../types.js';
import { registerChannel, ChannelOpts } from './registry.js';

const GROUP_SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

export interface WhatsAppChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

export class WhatsAppChannel implements Channel {
  name = 'whatsapp';

  private sock!: WASocket;
  private connected = false;
  private lidToPhoneMap: Record<string, string> = {};
  private outgoingQueue: Array<{ jid: string; text: string }> = [];
  private flushing = false;
  private groupSyncTimerStarted = false;
  /** Cache of recently sent messages for retry requests (max 256 entries). */
  private sentMessageCache = new Map<string, ProtoTypes.IMessage>();
  /** Short-lived cache of phone-normalized group metadata for outbound sends. */
  private groupMetadataCache = new Map<
    string,
    { metadata: GroupMetadata; expiresAt: number }
  >();
  /** Bot's LID user ID (e.g. "80355281346633") for normalizing group mentions. */
  private botLidUser?: string;
  /** Resolve the initial connect() once the first successful open happens. */
  private pendingFirstOpen?: () => void;
  /** Groups whose @lid participant sessions have been pre-fetched. */
  private readonly ensuredGroupSessions = new Set<string>();

  private opts: WhatsAppChannelOpts;

  constructor(opts: WhatsAppChannelOpts) {
    this.opts = opts;
  }

  async connect(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.pendingFirstOpen = resolve;
      this.connectInternal().catch(reject);
    });
  }

  private async connectInternal(): Promise<void> {
    const authDir = path.join(STORE_DIR, 'auth');
    fs.mkdirSync(authDir, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(authDir);

    const { version } = await fetchLatestWaWebVersion({}).catch((err) => {
      logger.warn(
        { err },
        'Failed to fetch latest WA Web version, using default',
      );
      return { version: undefined };
    });
    this.sock = makeWASocket({
      version,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, baileysLogger),
      },
      printQRInTerminal: false,
      logger: baileysLogger,
      browser: Browsers.macOS('Chrome'),
      syncFullHistory: false,
      markOnlineOnConnect: false,
      cachedGroupMetadata: async (jid: string) =>
        this.getNormalizedGroupMetadata(jid),
      getMessage: async (key: WAMessageKey) => {
        const cached = this.sentMessageCache.get(key.id || '');
        if (cached) {
          logger.debug(
            { id: key.id },
            'getMessage: returning cached message for retry',
          );
          return cached;
        }
        // Fall back to DB lookup so WhatsApp can re-encrypt on retry.
        // Without this, self-chat messages show "waiting for this message".
        const content =
          key.id && key.remoteJid
            ? getMessageContentById(key.id, key.remoteJid)
            : undefined;
        if (content) {
          logger.debug(
            { id: key.id },
            'getMessage: returning DB message for retry',
          );
          return proto.Message.fromObject({ conversation: content });
        }
        // Return empty message rather than undefined — prevents indefinite
        // "waiting for this message" when we genuinely don't have the content.
        return proto.Message.fromObject({});
      },
    });

    this.sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        const msg =
          'WhatsApp authentication required. Run /setup in Claude Code.';
        logger.error(msg);
        exec(
          `osascript -e 'display notification "${msg}" with title "NanoClaw" sound name "Basso"'`,
        );
        setTimeout(() => process.exit(1), 1000);
      }

      if (connection === 'close') {
        this.connected = false;
        const reason = (
          lastDisconnect?.error as { output?: { statusCode?: number } }
        )?.output?.statusCode;
        const shouldReconnect = reason !== DisconnectReason.loggedOut;
        logger.info(
          {
            reason,
            shouldReconnect,
            queuedMessages: this.outgoingQueue.length,
          },
          'Connection closed',
        );

        if (shouldReconnect) {
          this.scheduleReconnect(1);
        } else {
          // WhatsApp session logged out (401). Do NOT exit the process — a
          // single channel losing auth must not take down the whole
          // multi-channel host (Telegram, etc. keep running). `this.connected`
          // is already false above; leave WhatsApp dormant and don't
          // reconnect. Run /setup to re-authenticate and restore WhatsApp.
          logger.error(
            'WhatsApp logged out (401). WhatsApp channel disabled; other ' +
              'channels unaffected. Run /setup to re-authenticate.',
          );
        }
      } else if (connection === 'open') {
        this.connected = true;
        logger.info('Connected to WhatsApp');

        // Announce availability so WhatsApp relays subsequent presence updates (typing indicators)
        this.sock.sendPresenceUpdate('available').catch((err) => {
          logger.warn({ err }, 'Failed to send presence update');
        });

        // Build LID to phone mapping from auth state for self-chat translation
        if (this.sock.user) {
          const phoneUser = this.sock.user.id.split(':')[0];
          const lidUser = this.sock.user.lid?.split(':')[0];
          if (lidUser && phoneUser) {
            this.setLidPhoneMapping(lidUser, `${phoneUser}@s.whatsapp.net`);
            this.botLidUser = lidUser;
            logger.debug({ lidUser, phoneUser }, 'LID to phone mapping set');
          }
        }

        // Flush any messages queued while disconnected
        this.flushOutgoingQueue().catch((err) =>
          logger.error({ err }, 'Failed to flush outgoing queue'),
        );

        // Sync group metadata on startup (respects 24h cache)
        this.syncGroupMetadata().catch((err) =>
          logger.error({ err }, 'Initial group sync failed'),
        );
        // Set up daily sync timer (only once)
        if (!this.groupSyncTimerStarted) {
          this.groupSyncTimerStarted = true;
          setInterval(() => {
            this.syncGroupMetadata().catch((err) =>
              logger.error({ err }, 'Periodic group sync failed'),
            );
          }, GROUP_SYNC_INTERVAL_MS);
        }

        // Signal first connection to caller
        if (this.pendingFirstOpen) {
          this.pendingFirstOpen();
          this.pendingFirstOpen = undefined;
        }
      }
    });

    this.sock.ev.on('creds.update', saveCreds);

    this.sock.ev.on('chats.phoneNumberShare', ({ lid, jid }) => {
      const lidUser = lid?.split('@')[0].split(':')[0];
      if (lidUser && jid) {
        this.setLidPhoneMapping(lidUser, jid);
      }
    });

    this.sock.ev.on('messages.upsert', async ({ messages }) => {
      for (const msg of messages) {
        try {
          if (!msg.message) continue;
          // Unwrap container types (viewOnceMessageV2, ephemeralMessage,
          // editedMessage, etc.) so that conversation, extendedTextMessage,
          // imageMessage, etc. are accessible at the top level.
          const normalized = normalizeMessageContent(msg.message);
          if (!normalized) continue;
          const rawJid = msg.key.remoteJid;
          if (!rawJid || rawJid === 'status@broadcast') continue;

          // Translate LID JID to phone JID if applicable.
          // Prefer senderPn from the message key (available in newer WA protocol)
          // since translateJid may fail to resolve LID→phone via signalRepository.
          let chatJid = await this.translateJid(rawJid);
          if (chatJid.endsWith('@lid') && (msg.key as any).senderPn) {
            const pn = (msg.key as any).senderPn as string;
            const phoneJid = pn.includes('@') ? pn : `${pn}@s.whatsapp.net`;
            this.setLidPhoneMapping(
              rawJid.split('@')[0].split(':')[0],
              phoneJid,
            );
            chatJid = phoneJid;
            logger.info(
              { lidJid: rawJid, phoneJid },
              'Translated LID via senderPn',
            );
          }

          const timestamp = new Date(
            Number(msg.messageTimestamp) * 1000,
          ).toISOString();

          // Always notify about chat metadata for group discovery
          const isGroup = chatJid.endsWith('@g.us');
          this.opts.onChatMetadata(
            chatJid,
            timestamp,
            undefined,
            'whatsapp',
            isGroup,
          );

          // Only deliver full message for registered groups
          const groups = this.opts.registeredGroups();
          if (groups[chatJid]) {
            let content =
              normalized.conversation ||
              normalized.extendedTextMessage?.text ||
              normalized.imageMessage?.caption ||
              normalized.videoMessage?.caption ||
              '';

            // Image attachment handling
            if (isImageMessage(msg)) {
              try {
                const buffer = await downloadMediaMessage(msg, 'buffer', {});
                const groupDir = path.join(GROUPS_DIR, groups[chatJid].folder);
                const caption = normalized?.imageMessage?.caption ?? '';
                const result = await processImage(
                  buffer as Buffer,
                  groupDir,
                  caption,
                );
                if (result) {
                  content = result.content;
                }
              } catch (err) {
                logger.warn({ err, jid: chatJid }, 'Image - download failed');
              }
            }

            // WhatsApp group mentions use the LID in raw text (e.g. "@80355281346633")
            // instead of the display name. Normalize to @AssistantName for trigger matching.
            if (this.botLidUser && content.includes(`@${this.botLidUser}`)) {
              content = content.replace(
                `@${this.botLidUser}`,
                `@${ASSISTANT_NAME}`,
              );
            }

            // Skip protocol messages with no text content (encryption keys, read receipts, etc.)
            if (!content) continue;

            const sender = msg.key.participant || msg.key.remoteJid || '';
            const senderName = msg.pushName || sender.split('@')[0];

            const fromMe = msg.key.fromMe || false;
            // Detect bot messages: with own number, fromMe is reliable
            // since only the bot sends from that number.
            // With shared number, bot messages carry the assistant name prefix
            // (even in DMs/self-chat) so we check for that.
            const isBotMessage = ASSISTANT_HAS_OWN_NUMBER
              ? fromMe
              : content.startsWith(`${ASSISTANT_NAME}:`);

            this.opts.onMessage(chatJid, {
              id: msg.key.id || '',
              chat_jid: chatJid,
              sender,
              sender_name: senderName,
              content,
              timestamp,
              is_from_me: fromMe,
              is_bot_message: isBotMessage,
            });
          } else if (chatJid !== rawJid) {
            // LID translation produced a JID that doesn't match any registered group
            logger.warn(
              {
                rawJid,
                translatedJid: chatJid,
                registeredJids: Object.keys(groups),
              },
              'Message JID not found in registered groups after translation',
            );
          }
        } catch (err) {
          logger.error(
            { err, remoteJid: msg.key?.remoteJid },
            'Error processing incoming message',
          );
        }
      }
    });
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    // Prefix bot messages with assistant name so users know who's speaking.
    // On a shared number, prefix is also needed in DMs (including self-chat)
    // to distinguish bot output from user messages.
    // Skip only when the assistant has its own dedicated phone number.
    const prefixed = ASSISTANT_HAS_OWN_NUMBER
      ? text
      : `${ASSISTANT_NAME}: ${text}`;

    if (!this.connected) {
      this.outgoingQueue.push({ jid, text: prefixed });
      logger.info(
        { jid, length: prefixed.length, queueSize: this.outgoingQueue.length },
        'WA disconnected, message queued',
      );
      return;
    }
    try {
      const sent = await this.sock.sendMessage(jid, { text: prefixed });
      // Cache for retry requests (recipient may ask us to re-encrypt)
      if (sent?.key?.id && sent.message) {
        this.sentMessageCache.set(sent.key.id, sent.message);
        if (this.sentMessageCache.size > 256) {
          const oldest = this.sentMessageCache.keys().next().value!;
          this.sentMessageCache.delete(oldest);
        }
      }
      logger.info({ jid, length: prefixed.length }, 'Message sent');
    } catch (err) {
      // If send fails, queue it for retry on reconnect
      this.outgoingQueue.push({ jid, text: prefixed });
      logger.warn(
        { jid, err, queueSize: this.outgoingQueue.length },
        'Failed to send, message queued',
      );
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return (
      jid.endsWith('@g.us') ||
      jid.endsWith('@s.whatsapp.net') ||
      jid.endsWith('@lid')
    );
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    this.sock?.end(undefined);
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    try {
      const status = isTyping ? 'composing' : 'paused';
      logger.debug({ jid, status }, 'Sending presence update');
      await this.sock.sendPresenceUpdate(status, jid);
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to update typing status');
    }
  }

  async syncGroups(force: boolean): Promise<void> {
    return this.syncGroupMetadata(force);
  }

  /**
   * Sync group metadata from WhatsApp.
   * Fetches all participating groups and stores their names in the database.
   * Called on startup, daily, and on-demand via IPC.
   */
  async syncGroupMetadata(force = false): Promise<void> {
    if (!force) {
      const lastSync = getLastGroupSync();
      if (lastSync) {
        const lastSyncTime = new Date(lastSync).getTime();
        if (Date.now() - lastSyncTime < GROUP_SYNC_INTERVAL_MS) {
          logger.debug({ lastSync }, 'Skipping group sync - synced recently');
          return;
        }
      }
    }

    try {
      logger.info('Syncing group metadata from WhatsApp...');
      const groups = await this.sock.groupFetchAllParticipating();

      let count = 0;
      for (const [jid, metadata] of Object.entries(groups)) {
        if (metadata.subject) {
          updateChatName(jid, metadata.subject);
          count++;
        }
      }

      setLastGroupSync();
      logger.info({ count }, 'Group metadata synced');
    } catch (err) {
      logger.error({ err }, 'Failed to sync group metadata');
    }
  }

  private scheduleReconnect(attempt: number): void {
    this.ensuredGroupSessions.clear();
    const delayMs = Math.min(5000 * Math.pow(2, attempt - 1), 300000);
    logger.info({ attempt, delayMs }, 'Reconnecting...');
    setTimeout(() => {
      this.connectInternal().catch((err) => {
        logger.error({ err, attempt }, 'Reconnection attempt failed');
        this.scheduleReconnect(attempt + 1);
      });
    }, delayMs);
  }

  private async translateJid(jid: string): Promise<string> {
    if (!jid.endsWith('@lid')) return jid;
    const lidUser = jid.split('@')[0].split(':')[0];

    // Check local cache first
    const cached = this.lidToPhoneMap[lidUser];
    if (cached) {
      logger.debug(
        { lidJid: jid, phoneJid: cached },
        'Translated LID to phone JID (cached)',
      );
      return cached;
    }

    // Query Baileys' signal repository for the mapping
    try {
      const pn = await (
        this.sock.signalRepository as any
      )?.lidMapping?.getPNForLID(jid);
      if (pn) {
        const phoneJid = `${pn.split('@')[0].split(':')[0]}@s.whatsapp.net`;
        this.setLidPhoneMapping(lidUser, phoneJid);
        logger.info(
          { lidJid: jid, phoneJid },
          'Translated LID to phone JID (signalRepository)',
        );
        return phoneJid;
      }
    } catch (err) {
      logger.debug({ err, jid }, 'Failed to resolve LID via signalRepository');
    }

    return jid;
  }

  private setLidPhoneMapping(lidUser: string, phoneJid: string): void {
    if (this.lidToPhoneMap[lidUser] === phoneJid) return;
    this.lidToPhoneMap[lidUser] = phoneJid;
    // Participant IDs in cached group metadata depend on this mapping.
    this.groupMetadataCache.clear();
  }

  private async getNormalizedGroupMetadata(
    jid: string,
    forceRefresh = false,
  ): Promise<GroupMetadata | undefined> {
    if (!jid.endsWith('@g.us')) return undefined;

    const cached = this.groupMetadataCache.get(jid);
    if (!forceRefresh && cached && cached.expiresAt > Date.now()) {
      return cached.metadata;
    }

    const metadata = await this.sock.groupMetadata(jid);

    logger.info(
      { jid, participantCount: metadata.participants.length },
      'Fetched group metadata for send',
    );

    this.groupMetadataCache.set(jid, {
      metadata,
      expiresAt: Date.now() + 60_000,
    });
    return metadata;
  }

  /**
   * Pre-fetch Signal sessions for @lid group participants before sending.
   *
   * Baileys hardcodes @s.whatsapp.net for participant session JIDs in groups
   * (isLid is based on the group JID, which is @g.us, not the participant JID).
   * So Baileys' internal assertSessions call uses @s.whatsapp.net — which WA's
   * encrypt endpoint doesn't recognise for LID users → no prekeys → participant skipped.
   *
   * Fix: pre-fetch sessions using the correct @lid device JIDs. Signal sessions
   * are keyed by the numeric user.device (not the @server suffix), so the session
   * stored under "12345.0@lid" is found when Baileys later checks "12345.0@s.whatsapp.net".
   * Using force=false ensures we only fetch missing sessions, never reset existing ones.
   */
  private async ensureGroupSessions(jid: string): Promise<void> {
    if (this.ensuredGroupSessions.has(jid)) return;
    try {
      const metadata = await this.sock.groupMetadata(jid);
      const lidParticipants = metadata.participants
        .map((p) => p.id)
        .filter((id) => id.endsWith('@lid'));

      if (lidParticipants.length > 0) {
        const devices = await this.sock.getUSyncDevices(
          lidParticipants,
          false,
          false,
        );
        // Extract bot's own LID user and device to exclude from pre-fetch.
        // Establishing a Signal session with our own device confuses the sender
        // key distribution — Baileys may try to distribute to itself, producing
        // an invalid self-referential session and blocking message delivery.
        const botLidParts = this.sock.user?.lid?.split(':');
        const botLidUser = botLidParts?.[0];
        const botLidDevice = botLidParts
          ? parseInt(botLidParts[1]?.split('@')[0] ?? '0', 10)
          : -1;

        const deviceJids = devices
          .filter(({ user, device }) => {
            // Skip bot's own LID device
            if (
              botLidUser &&
              user === botLidUser &&
              (device ?? 0) === botLidDevice
            ) {
              return false;
            }
            return true;
          })
          .map(({ user, device }) => jidEncode(user, 'lid', device || 0));

        if (deviceJids.length > 0) {
          logger.info(
            { jid, deviceCount: deviceJids.length },
            'Pre-fetching Signal sessions for LID participant devices',
          );
          // force=false: only fetch sessions that don't already exist.
          // force=true would reset existing sessions and cause Bad MAC errors.
          await this.sock.assertSessions(deviceJids, false);
        }
      }

      this.ensuredGroupSessions.add(jid);
    } catch (err) {
      logger.warn({ err, jid }, 'Failed to pre-fetch group sessions');
    }
  }

  private async flushOutgoingQueue(): Promise<void> {
    if (this.flushing || this.outgoingQueue.length === 0) return;
    this.flushing = true;
    try {
      logger.info(
        { count: this.outgoingQueue.length },
        'Flushing outgoing message queue',
      );
      while (this.outgoingQueue.length > 0) {
        const item = this.outgoingQueue.shift()!;
        // Send directly — queued items are already prefixed by sendMessage
        const sent = await this.sock.sendMessage(item.jid, { text: item.text });
        if (sent?.key?.id && sent.message) {
          this.sentMessageCache.set(sent.key.id, sent.message);
        }
        logger.info(
          { jid: item.jid, length: item.text.length },
          'Queued message sent',
        );
      }
    } finally {
      this.flushing = false;
    }
  }
}

registerChannel('whatsapp', (opts: ChannelOpts) => new WhatsAppChannel(opts));
