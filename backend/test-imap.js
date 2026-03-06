#!/usr/bin/env node
/**
 * Manual IMAP test – run: node test-imap.js
 * Checks connection, lists unread emails, and attempts one poll cycle.
 */
require('dotenv').config({ path: './config.env' });
const { processInbox, getImapConfig } = require('./services/imapService');

const config = getImapConfig();
console.log('IMAP config:', {
  user: config.user,
  host: config.host,
  port: config.port,
  hasPassword: !!config.pass
});

if (!config.user || !config.pass) {
  console.error('Missing GMAIL_USER or GMAIL_APP_PASSWORD in config.env');
  process.exit(1);
}

console.log('Running processInbox() once...\n');
processInbox()
  .then(() => {
    console.log('\nDone.');
    process.exit(0);
  })
  .catch((err) => {
    console.error('\nFatal error:', err?.message || err);
    process.exit(1);
  });
