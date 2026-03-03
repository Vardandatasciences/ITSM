const express = require('express');
const { pool } = require('../../database');
const { authenticateToken, authorizeRole } = require('../../middleware/auth');
const { setTenantContext, verifyTenantAccess } = require('../../middleware/tenant');
const { sendAssignmentNotification } = require('../../utils/whatsapp-notifications');

const router = express.Router();

// Apply tenant context to all routes
router.use(setTenantContext);

// GET /api/assignments - Get all assignments with filtering
router.get('/', authenticateToken, verifyTenantAccess, async (req, res) => {
  try {
    const tenantId = req.tenantId;
    const { status, agent_id, ticket_id, limit = 50, offset = 0 } = req.query;
    
    // Validate and sanitize pagination parameters
    const validLimit = Math.max(1, Math.min(1000, parseInt(limit) || 50));
    const validOffset = Math.max(0, parseInt(offset) || 0);
    
    // Query with tenant filtering (need to join with tickets to get tenant_id)
    let query = `
      SELECT 
        ca.assignment_id,
        ca.ticket_id,
        ca.agent_id,
        ca.agent_name,
        ca.agent_email,
        ca.agent_role,
        ca.assigned_by,
        ca.assigned_by_name,
        ca.assigned_at,
        ca.assignment_type,
        ca.priority_level,
        ca.assignment_notes,
        ca.is_primary,
        ca.ticket_status,
        ca.issue_title,
        ca.ticket_created
      FROM current_assignments ca
      JOIN tickets t ON ca.ticket_id = t.id
      WHERE t.tenant_id = ?
    `;
    
    const params = [tenantId];
    
    if (status) {
      query += ' AND ca.ticket_status = ?';
      params.push(status);
    }
    
    if (agent_id) {
      query += ' AND ca.agent_id = ?';
      params.push(agent_id);
    }
    
    if (ticket_id) {
      query += ' AND ca.ticket_id = ?';
      params.push(ticket_id);
    }
    
    query += ' ORDER BY ca.assigned_at DESC LIMIT ? OFFSET ?';
    
    // Ensure parameters are strings (MySQL2 requires strings for LIMIT/OFFSET)
    const finalParams = [...params, String(validLimit), String(validOffset)];
    
    const [assignments] = await pool.execute(query, finalParams);
    
    // Get total count for pagination (tenant-filtered)
    let countQuery = 'SELECT COUNT(*) as total FROM current_assignments ca JOIN tickets t ON ca.ticket_id = t.id WHERE t.tenant_id = ?';
    const countParams = [tenantId];
    
    if (status) {
      countQuery += ' AND ca.ticket_status = ?';
      countParams.push(status);
    }
    
    if (agent_id) {
      countQuery += ' AND ca.agent_id = ?';
      countParams.push(agent_id);
    }
    
    if (ticket_id) {
      countQuery += ' AND ca.ticket_id = ?';
      countParams.push(ticket_id);
    }
    
    const [countResult] = await pool.execute(countQuery, countParams);
    
    res.json({
      success: true,
      data: assignments,
      pagination: {
        total: countResult[0].total,
        limit: Number(validLimit),
        offset: Number(validOffset),
        hasMore: (Number(validOffset) + assignments.length) < countResult[0].total
      }
    });
    
  } catch (error) {
    console.error('Error fetching assignments:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch assignments',
      error: error.message
    });
  }
});

// GET /api/assignments/history/:ticketId - Get assignment history for a ticket
router.get('/history/:ticketId', authenticateToken, verifyTenantAccess, async (req, res) => {
  try {
    const tenantId = req.tenantId;
    const { ticketId } = req.params;
    
    // Verify ticket belongs to tenant
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
    
    const [history] = await pool.execute(`
      SELECT 
        ah.assignment_id,
        ah.ticket_id,
        ah.agent_id,
        ah.agent_name,
        ah.assigned_by,
        ah.assigned_by_name,
        ah.assigned_at,
        ah.unassigned_at,
        ah.status,
        ah.assignment_type,
        ah.assignment_notes,
        ah.duration_minutes,
        ah.issue_title,
        ah.ticket_status
      FROM assignment_history ah
      JOIN tickets t ON ah.ticket_id = t.id
      WHERE ah.ticket_id = ? AND t.tenant_id = ?
      ORDER BY ah.assigned_at DESC
    `, [ticketId, tenantId]);
    
    res.json({
      success: true,
      data: history
    });
    
  } catch (error) {
    console.error('Error fetching assignment history:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch assignment history',
      error: error.message
    });
  }
});

// GET /api/assignments/workload - Get agent workload statistics
router.get('/workload', authenticateToken, verifyTenantAccess, authorizeRole(['support_manager', 'ceo']), async (req, res) => {
  try {
    const tenantId = req.tenantId;
    // Note: agent_workload view needs to be updated to include tenant filtering
    // For now, filter by joining with agents table
    const [workload] = await pool.execute(`
      SELECT 
        aw.agent_id,
        aw.agent_name,
        aw.agent_email,
        aw.agent_role,
        aw.total_active_assignments,
        aw.primary_assignments,
        aw.urgent_tickets,
        aw.high_priority_tickets,
        aw.avg_workload_score,
        aw.oldest_assignment,
        aw.newest_assignment
      FROM agent_workload aw
      JOIN agents a ON aw.agent_id = a.id
      WHERE a.tenant_id = ?
      ORDER BY aw.total_active_assignments DESC, aw.agent_name
    `, [tenantId]);
    
    res.json({
      success: true,
      data: workload
    });
    
  } catch (error) {
    console.error('Error fetching agent workload:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch agent workload',
      error: error.message
    });
  }
});

// POST /api/assignments/assign - Assign a ticket to an agent
router.post('/assign', authenticateToken, verifyTenantAccess, authorizeRole(['support_manager', 'ceo', 'support_executive']), async (req, res) => {
  const connection = await pool.getConnection();
  
  try {
    const tenantId = req.tenantId;
    const { ticket_id, agent_id, assignment_type = 'manual', priority_level = 'medium', notes } = req.body;
    const assigned_by = req.user.id;
    
    if (!ticket_id || !agent_id) {
      return res.status(400).json({
        success: false,
        message: 'ticket_id and agent_id are required'
      });
    }
    
    // Verify ticket and agent belong to tenant
    const [tickets] = await connection.execute(
      'SELECT id FROM tickets WHERE id = ? AND tenant_id = ?',
      [ticket_id, tenantId]
    );
    
    if (tickets.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Ticket not found'
      });
    }
    
    const [agents] = await connection.execute(
      'SELECT id FROM agents WHERE id = ? AND tenant_id = ?',
      [agent_id, tenantId]
    );
    
    if (agents.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Agent not found'
      });
    }
    
    await connection.beginTransaction();
    
    // Calculate current workload for the agent (tenant-filtered)
    const [workloadResult] = await connection.execute(
      'SELECT COUNT(*) as count FROM ticket_assignments ta JOIN tickets t ON ta.ticket_id = t.id WHERE ta.agent_id = ? AND ta.is_active = TRUE AND t.tenant_id = ?',
      [agent_id, tenantId]
    );
    const workloadScore = workloadResult[0].count;
    
    // Mark any existing assignment as inactive (tenant-filtered)
    await connection.execute(`
      UPDATE ticket_assignments ta
      JOIN tickets t ON ta.ticket_id = t.id
      SET ta.is_active = FALSE, ta.unassigned_at = NOW() 
      WHERE ta.ticket_id = ? AND ta.is_active = TRUE AND t.tenant_id = ?
    `, [ticket_id, tenantId]);
    
    // Create new assignment (with tenant_id)
    const [assignmentResult] = await connection.execute(`
      INSERT INTO ticket_assignments (
        tenant_id, ticket_id, agent_id, assigned_by, assignment_reason, is_active
      ) VALUES (?, ?, ?, ?, ?, TRUE)
    `, [tenantId, ticket_id, agent_id, assigned_by, notes]);
    
    // Update tickets table for backward compatibility (tenant-filtered)
    await connection.execute(`
      UPDATE tickets 
      SET assigned_to = ?, assigned_by = ? 
      WHERE id = ? AND tenant_id = ?
    `, [agent_id, assigned_by, ticket_id, tenantId]);
    
    await connection.commit();
    
    // Get the created assignment details
    const [newAssignment] = await connection.execute(`
      SELECT 
        ca.assignment_id,
        ca.ticket_id,
        ca.agent_id,
        ca.agent_name,
        ca.agent_email,
        ca.assigned_by,
        ca.assigned_by_name,
        ca.assigned_at,
        ca.assignment_type,
        ca.priority_level,
        ca.assignment_notes,
        ca.is_primary,
        ca.ticket_status,
        ca.issue_title
      FROM current_assignments ca
      WHERE ca.assignment_id = ?
    `, [assignmentResult.insertId]);
    
    // Send WhatsApp notification to customer about ticket assignment
    try {
      const [ticketDetails] = await connection.execute(
        'SELECT id, name, mobile, issue_title FROM tickets WHERE id = ? AND tenant_id = ?',
        [ticket_id, tenantId]
      );
      
      if (ticketDetails.length > 0 && ticketDetails[0].mobile) {
        const ticket = ticketDetails[0];
        const agentName = newAssignment[0].agent_name;
        
        await sendAssignmentNotification(ticket, agentName);
        console.log(`✅ WhatsApp assignment notification sent to ${ticket.mobile}`);
      }
    } catch (notificationError) {
      console.error('⚠️ Error sending WhatsApp notification:', notificationError);
      // Don't fail the assignment if notification fails
    }
    
    res.status(201).json({
      success: true,
      message: 'Ticket assigned successfully',
      data: newAssignment[0],
      whatsappNotificationSent: true
    });
    
  } catch (error) {
    await connection.rollback();
    console.error('Error assigning ticket:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to assign ticket',
      error: error.message
    });
  } finally {
    connection.release();
  }
});

// PUT /api/assignments/:id/transfer - Transfer assignment to another agent
router.put('/:id/transfer', authenticateToken, verifyTenantAccess, authorizeRole(['support_manager', 'ceo']), async (req, res) => {
  const connection = await pool.getConnection();
  
  try {
    const tenantId = req.tenantId;
    const { id: assignmentId } = req.params;
    const { new_agent_id, notes } = req.body;
    const transferred_by = req.user.id;
    
    if (!new_agent_id) {
      return res.status(400).json({
        success: false,
        message: 'new_agent_id is required'
      });
    }
    
    await connection.beginTransaction();
    
    // Get current assignment details (tenant-filtered)
    const [currentAssignment] = await connection.execute(
      `SELECT ta.ticket_id, ta.agent_id 
       FROM ticket_assignments ta
       JOIN tickets t ON ta.ticket_id = t.id
       WHERE ta.id = ? AND ta.is_active = TRUE AND t.tenant_id = ?`,
      [assignmentId, tenantId]
    );
    
    if (currentAssignment.length === 0) {
      await connection.rollback();
      return res.status(404).json({
        success: false,
        message: 'Assignment not found or not active'
      });
    }
    
    const { ticket_id } = currentAssignment[0];
    
    // Verify new agent belongs to tenant
    const [agents] = await connection.execute(
      'SELECT id FROM agents WHERE id = ? AND tenant_id = ?',
      [new_agent_id, tenantId]
    );
    
    if (agents.length === 0) {
      await connection.rollback();
      return res.status(404).json({
        success: false,
        message: 'Agent not found'
      });
    }
    
    // Mark current assignment as inactive
    await connection.execute(`
      UPDATE ticket_assignments 
      SET is_active = FALSE, unassigned_at = NOW() 
      WHERE id = ?
    `, [assignmentId]);
    
    // Calculate workload for new agent (tenant-filtered)
    const [workloadResult] = await connection.execute(
      `SELECT COUNT(*) as count 
       FROM ticket_assignments ta
       JOIN tickets t ON ta.ticket_id = t.id
       WHERE ta.agent_id = ? AND ta.is_active = TRUE AND t.tenant_id = ?`,
      [new_agent_id, tenantId]
    );
    const workloadScore = workloadResult[0].count;
    
    // Create new assignment (with tenant_id)
    const [newAssignmentResult] = await connection.execute(`
      INSERT INTO ticket_assignments (
        tenant_id, ticket_id, agent_id, assigned_by, assignment_reason, is_active
      ) VALUES (?, ?, ?, ?, ?, TRUE)
    `, [tenantId, ticket_id, new_agent_id, transferred_by, notes]);
    
    // Update tickets table (tenant-filtered)
    await connection.execute(`
      UPDATE tickets 
      SET assigned_to = ?, assigned_by = ? 
      WHERE id = ? AND tenant_id = ?
    `, [new_agent_id, transferred_by, ticket_id, tenantId]);
    
    await connection.commit();
    
    res.json({
      success: true,
      message: 'Assignment transferred successfully',
      data: {
        old_assignment_id: assignmentId,
        new_assignment_id: newAssignmentResult.insertId,
        ticket_id,
        new_agent_id
      }
    });
    
  } catch (error) {
    await connection.rollback();
    console.error('Error transferring assignment:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to transfer assignment',
      error: error.message
    });
  } finally {
    connection.release();
  }
});

// PUT /api/assignments/:id/complete - Mark assignment as completed
router.put('/:id/complete', authenticateToken, verifyTenantAccess, async (req, res) => {
  try {
    const tenantId = req.tenantId;
    const { id: assignmentId } = req.params;
    const { completion_notes } = req.body;
    
    // Verify assignment belongs to tenant
    const [assignments] = await pool.execute(`
      SELECT ta.id 
      FROM ticket_assignments ta
      JOIN tickets t ON ta.ticket_id = t.id
      WHERE ta.id = ? AND t.tenant_id = ?
    `, [assignmentId, tenantId]);
    
    if (assignments.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Assignment not found'
      });
    }
    
    const [result] = await pool.execute(`
      UPDATE ticket_assignments 
      SET is_active = FALSE, unassigned_at = NOW(), assignment_reason = CONCAT(COALESCE(assignment_reason, ''), '\n\nCompleted: ', ?)
      WHERE id = ? AND is_active = TRUE
    `, [completion_notes || 'Assignment completed', assignmentId]);
    
    if (result.affectedRows === 0) {
      return res.status(404).json({
        success: false,
        message: 'Assignment not found or already completed'
      });
    }
    
    res.json({
      success: true,
      message: 'Assignment marked as completed'
    });
    
  } catch (error) {
    console.error('Error completing assignment:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to complete assignment',
      error: error.message
    });
  }
});

module.exports = router;
