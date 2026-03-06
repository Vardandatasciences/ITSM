const express = require('express');
const { pool } = require('../database');
const { authenticateToken, authorizeRole } = require('../middleware/auth');
const router = express.Router();

// Super admin roles that can manage tenants
const SUPER_ADMIN_ROLES = ['super_admin', 'system_admin', 'ceo'];

/**
 * GET /api/tenants
 * List all tenants (super admin only)
 */
router.get('/', authenticateToken, authorizeRole(SUPER_ADMIN_ROLES), async (req, res) => {
  try {
    const { status, plan } = req.query;
    
    let query = 'SELECT id, name, subdomain, status, plan, max_users, max_tickets_per_month, created_at FROM tenants';
    const params = [];
    
    if (status) {
      query += ' WHERE status = ?';
      params.push(status);
    }
    
    if (plan) {
      query += params.length > 0 ? ' AND plan = ?' : ' WHERE plan = ?';
      params.push(plan);
    }
    
    query += ' ORDER BY created_at DESC';
    
    const [tenants] = await pool.execute(query, params);
    
    res.json({
      success: true,
      data: tenants,
      count: tenants.length
    });
  } catch (error) {
    console.error('Error fetching tenants:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch tenants'
    });
  }
});

/**
 * GET /api/tenants/:id
 * Get tenant details
 */
router.get('/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const tenantId = req.user.tenant_id;
    
    // Users can only view their own tenant unless super admin
    if (parseInt(id) !== tenantId && !SUPER_ADMIN_ROLES.includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        message: 'Access denied: You can only view your own tenant'
      });
    }
    
    const [tenants] = await pool.execute(
      'SELECT * FROM tenants WHERE id = ?',
      [id]
    );
    
    if (tenants.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Tenant not found'
      });
    }
    
    res.json({
      success: true,
      data: tenants[0]
    });
  } catch (error) {
    console.error('Error fetching tenant:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch tenant'
    });
  }
});

/**
 * POST /api/tenants
 * Create new tenant (super admin only)
 */
router.post('/', authenticateToken, authorizeRole(SUPER_ADMIN_ROLES), async (req, res) => {
  try {
    const {
      name,
      subdomain,
      plan = 'free',
      max_users = 10,
      max_tickets_per_month = 100,
      whatsapp_enabled = false,
      email_enabled = true
    } = req.body;
    
    // Validation
    if (!name || !subdomain) {
      return res.status(400).json({
        success: false,
        message: 'Name and subdomain are required'
      });
    }
    
    // Validate subdomain format (alphanumeric and hyphens only)
    if (!/^[a-z0-9-]+$/.test(subdomain)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid subdomain format. Use only lowercase letters, numbers, and hyphens.'
      });
    }
    
    // Check if subdomain exists
    const [existing] = await pool.execute(
      'SELECT id FROM tenants WHERE subdomain = ?',
      [subdomain]
    );
    
    if (existing.length > 0) {
      return res.status(400).json({
        success: false,
        message: 'Subdomain already exists'
      });
    }
    
    // Create tenant
    const [result] = await pool.execute(
      `INSERT INTO tenants (
        name, subdomain, plan, max_users, max_tickets_per_month,
        whatsapp_enabled, email_enabled, created_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [name, subdomain, plan, max_users, max_tickets_per_month, whatsapp_enabled, email_enabled, req.user.id]
    );
    
    console.log(`✅ Tenant created: ${name} (ID: ${result.insertId}, Subdomain: ${subdomain})`);
    
    res.status(201).json({
      success: true,
      message: 'Tenant created successfully',
      data: {
        id: result.insertId,
        name,
        subdomain,
        plan
      }
    });
  } catch (error) {
    console.error('Error creating tenant:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to create tenant',
      error: error.message
    });
  }
});

/**
 * PUT /api/tenants/:id
 * Update tenant (super admin or tenant owner)
 */
router.put('/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const tenantId = req.user.tenant_id;
    
    // Check access
    if (parseInt(id) !== tenantId && !SUPER_ADMIN_ROLES.includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        message: 'Access denied'
      });
    }
    
    const {
      name,
      status,
      plan,
      max_users,
      max_tickets_per_month,
      whatsapp_enabled,
      email_enabled,
      settings
    } = req.body;
    
    // Build update query dynamically
    const updates = [];
    const params = [];
    
    if (name) {
      updates.push('name = ?');
      params.push(name);
    }
    
    if (status && SUPER_ADMIN_ROLES.includes(req.user.role)) {
      updates.push('status = ?');
      params.push(status);
    }
    
    if (plan && SUPER_ADMIN_ROLES.includes(req.user.role)) {
      updates.push('plan = ?');
      params.push(plan);
    }
    
    if (max_users !== undefined && SUPER_ADMIN_ROLES.includes(req.user.role)) {
      updates.push('max_users = ?');
      params.push(max_users);
    }
    
    if (max_tickets_per_month !== undefined && SUPER_ADMIN_ROLES.includes(req.user.role)) {
      updates.push('max_tickets_per_month = ?');
      params.push(max_tickets_per_month);
    }
    
    if (whatsapp_enabled !== undefined) {
      updates.push('whatsapp_enabled = ?');
      params.push(whatsapp_enabled);
    }
    
    if (email_enabled !== undefined) {
      updates.push('email_enabled = ?');
      params.push(email_enabled);
    }
    
    if (settings) {
      updates.push('settings = ?');
      params.push(JSON.stringify(settings));
    }
    
    if (updates.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'No fields to update'
      });
    }
    
    params.push(id);
    
    const [result] = await pool.execute(
      `UPDATE tenants SET ${updates.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      params
    );
    
    if (result.affectedRows === 0) {
      return res.status(404).json({
        success: false,
        message: 'Tenant not found'
      });
    }
    
    res.json({
      success: true,
      message: 'Tenant updated successfully'
    });
  } catch (error) {
    console.error('Error updating tenant:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update tenant'
    });
  }
});

/**
 * DELETE /api/tenants/:id
 * Delete tenant (super admin only) - CASCADE will delete all related data
 */
router.delete('/:id', authenticateToken, authorizeRole(SUPER_ADMIN_ROLES), async (req, res) => {
  try {
    const { id } = req.params;
    
    // Check if tenant exists
    const [tenants] = await pool.execute('SELECT id, name FROM tenants WHERE id = ?', [id]);
    
    if (tenants.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Tenant not found'
      });
    }
    
    // Delete tenant (CASCADE will delete all related data)
    await pool.execute('DELETE FROM tenants WHERE id = ?', [id]);
    
    console.log(`✅ Tenant deleted: ${tenants[0].name} (ID: ${id})`);
    
    res.json({
      success: true,
      message: 'Tenant deleted successfully'
    });
  } catch (error) {
    console.error('Error deleting tenant:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to delete tenant'
    });
  }
});

/**
 * GET /api/tenants/:id/stats
 * Get tenant statistics
 */
router.get('/:id/stats', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const tenantId = req.user.tenant_id;
    
    // Check access
    if (parseInt(id) !== tenantId && !SUPER_ADMIN_ROLES.includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        message: 'Access denied'
      });
    }
    
    // Get statistics
    const [ticketStats] = await pool.execute(
      `SELECT 
        COUNT(*) as total_tickets,
        SUM(CASE WHEN status = 'new' THEN 1 ELSE 0 END) as new_tickets,
        SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END) as in_progress_tickets,
        SUM(CASE WHEN status = 'closed' THEN 1 ELSE 0 END) as closed_tickets,
        SUM(CASE WHEN status = 'escalated' THEN 1 ELSE 0 END) as escalated_tickets
      FROM tickets WHERE tenant_id = ?`,
      [id]
    );
    
    const [userStats] = await pool.execute(
      `SELECT 
        COUNT(*) as total_users,
        SUM(CASE WHEN role = 'user' THEN 1 ELSE 0 END) as customers,
        SUM(CASE WHEN role IN ('support_agent', 'support_manager', 'ceo') THEN 1 ELSE 0 END) as staff
      FROM users WHERE tenant_id = ?`,
      [id]
    );
    
    const [agentStats] = await pool.execute(
      `SELECT COUNT(*) as total_agents FROM agents WHERE tenant_id = ?`,
      [id]
    );
    
    res.json({
      success: true,
      data: {
        tickets: ticketStats[0],
        users: userStats[0],
        agents: agentStats[0]
      }
    });
  } catch (error) {
    console.error('Error fetching tenant stats:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch tenant statistics'
    });
  }
});

module.exports = router;

