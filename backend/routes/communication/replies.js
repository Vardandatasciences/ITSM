const express = require('express');
const { body, validationResult } = require('express-validator');
const { pool } = require('../../database');
const { authenticateToken, authorizeRole } = require('../../middleware/auth');
const { setTenantContext, verifyTenantAccess } = require('../../middleware/tenant');
const TextFormatter = require('../../utils/textFormatter');
const { sendAgentReplyNotification } = require('../../utils/whatsapp-notifications');

const router = express.Router();

// Apply tenant context to all routes
router.use(setTenantContext);



// GET /api/replies/:ticketId - Get all replies for a ticket
router.get('/:ticketId', authenticateToken, verifyTenantAccess, async (req, res) => {
  try {
    const { ticketId } = req.params;
    const tenantId = req.tenantId;
    
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
    
    // Get replies for this ticket (tenant-filtered)
    const [replies] = await pool.execute(
      'SELECT * FROM replies WHERE ticket_id = ? AND tenant_id = ? ORDER BY sent_at ASC',
      [ticketId, tenantId]
    );
    
    res.json({
      success: true,
      data: replies
    });
  } catch (error) {
    console.error('Error fetching replies:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch replies'
    });
  }
});

// POST /api/replies - Add a reply to a ticket
router.post('/', authenticateToken, verifyTenantAccess, async (req, res) => {
  try {
    const tenantId = req.tenantId;
    const { ticketId, agentName, message, isCustomerReply = false, customerName } = req.body;
    
    // Check if ticket exists and get ticket details (tenant-filtered)
    const [tickets] = await pool.execute(
      'SELECT id, name, mobile, issue_title FROM tickets WHERE id = ? AND tenant_id = ?',
      [ticketId, tenantId]
    );
    
    if (tickets.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Ticket not found'
      });
    }
    
    const ticket = tickets[0];
    
    // Insert reply - handle both agent and customer replies (with tenant_id)
    let replyData;
    if (isCustomerReply) {
      // Customer reply
      const [result] = await pool.execute(
        'INSERT INTO replies (tenant_id, ticket_id, customer_name, message, is_customer_reply) VALUES (?, ?, ?, ?, TRUE)',
        [tenantId, ticketId, customerName || ticket.name, message]
      );
      
      const [replies] = await pool.execute(
        'SELECT * FROM replies WHERE id = ?',
        [result.insertId]
      );
      
      replyData = replies[0];
    } else {
      // Agent reply
      const [result] = await pool.execute(
        'INSERT INTO replies (tenant_id, ticket_id, agent_name, message, is_customer_reply) VALUES (?, ?, ?, ?, FALSE)',
        [tenantId, ticketId, agentName, message]
      );
      
      const [replies] = await pool.execute(
        'SELECT * FROM replies WHERE id = ?',
        [result.insertId]
      );
      
      replyData = replies[0];
      
      // Send WhatsApp notification if mobile number exists (only for agent replies)
      if (ticket.mobile) {
        await sendAgentReplyNotification(ticket, agentName, message);
      }
    }
    
    res.status(201).json({
      success: true,
      message: isCustomerReply ? 'Customer reply added successfully' : 'Reply added successfully',
      data: replyData,
      whatsappSent: !isCustomerReply && !!ticket.mobile
    });
  } catch (error) {
    console.error('Error adding reply:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to add reply'
    });
  }
});

// PUT /api/replies/:id - Update a reply
router.put('/:id', authenticateToken, verifyTenantAccess, async (req, res) => {
  try {
    const tenantId = req.tenantId;
    const { id } = req.params;
    const { agentName, message } = req.body;
    
    // Check if reply exists (tenant-filtered)
    const [replies] = await pool.execute(
      'SELECT id FROM replies WHERE id = ? AND tenant_id = ?',
      [id, tenantId]
    );
    
    if (replies.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Reply not found'
      });
    }
    
    // Update reply (tenant-filtered)
    await pool.execute(
      'UPDATE replies SET agent_name = ?, message = ? WHERE id = ? AND tenant_id = ?',
      [agentName, message, id, tenantId]
    );
    
    // Get the updated reply
    const [updatedReplies] = await pool.execute(
      'SELECT * FROM replies WHERE id = ?',
      [id]
    );
    
    res.json({
      success: true,
      message: 'Reply updated successfully',
      data: updatedReplies[0]
    });
  } catch (error) {
    console.error('Error updating reply:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update reply'
    });
  }
});

// DELETE /api/replies/:id - Delete a reply
router.delete('/:id', authenticateToken, verifyTenantAccess, async (req, res) => {
  try {
    const tenantId = req.tenantId;
    const { id } = req.params;
    
    // Check if reply exists (tenant-filtered)
    const [replies] = await pool.execute(
      'SELECT id FROM replies WHERE id = ? AND tenant_id = ?',
      [id, tenantId]
    );
    
    if (replies.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Reply not found'
      });
    }
    
    // Delete reply (tenant-filtered)
    await pool.execute(
      'DELETE FROM replies WHERE id = ? AND tenant_id = ?',
      [id, tenantId]
    );
    
    res.json({
      success: true,
      message: 'Reply deleted successfully'
    });
  } catch (error) {
    console.error('Error deleting reply:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to delete reply'
    });
  }
});

// POST /api/replies/dashboard - Add a reply from dashboard (manager/agent interface)
router.post('/dashboard', authenticateToken, verifyTenantAccess, async (req, res) => {
  try {
    const tenantId = req.tenantId;
    const { ticket_id, message, agent_id } = req.body;
    
    if (!ticket_id || !message) {
      return res.status(400).json({
        success: false,
        message: 'ticket_id and message are required'
      });
    }
    
    // Check if ticket exists and get ticket details (tenant-filtered)
    const [tickets] = await pool.execute(
      'SELECT id, name, mobile, issue_title FROM tickets WHERE id = ? AND tenant_id = ?',
      [ticket_id, tenantId]
    );
    
    if (tickets.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Ticket not found'
      });
    }
    
    const ticket = tickets[0];
    
    // Get agent name from agent_id if provided (tenant-filtered)
    let agentName = 'Support Agent';
    if (agent_id) {
      const [agents] = await pool.execute(
        'SELECT name FROM agents WHERE id = ? AND tenant_id = ?',
        [agent_id, tenantId]
      );
      if (agents.length > 0) {
        agentName = agents[0].name;
      }
    }
    
    // Insert agent reply (with tenant_id)
    const [result] = await pool.execute(
      'INSERT INTO replies (tenant_id, ticket_id, agent_name, message, is_customer_reply) VALUES (?, ?, ?, ?, FALSE)',
      [tenantId, ticket_id, agentName, message]
    );
    
    const [replies] = await pool.execute(
      'SELECT * FROM replies WHERE id = ?',
      [result.insertId]
    );
    
    const replyData = replies[0];
    
    // Send WhatsApp notification if mobile number exists
    let whatsappSent = false;
    if (ticket.mobile) {
      try {
        await sendAgentReplyNotification(ticket, agentName, message);
        whatsappSent = true;
        console.log(`✅ WhatsApp notification sent to ${ticket.mobile} for ticket #${ticket_id}`);
      } catch (whatsappError) {
        console.error('⚠️ Error sending WhatsApp notification:', whatsappError);
        // Don't fail the reply if WhatsApp fails
      }
    }
    
    res.status(201).json({
      success: true,
      message: 'Reply added successfully',
      data: replyData,
      whatsappSent: whatsappSent
    });
  } catch (error) {
    console.error('Error adding dashboard reply:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to add reply'
    });
  }
});

// GET /api/replies/user/:userId - Get all replies for all tickets of a user
router.get('/user/:userId', authenticateToken, verifyTenantAccess, async (req, res) => {
  try {
    const tenantId = req.tenantId;
    const { userId } = req.params;
    const [replies] = await pool.execute(
      `SELECT r.* FROM replies r JOIN tickets t ON r.ticket_id = t.id WHERE t.user_id = ? AND t.tenant_id = ? AND r.tenant_id = ? ORDER BY r.sent_at ASC`,
      [userId, tenantId, tenantId]
    );
    res.json({ success: true, data: replies });
  } catch (error) {
    console.error('Error fetching user replies:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch user replies' });
  }
});

module.exports = router; 