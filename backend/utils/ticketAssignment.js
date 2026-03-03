const { pool } = require('../database');
const emailService = require('../services/emailService');

/**
 * Equal Ticket Assignment System
 * 
 * This system ensures that tickets are distributed equally among all active agents.
 * When a new ticket is created, it's automatically assigned to the agent with the least number of active tickets.
 * This ensures fair workload distribution and scales automatically when new agents are added.
 * 
 * UPDATED: Now uses the new assigned table for proper assignment tracking and consistency
 */

class TicketAssignmentService {
  
  /**
   * Get the single support executive for ticket assignment
   * @param {number} tenantId - The tenant ID for filtering
   * @returns {Promise<Object|null>} Agent object or null if no agent found
   */
  static async getAgentWithLeastTickets(tenantId) {
    const connection = await pool.getConnection();
    
    try {
      // Find the active agent with the least number of active tickets using the new assigned table (tenant-filtered)
      console.log('🎯 Selecting active agent with the fewest active tickets...');

      const [agents] = await connection.execute(`
        SELECT 
          a.id,
          a.name,
          a.email,
          a.role,
          a.is_active,
          COALESCE(assignment_counts.active_tickets, 0) as active_tickets
        FROM agents a
        LEFT JOIN (
          SELECT 
            ta.agent_id,
            COUNT(*) as active_tickets
          FROM ticket_assignments ta
          JOIN tickets t ON ta.ticket_id = t.id
          WHERE ta.is_active = TRUE AND t.tenant_id = ?
          GROUP BY ta.agent_id
        ) assignment_counts ON a.id = assignment_counts.agent_id
        WHERE a.is_active = TRUE 
          AND a.role IN ('support_executive')
          AND a.tenant_id = ?
        ORDER BY active_tickets ASC, a.id ASC
        LIMIT 1
      `, [tenantId, tenantId]);

      if (agents.length === 0) {
        console.log('⚠️ No active agents found (role = agent or support_executive).');
        return null;
      }

      const selectedAgent = agents[0];
      console.log(`🎯 Selected agent: ${selectedAgent.name} (ID: ${selectedAgent.id}) with ${selectedAgent.active_tickets} active tickets`);

      return selectedAgent;
      
    } catch (error) {
      console.error('❌ Error getting agent with least tickets:', error);
      throw error;
    } finally {
      connection.release();
    }
  }
  
  /**
   * Assign a ticket to an agent using equal distribution
   * @param {number} ticketId - The ticket ID to assign
   * @param {number} assignedBy - The ID of the user/agent making the assignment
   * @param {number} tenantId - The tenant ID for filtering
   * @returns {Promise<Object>} Assignment result
   */
  static async assignTicketEqually(ticketId, assignedBy = null, tenantId = 1) {
    const connection = await pool.getConnection();
    
    try {
      // Get the agent with the least tickets (tenant-filtered)
      const agent = await this.getAgentWithLeastTickets(tenantId);
      
      if (!agent) {
        throw new Error('No active agents available for ticket assignment');
      }
      
      // Update the ticket with the selected agent (for backward compatibility, tenant-filtered)
      const [result] = await connection.execute(
        'UPDATE tickets SET assigned_to = ?, assigned_by = ? WHERE id = ? AND tenant_id = ?',
        [agent.id, assignedBy, ticketId, tenantId]
      );
      
      if (result.affectedRows === 0) {
        throw new Error('Ticket not found or already assigned');
      }
      
      // Create assignment record in the new ticket_assignments table (with tenant_id)
      await connection.execute(
        `INSERT INTO ticket_assignments (
          tenant_id, ticket_id, agent_id, assigned_by, assignment_reason, is_active
        ) VALUES (?, ?, ?, ?, ?, TRUE)`,
        [tenantId, ticketId, agent.id, assignedBy || agent.id, 'Automatic equal distribution assignment']
      );
      
      console.log(`✅ Ticket ${ticketId} assigned to ${agent.name} (ID: ${agent.id}) using equal distribution`);
      
      // Send email notification to the assigned agent
      try {
        // Get ticket details for the email notification (tenant-filtered)
        const [ticketDetails] = await connection.execute(
          'SELECT id, name, issue_title FROM tickets WHERE id = ? AND tenant_id = ?',
          [ticketId, tenantId]
        );
        
        if (ticketDetails.length > 0) {
          const ticket = ticketDetails[0];
          const customerName = ticket.name || 'Customer';
          const ticketTitle = ticket.issue_title || 'Support Request';
          
          // Send email notification to agent
          const emailResult = await emailService.sendAgentAssignmentNotification(
            agent.email,
            agent.name,
            ticketId,
            customerName,
            ticketTitle
          );
          
          if (emailResult.success) {
            console.log(`✅ Agent assignment email sent successfully to ${agent.email} for ticket #${ticketId}`);
          } else {
            console.log(`⚠️ Failed to send agent assignment email to ${agent.email}:`, emailResult.error);
          }
        }
      } catch (emailError) {
        console.error('⚠️ Error sending agent assignment email:', emailError);
        // Don't fail the assignment if email fails
      }
      
      return {
        success: true,
        message: `Ticket assigned to ${agent.name} using equal distribution`,
        data: {
          ticket_id: ticketId,
          assigned_to: agent.id,
          assigned_to_name: agent.name,
          assigned_to_email: agent.email,
          assignment_method: 'equal_distribution',
          active_tickets_count: agent.active_tickets + 1
        }
      };
      
    } catch (error) {
      console.error('❌ Error assigning ticket equally:', error);
      throw error;
    } finally {
      connection.release();
    }
  }
  
  /**
   * Get assignment statistics for the single support executive
   * @param {number} tenantId - The tenant ID for filtering
   * @returns {Promise<Array>} Array with single agent and their ticket counts
   */
  static async getAssignmentStatistics(tenantId) {
    const connection = await pool.getConnection();
    
    try {
      // Get stats for all active agents (tenant-filtered)
      const [agents] = await connection.execute(`
        SELECT 
          u.id,
          u.name,
          u.email,
          u.role,
          u.is_active,
          COALESCE(new_tickets.count, 0) as new_tickets,
          COALESCE(in_progress_tickets.count, 0) as in_progress_tickets,
          COALESCE(closed_tickets.count, 0) as closed_tickets,
          COALESCE(total_tickets.count, 0) as total_tickets
        FROM agents u
        LEFT JOIN (
          SELECT assigned_to, COUNT(*) as count
          FROM tickets 
          WHERE status = 'new' AND assigned_to IS NOT NULL AND tenant_id = ?
          GROUP BY assigned_to
        ) new_tickets ON u.id = new_tickets.assigned_to
        LEFT JOIN (
          SELECT assigned_to, COUNT(*) as count
          FROM tickets 
          WHERE status = 'in_progress' AND assigned_to IS NOT NULL AND tenant_id = ?
          GROUP BY assigned_to
        ) in_progress_tickets ON u.id = in_progress_tickets.assigned_to
        LEFT JOIN (
          SELECT assigned_to, COUNT(*) as count
          FROM tickets 
          WHERE status = 'closed' AND assigned_to IS NOT NULL AND tenant_id = ?
          GROUP BY assigned_to
        ) closed_tickets ON u.id = closed_tickets.assigned_to
        LEFT JOIN (
          SELECT assigned_to, COUNT(*) as count
          FROM tickets 
          WHERE assigned_to IS NOT NULL AND tenant_id = ?
          GROUP BY assigned_to
        ) total_tickets ON u.id = total_tickets.assigned_to
        WHERE u.is_active = TRUE AND u.role IN ('support_executive') AND u.tenant_id = ?
        ORDER BY total_tickets.count DESC, u.name ASC
      `, [tenantId, tenantId, tenantId, tenantId, tenantId]);
      
      return agents;
      
    } catch (error) {
      console.error('❌ Error getting assignment statistics:', error);
      throw error;
    } finally {
      connection.release();
    }
  }
  
  /**
   * Rebalance ticket assignments to ensure equal distribution
   * @param {number} tenantId - The tenant ID for filtering
   * @returns {Promise<Object>} Rebalancing result
   */
  static async rebalanceAssignments(tenantId) {
    const connection = await pool.getConnection();
    
    try {
      console.log('🔄 Starting ticket assignment rebalancing...');
      
      // Get all unassigned tickets (not in ticket_assignments table or no active assignment, tenant-filtered)
      const [unassignedTickets] = await connection.execute(`
        SELECT t.id, t.name, t.email, t.created_at, t.tenant_id
        FROM tickets t
        LEFT JOIN ticket_assignments ta ON t.id = ta.ticket_id AND ta.is_active = TRUE AND ta.tenant_id = t.tenant_id
        WHERE ta.id IS NULL AND t.status IN ('new', 'in_progress') AND t.tenant_id = ?
        ORDER BY t.created_at ASC
      `, [tenantId]);
      
      if (unassignedTickets.length === 0) {
        console.log('✅ No unassigned tickets found');
        return {
          success: true,
          message: 'No unassigned tickets to rebalance',
          data: { rebalanced_tickets: 0 }
        };
      }
      
      console.log(`📋 Found ${unassignedTickets.length} unassigned tickets to rebalance`);
      
      let rebalancedCount = 0;
      
      for (const ticket of unassignedTickets) {
        try {
          await this.assignTicketEqually(ticket.id, null, ticket.tenant_id || tenantId);
          rebalancedCount++;
        } catch (error) {
          console.error(`❌ Failed to rebalance ticket ${ticket.id}:`, error.message);
        }
      }
      
      console.log(`✅ Rebalancing completed: ${rebalancedCount} tickets reassigned`);
      
      return {
        success: true,
        message: `Rebalancing completed: ${rebalancedCount} tickets reassigned`,
        data: {
          rebalanced_tickets: rebalancedCount,
          total_unassigned: unassignedTickets.length
        }
      };
      
    } catch (error) {
      console.error('❌ Error rebalancing assignments:', error);
      throw error;
    } finally {
      connection.release();
    }
  }
}

module.exports = TicketAssignmentService;
