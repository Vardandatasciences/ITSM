/**
 * IMAP Email Service – Incoming email → Auto-create tickets
 *
 * Polls inbox, parses from/subject/body, creates tickets, marks as read.
 * - Filters out emails from system address to avoid loops
 * - Duplicate detection: same sender + subject within 24h
 */

const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const { pool } = require('../database');
const emailService = require('./emailService');
const TicketAssignmentService = require('../utils/ticketAssignment');
require('dotenv').config({ path: './config.env' });

const POLL_INTERVAL_MS = parseInt(process.env.IMAP_POLL_INTERVAL_MS) || 60000; // 1 min default
const DEFAULT_TENANT_ID = 1;

function getImapConfig() {
  const user = process.env.GMAIL_USER || process.env.SMTP_EMAIL || process.env.EMAIL_USER;
  const pass = process.env.GMAIL_APP_PASSWORD || process.env.SMTP_PASSWORD || process.env.EMAIL_PASS;
  const host = process.env.IMAP_SERVER || 'imap.gmail.com';
  const port = parseInt(process.env.IMAP_PORT) || 993;
  return { user, pass, host, port };
}

function getSystemEmail() {
  return (
    (process.env.GMAIL_USER || process.env.SMTP_EMAIL || process.env.EMAIL_FROM_ADDRESS || process.env.EMAIL_USER || '')
      .toLowerCase()
      .trim()
  );
}

function extractTextOrHtml(parsed) {
  if (parsed.text) return parsed.text.trim();
  if (parsed.html) {
    return parsed.html
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }
  return '';
}

function extractSenderEmail(parsed) {
  const from = parsed.from;
  if (!from) return null;
  const addr = from.value && from.value[0];
  if (addr && addr.address) return addr.address.toLowerCase().trim();
  return null;
}

function extractSenderName(parsed) {
  const from = parsed.from;
  if (!from) return '';
  const addr = from.value && from.value[0];
  if (addr && addr.name) return addr.name.trim();
  if (addr && addr.address) return addr.address.split('@')[0] || '';
  return '';
}

async function isDuplicate(senderEmail, subject) {
  try {
    const [rows] = await pool.execute(
      `SELECT id FROM tickets 
       WHERE LOWER(email) = LOWER(?) AND issue_title = ? 
       AND created_at > DATE_SUB(NOW(), INTERVAL 24 HOUR) 
       LIMIT 1`,
      [senderEmail, subject]
    );
    return rows.length > 0;
  } catch {
    return true; // treat as duplicate on error to avoid creating duplicates
  }
}

async function createTicketFromEmail(senderEmail, senderName, subject, body, tenantId = DEFAULT_TENANT_ID) {
  try {
    const [result] = await pool.execute(
      `INSERT INTO tickets (tenant_id, user_id, name, email, mobile, product, product_id, module, module_id, description, issue_type, issue_title, status) 
       VALUES (?, NULL, ?, ?, NULL, NULL, NULL, NULL, NULL, ?, 'email', ?, 'new')`,
      [tenantId, senderName || senderEmail.split('@')[0], senderEmail, body || '(no body)', subject]
    );
    const ticketId = result.insertId;
    try {
      await TicketAssignmentService.assignTicketEqually(ticketId, null, tenantId);
    } catch {
      // Auto-assignment failed, ticket still created
    }
    return ticketId;
  } catch (err) {
    console.error('❌ IMAP createTicketFromEmail error:', err?.message || err);
    return null;
  }
}

async function processInbox() {
  const config = getImapConfig();
  const systemEmail = getSystemEmail();

  if (!config.user || !config.pass) return;

  const client = new ImapFlow({
    host: config.host,
    port: config.port,
    secure: true,
    auth: { user: config.user, pass: config.pass },
    logger: false
  });

  client.on('error', (err) => {
    console.error('❌ IMAP client error:', err?.message || err);
  });

  try {
    await client.connect();
    let lock;
    try {
      lock = await client.getMailboxLock('INBOX');
    } catch (lockErr) {
      console.error('❌ IMAP: Failed to lock INBOX:', lockErr?.message);
      return;
    }

    let messages = [];
    try {
      const uids = await client.search({ seen: false });
      if (uids && uids.length > 0) {
        console.log(`📬 IMAP: Found ${uids.length} unread email(s) – fetching...`);
      }
      for await (const msg of client.fetch(uids, { uid: true, source: true })) {
        messages.push({ uid: msg.uid, source: msg.source });
      }
    } finally {
      lock.release();
    }
    await client.logout();

    // Process messages offline (no IMAP connection) to avoid socket timeout
    const uidsToMarkRead = [];
    for (let i = 0; i < messages.length; i++) {
      const { uid, source } = messages[i];
      try {
        if ((i + 1) % 10 === 0 || i + 1 === messages.length) {
          console.log(`📬 IMAP: Processing ${i + 1}/${messages.length}...`);
        }
        const parsed = await simpleParser(source);
        const senderEmail = extractSenderEmail(parsed);
        const senderName = extractSenderName(parsed);
        const subject = (parsed.subject || 'No subject').trim();
        const body = extractTextOrHtml(parsed);

        if (!senderEmail) {
          uidsToMarkRead.push(uid);
          continue;
        }

        if (senderEmail === systemEmail) {
          console.log(`📬 IMAP: Skipped (from self): ${subject}`);
          uidsToMarkRead.push(uid);
          continue;
        }

        console.log(`📬 IMAP: Processing: ${senderEmail} – "${subject}"`);

        if (await isDuplicate(senderEmail, subject)) {
          console.log(`📬 IMAP: Skipped (duplicate): ${senderEmail} - "${subject}"`);
          uidsToMarkRead.push(uid);
          continue;
        }

        const ticketId = await createTicketFromEmail(senderEmail, senderName, subject, body);
        if (ticketId) {
          console.log(`✅ IMAP: Created ticket #${ticketId} from ${senderEmail}: "${subject}"`);
          await emailService.sendTicketConfirmation(
            senderEmail,
            senderName,
            ticketId,
            subject,
            emailService.getAppUrl()
          );
        } else {
          console.error(`❌ IMAP: Failed to create ticket for ${senderEmail}: "${subject}"`);
        }
        uidsToMarkRead.push(uid);
      } catch (msgErr) {
        console.warn('⚠️ IMAP: Failed to process message:', msgErr?.message);
        uidsToMarkRead.push(uid);
      }
    }

    // Reconnect briefly to mark as read
    if (uidsToMarkRead.length > 0) {
      const client2 = new ImapFlow({
        host: config.host,
        port: config.port,
        secure: true,
        auth: { user: config.user, pass: config.pass },
        logger: false
      });
      try {
        await client2.connect();
        const lock2 = await client2.getMailboxLock('INBOX');
        try {
          for (const uid of uidsToMarkRead) {
            await client2.messageFlagsAdd({ uid }, ['\\Seen']);
          }
        } finally {
          lock2.release();
        }
        await client2.logout();
      } catch (markErr) {
        console.warn('⚠️ IMAP: Could not mark messages as read:', markErr?.message);
      }
    }
  } catch (err) {
    console.error('❌ IMAP connection/process failed:', err?.message || err);
    if (err?.message?.includes('Invalid credentials') || err?.message?.includes('Authentication failed')) {
      console.warn('💡 Tip: Use a Gmail App Password (not regular password). Enable IMAP in Gmail settings.');
    }
  } finally {
    try {
      if (client.usable) {
        await client.logout();
      }
    } catch (e) {
      // Ignore logout errors when connection already dead
    }
  }
}

let pollIntervalId = null;

function startImapPoller() {
  const config = getImapConfig();
  if (!config.user || !config.pass) {
    console.warn('⚠️ IMAP poller NOT started: GMAIL_USER and GMAIL_APP_PASSWORD (or SMTP credentials) required');
    return;
  }
  console.log(`📬 IMAP poller started – checking ${config.user} every ${POLL_INTERVAL_MS / 1000}s`);

  if (pollIntervalId) clearInterval(pollIntervalId);

  processInbox().catch((err) => console.error('❌ IMAP poll error:', err?.message || err));
  pollIntervalId = setInterval(() => {
    processInbox().catch((err) => console.error('❌ IMAP poll error:', err?.message || err));
  }, POLL_INTERVAL_MS);
}

function stopImapPoller() {
  if (pollIntervalId) {
    clearInterval(pollIntervalId);
    pollIntervalId = null;
  }
}

module.exports = {
  processInbox,
  startImapPoller,
  stopImapPoller,
  getImapConfig,
  getSystemEmail
};
