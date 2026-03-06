#!/usr/bin/env node
/**
 * Verify IMAP email-to-ticket flow:
 * 1. Run processInbox() to process any pending emails
 * 2. Find tickets from nandhu7246@gmail.com with subject "ticket test creation"
 * 3. Check if assigned properly
 */
require('dotenv').config({ path: './config.env' });
const { pool } = require('./database');
const { processInbox } = require('./services/imapService');

const SENDER_EMAIL = 'nandhu7246@gmail.com';
const SUBJECT_MATCH = 'ticket test creation';

async function verify() {
  console.log('=== IMAP Email-to-Ticket Verification ===\n');

  // Step 1: Process inbox to pick up any new emails
  console.log('1️⃣ Processing IMAP inbox...');
  await processInbox().catch((e) => console.error('IMAP error:', e?.message));
  console.log('');

  // Step 2: Find matching tickets
  console.log('2️⃣ Looking for tickets from', SENDER_EMAIL, 'with subject containing "' + SUBJECT_MATCH + '"...');
  const [tickets] = await pool.execute(
    `SELECT id, issue_title, email, name, status, assigned_to, created_at 
     FROM tickets 
     WHERE LOWER(email) = LOWER(?) AND issue_title LIKE ? 
     ORDER BY created_at DESC`,
    [SENDER_EMAIL, `%${SUBJECT_MATCH}%`]
  );

  if (tickets.length === 0) {
    console.log('   ❌ No matching ticket found.');
    console.log('   - Ensure the email was sent to the configured ITSM inbox.');
    console.log('   - Run again after sending the email (or wait for the next IMAP poll).');
    process.exit(1);
  }

  console.log(`   ✅ Found ${tickets.length} ticket(s)\n`);

  for (const t of tickets) {
    console.log('   Ticket #' + t.id);
    console.log('   - Subject:', t.issue_title);
    console.log('   - Sender:', t.email, '(' + t.name + ')');
    console.log('   - Status:', t.status);
    console.log('   - Created:', t.created_at);

    // Step 3: Check assignment
    if (t.assigned_to) {
      const [agents] = await pool.execute(
        'SELECT id, name, email FROM agents WHERE id = ?',
        [t.assigned_to]
      );
      const agent = agents[0];
      console.log('   - Assigned to:', agent ? `${agent.name} (ID ${agent.id})` : `Agent ID ${t.assigned_to}`);
    } else {
      console.log('   - Assigned to: ❌ NOT ASSIGNED');
    }

    const [assignments] = await pool.execute(
      'SELECT agent_id, is_active, created_at FROM ticket_assignments WHERE ticket_id = ?',
      [t.id]
    );
    if (assignments.length > 0) {
      console.log('   - ticket_assignments:', assignments.length, 'record(s)');
    }
    console.log('');
  }

  console.log('3️⃣ Notification:');
  console.log('   - Confirmation email is sent via sendTicketConfirmation() when a ticket is created.');
  console.log('   - Check the sender inbox (and spam) for "Support Ticket #X Created".');
  console.log('   - If not received, verify SMTP_EMAIL / SMTP_PASSWORD in config.env.\n');
  console.log('=== Verification complete ===');
  process.exit(0);
}

verify().catch((e) => {
  console.error('Error:', e?.message || e);
  process.exit(1);
});
