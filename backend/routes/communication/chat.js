const express = require('express');
const router = express.Router();
const { pool } = require('../../database');
const { authenticateToken } = require('../../middleware/auth');
const { setTenantContext, verifyTenantAccess } = require('../../middleware/tenant');
const emailService = require('../../services/emailService');
const { sendAgentReplyNotification } = require('../../utils/whatsapp-notifications');

// Apply tenant context to all routes
router.use(setTenantContext);

// Get all chat messages for a ticket
router.get('/messages/:ticketId', authenticateToken, verifyTenantAccess, async (req, res) => {
  try {
    const { ticketId } = req.params;
    let tenantId = req.tenantId;
    
    // Validate ticketId
    if (!ticketId || isNaN(ticketId)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid ticket ID'
      });
    }

    // First check if ticket exists (tenant-filtered)
    let [tickets] = await pool.execute(
      'SELECT id, name, issue_title, tenant_id, user_id, email FROM tickets WHERE id = ? AND tenant_id = ?',
      [ticketId, tenantId]
    );

    // Fallback for customers: ticket may have different tenant_id (e.g. tenant 1 vs 2)
    if (tickets.length === 0 && req.user && (req.user.role === 'user' || req.user.role === 'customer')) {
      [tickets] = await pool.execute(
        'SELECT id, name, issue_title, tenant_id, user_id, email FROM tickets WHERE id = ?',
        [ticketId]
      );
      if (tickets.length > 0) {
        const ticket = tickets[0];
        const isOwner = (ticket.user_id && parseInt(ticket.user_id) === parseInt(req.user.id)) ||
          (ticket.email && ticket.email.toLowerCase() === (req.user.email || '').toLowerCase());
        if (isOwner) {
          tenantId = ticket.tenant_id || tenantId || 1;
        } else {
          return res.status(404).json({ success: false, message: 'Ticket not found' });
        }
      }
    }

    if (tickets.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Ticket not found'
      });
    }

    let messages = [];
    try {
      const [chatRows] = await pool.execute(`
        SELECT id, ticket_id, sender_type, sender_id, sender_name, message, message_type,
               is_read, read_at, is_edited, edited_at, parent_message_id, created_at, updated_at
        FROM chat_messages
        WHERE ticket_id = ? AND tenant_id = ?
        ORDER BY created_at ASC
      `, [ticketId, tenantId]);
      messages = chatRows;
    } catch (cmErr) {
      if (cmErr.code !== 'ER_BAD_FIELD_ERROR') throw cmErr;
    }

    // Fallback: use replies table for legacy tickets (no chat_messages)
    if (messages.length === 0) {
      try {
        const [replyRows] = await pool.execute(
          'SELECT id, ticket_id, message, sent_at, is_customer_reply, customer_name, agent_name FROM replies WHERE ticket_id = ? ORDER BY sent_at ASC',
          [ticketId]
        );
        messages = replyRows.map(r => ({
          id: r.id,
          ticket_id: r.ticket_id,
          sender_type: r.is_customer_reply ? 'customer' : 'agent',
          sender_name: r.is_customer_reply ? (r.customer_name || 'Customer') : (r.agent_name || 'Agent'),
          message: r.message,
          created_at: r.sent_at
        }));
      } catch (e) {
        console.warn('Fallback replies fetch failed:', e.message);
      }
    }
    
    res.json({
      success: true,
      data: messages,
      ticket: tickets[0]
    });
  } catch (error) {
    console.error('Error fetching chat messages:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to fetch chat messages',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Add a new chat message
router.post('/messages', authenticateToken, verifyTenantAccess, async (req, res) => {
  try {
    const tenantId = req.tenantId;
    const { 
      ticketId, 
      senderType, 
      senderId, 
      senderName, 
      message, 
      messageType = 'text',
      parentMessageId = null 
    } = req.body;
    
    // Validate required fields
    if (!ticketId || !senderType || !senderName || !message) {
      return res.status(400).json({
        success: false,
        message: 'Missing required fields: ticketId, senderType, senderName, message'
      });
    }

    // Validate senderType
    if (!['agent', 'customer', 'system'].includes(senderType)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid senderType. Must be agent, customer, or system'
      });
    }

    // Validate messageType
    if (!['text', 'system', 'status_update', 'typing_indicator'].includes(messageType)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid messageType'
      });
    }

    // Check if ticket exists (tenant-filtered)
    const [tickets] = await pool.execute(
      'SELECT id FROM tickets WHERE id = ? AND tenant_id = ?',
      [ticketId, tenantId]
    );

    if (tickets.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Ticket not found'
      });
    }

    // If parentMessageId is provided, validate it exists (tenant-filtered)
    if (parentMessageId) {
      const [parentMessages] = await pool.execute(
        'SELECT id FROM chat_messages WHERE id = ? AND ticket_id = ? AND tenant_id = ?',
        [parentMessageId, ticketId, tenantId]
      );

      if (parentMessages.length === 0) {
        return res.status(400).json({
          success: false,
          message: 'Parent message not found or does not belong to this ticket'
        });
      }
    }
    
    // Insert the message (with tenant_id)
    const [result] = await pool.execute(`
      INSERT INTO chat_messages (
        tenant_id,
        ticket_id, 
        sender_type, 
        sender_id, 
        sender_name, 
        message, 
        message_type,
        parent_message_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `, [tenantId, ticketId, senderType, senderId, senderName, message, messageType, parentMessageId]);
    
    // Get the inserted message with full details
    const [messages] = await pool.execute(`
      SELECT 
        cm.id,
        cm.ticket_id,
        cm.sender_type,
        cm.sender_id,
        cm.sender_name,
        cm.message,
        cm.message_type,
        cm.is_read,
        cm.read_at,
        cm.is_edited,
        cm.edited_at,
        cm.parent_message_id,
        cm.created_at,
        cm.updated_at
      FROM chat_messages cm
      WHERE cm.id = ?
    `, [result.insertId]);

    // Send email notification if agent replied to customer
    if (senderType === 'agent' && messageType === 'text') {
      try {
        // Get ticket and customer details
        const [ticketDetails] = await pool.execute(`
          SELECT 
            t.id,
            t.issue_title,
            t.user_id,
            u.email,
            u.name as customer_name,
            u.email_notifications
          FROM tickets t
          JOIN users u ON t.user_id = u.id
          WHERE t.id = ?
        `, [ticketId]);

        if (ticketDetails.length > 0) {
          const ticket = ticketDetails[0];
          
          // Only send email if customer has email notifications enabled (default to true if null)
          if (ticket.email_notifications === null || ticket.email_notifications === undefined || ticket.email_notifications === 1 || ticket.email_notifications === true) {
            // Send email notification
            const emailResult = await emailService.sendAgentReplyNotification(
              ticket.email,
              ticket.customer_name || 'Customer',
              ticket.id,
              ticket.issue_title,
              senderName,
              message
            );

            if (emailResult.success) {
              console.log(`✅ Email notification sent to ${ticket.email} for ticket #${ticket.id}`);
            } else {
              console.error(`❌ Failed to send email notification: ${emailResult.error}`);
            }
          } else {
            console.log(`📵 Email notifications disabled for user ${ticket.email} - skipping notification`);
          }
        }
      } catch (emailError) {
        console.error('❌ Error sending email notification:', emailError);
        // Don't fail the chat message creation if email fails
      }
    }

    // Send WhatsApp notification based on agent flag (1 = agent, 0 = customer)
    if (messageType === 'text') {
      // Check if this is an agent message using the agent flag
      const isAgentMessage = req.body.agentFlag === 1 || req.body.agentFlag === '1';
      
      if (isAgentMessage) {
        console.log(`🔔 Agent flag detected (${req.body.agentFlag}) - sending WhatsApp notification for ticket #${ticketId}`);
        
        try {
          // Get ticket details including mobile number
          const [ticketDetails] = await pool.execute(`
            SELECT 
              t.id,
              t.issue_title,
              t.mobile
            FROM tickets t
            WHERE t.id = ?
          `, [ticketId]);

          console.log(`📱 Ticket details found:`, ticketDetails[0]);

          if (ticketDetails.length > 0 && ticketDetails[0].mobile) {
            const ticket = ticketDetails[0];
            console.log(`📱 Mobile number found: ${ticket.mobile}`);
            
            // Send WhatsApp notification
            const whatsappResult = await sendAgentReplyNotification(
              ticket,
              senderName,
              message
            );

            if (whatsappResult) {
              console.log(`✅ WhatsApp notification sent successfully to ${ticket.mobile} for ticket #${ticket.id}`);
            } else {
              console.log(`⚠️ Failed to send WhatsApp notification to ${ticket.mobile} for ticket #${ticket.id}`);
            }
          } else {
            console.log(`📵 No mobile number found for ticket #${ticketId}`);
          }
        } catch (whatsappError) {
          console.error('⚠️ Error sending WhatsApp notification:', whatsappError);
          // Don't fail the message creation if WhatsApp notification fails
        }
      } else {
        console.log(`📝 Skipping WhatsApp notification - agent flag is ${req.body.agentFlag || 'not set'} (customer message)`);
      }
    }
    
    res.status(201).json({
      success: true,
      message: 'Chat message added successfully',
      data: messages[0]
    });
  } catch (error) {
    console.error('Error adding chat message:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to add chat message',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Mark messages as read
router.put('/messages/read/:ticketId', authenticateToken, verifyTenantAccess, async (req, res) => {
  try {
    const tenantId = req.tenantId;
    const { ticketId } = req.params;
    const { userId, userType } = req.body;
    
    // Validate inputs
    if (!ticketId || isNaN(ticketId)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid ticket ID'
      });
    }

    if (!userType || !['agent', 'customer'].includes(userType)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid userType. Must be agent or customer'
      });
    }

    // Check if ticket exists (tenant-filtered)
    const [tickets] = await pool.execute(
      'SELECT id FROM tickets WHERE id = ? AND tenant_id = ?',
      [ticketId, tenantId]
    );

    if (tickets.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Ticket not found'
      });
    }
    
    // Mark messages from other users as read (tenant-filtered)
    const [result] = await pool.execute(`
      UPDATE chat_messages 
      SET is_read = TRUE, read_at = NOW()
      WHERE ticket_id = ? 
      AND tenant_id = ?
      AND sender_type != ? 
      AND is_read = FALSE
    `, [ticketId, tenantId, userType]);
    
    res.json({
      success: true,
      message: 'Messages marked as read',
      data: {
        updatedCount: result.affectedRows
      }
    });
  } catch (error) {
    console.error('Error marking messages as read:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to mark messages as read',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Get chat session for a ticket
router.get('/session/:ticketId', authenticateToken, verifyTenantAccess, async (req, res) => {
  try {
    const tenantId = req.tenantId;
    const { ticketId } = req.params;
    
    // Validate ticketId
    if (!ticketId || isNaN(ticketId)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid ticket ID'
      });
    }

    // Check if ticket exists (tenant-filtered)
    const [tickets] = await pool.execute(
      'SELECT id FROM tickets WHERE id = ? AND tenant_id = ?',
      [ticketId, tenantId]
    );

    if (tickets.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Ticket not found'
      });
    }
    
    const [sessions] = await pool.execute(`
      SELECT 
        cs.*,
        cp.user_id,
        cp.user_type,
        cp.user_name,
        cp.is_typing,
        cp.last_typing_at
      FROM chat_sessions cs
      LEFT JOIN chat_participants cp ON cs.session_id = cp.session_id AND cp.tenant_id = ?
      WHERE cs.ticket_id = ? AND cs.tenant_id = ? AND cs.status = 'active'
      ORDER BY cp.joined_at ASC
    `, [tenantId, ticketId, tenantId]);
    
    res.json({
      success: true,
      data: sessions
    });
  } catch (error) {
    console.error('Error fetching chat session:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to fetch chat session',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Create or join chat session
router.post('/session', authenticateToken, verifyTenantAccess, async (req, res) => {
  try {
    const tenantId = req.tenantId;
    const { ticketId, userId, userType, userName } = req.body;
    
    // Validate inputs
    if (!ticketId || !userType || !userName) {
      return res.status(400).json({
        success: false,
        message: 'Missing required fields: ticketId, userType, userName'
      });
    }

    if (!['agent', 'customer'].includes(userType)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid userType. Must be agent or customer'
      });
    }

    // Check if ticket exists (tenant-filtered)
    const [tickets] = await pool.execute(
      'SELECT id FROM tickets WHERE id = ? AND tenant_id = ?',
      [ticketId, tenantId]
    );

    if (tickets.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Ticket not found'
      });
    }
    
    // Check if active session exists (tenant-filtered)
    let [sessions] = await pool.execute(`
      SELECT session_id FROM chat_sessions 
      WHERE ticket_id = ? AND tenant_id = ? AND status = 'active'
      LIMIT 1
    `, [ticketId, tenantId]);
    
    let sessionId;
    
    if (sessions.length === 0) {
      // Create new session (with tenant_id)
      sessionId = `session_${ticketId}_${Date.now()}`;
      await pool.execute(`
        INSERT INTO chat_sessions (tenant_id, ticket_id, session_id, ${userType}_id, last_activity_at)
        VALUES (?, ?, ?, ?, NOW())
      `, [tenantId, ticketId, sessionId, userId]);
    } else {
      sessionId = sessions[0].session_id;
      
      // Update last activity
      await pool.execute(`
        UPDATE chat_sessions 
        SET last_activity_at = NOW() 
        WHERE session_id = ? AND tenant_id = ?
      `, [sessionId, tenantId]);
    }
    
    // Add or update participant (with tenant_id)
    await pool.execute(`
      INSERT INTO chat_participants (tenant_id, session_id, user_id, user_type, user_name, joined_at)
      VALUES (?, ?, ?, ?, ?, NOW())
      ON DUPLICATE KEY UPDATE 
        left_at = NULL,
        joined_at = NOW(),
        is_typing = FALSE
    `, [tenantId, sessionId, userId, userType, userName]);
    
    res.json({
      success: true,
      message: 'Joined chat session',
      data: { sessionId }
    });
  } catch (error) {
    console.error('Error joining chat session:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to join chat session',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Update typing status
router.put('/typing', authenticateToken, verifyTenantAccess, async (req, res) => {
  try {
    const tenantId = req.tenantId;
    const { sessionId, userId, userType, isTyping } = req.body;
    
    // Validate inputs
    if (!sessionId || !userType || typeof isTyping !== 'boolean') {
      return res.status(400).json({
        success: false,
        message: 'Missing required fields: sessionId, userType, isTyping'
      });
    }

    if (!['agent', 'customer'].includes(userType)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid userType. Must be agent or customer'
      });
    }

    // Check if session exists (tenant-filtered)
    const [sessions] = await pool.execute(
      'SELECT session_id FROM chat_sessions WHERE session_id = ? AND tenant_id = ? AND status = \'active\'',
      [sessionId, tenantId]
    );

    if (sessions.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Chat session not found or inactive'
      });
    }
    
    await pool.execute(`
      UPDATE chat_participants 
      SET is_typing = ?, last_typing_at = ?
      WHERE session_id = ? AND tenant_id = ? AND user_id = ? AND user_type = ?
    `, [isTyping, isTyping ? new Date() : null, sessionId, tenantId, userId, userType]);
    
    res.json({
      success: true,
      message: 'Typing status updated'
    });
  } catch (error) {
    console.error('Error updating typing status:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to update typing status',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Leave chat session
router.put('/session/leave', authenticateToken, verifyTenantAccess, async (req, res) => {
  try {
    const tenantId = req.tenantId;
    const { sessionId, userId, userType } = req.body;
    
    // Validate inputs
    if (!sessionId || !userType) {
      return res.status(400).json({
        success: false,
        message: 'Missing required fields: sessionId, userType'
      });
    }

    if (!['agent', 'customer'].includes(userType)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid userType. Must be agent or customer'
      });
    }
    
    await pool.execute(`
      UPDATE chat_participants 
      SET left_at = NOW()
      WHERE session_id = ? AND tenant_id = ? AND user_id = ? AND user_type = ?
    `, [sessionId, tenantId, userId, userType]);
    
    res.json({
      success: true,
      message: 'Left chat session'
    });
  } catch (error) {
    console.error('Error leaving chat session:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to leave chat session',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Get unread message count for a user
router.get('/unread/:ticketId/:userType', authenticateToken, verifyTenantAccess, async (req, res) => {
  try {
    const tenantId = req.tenantId;
    const { ticketId, userType } = req.params;
    
    // Validate inputs
    if (!ticketId || isNaN(ticketId)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid ticket ID'
      });
    }

    if (!['agent', 'customer'].includes(userType)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid userType. Must be agent or customer'
      });
    }

    // Check if ticket exists (tenant-filtered)
    const [tickets] = await pool.execute(
      'SELECT id FROM tickets WHERE id = ? AND tenant_id = ?',
      [ticketId, tenantId]
    );

    if (tickets.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Ticket not found'
      });
    }
    
    const [messages] = await pool.execute(`
      SELECT COUNT(*) as count
      FROM chat_messages 
      WHERE ticket_id = ? 
      AND tenant_id = ?
      AND sender_type != ? 
      AND is_read = FALSE
    `, [ticketId, tenantId, userType]);
    
    res.json({
      success: true,
      data: { unreadCount: messages[0].count }
    });
  } catch (error) {
    console.error('Error fetching unread count:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to fetch unread count',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

module.exports = router; 