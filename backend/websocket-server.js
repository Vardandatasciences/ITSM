const WebSocket = require('ws');
const { pool } = require('./database');
const { getTenantIdFromRequest } = require('./middleware/tenant');

class WebSocketServer {
  constructor(server) {
    this.wss = new WebSocket.Server({ 
      server,
      path: '/ws', // Add specific WebSocket path
      clientTracking: true
    });
    this.clients = new Map(); // Map to store client connections
    this.ticketRooms = new Map(); // Map to store ticket-specific rooms
    
    this.initialize();
  }

  initialize() {
    console.log('🔌 Initializing WebSocket server on path /ws');
    
    this.wss.on('connection', (ws, req) => {
      console.log('🔌 New WebSocket connection established');
      console.log('   - Remote address:', req.socket.remoteAddress);
      console.log('   - User agent:', req.headers['user-agent']);
      console.log('   - Path:', req.url);
      
      // Set up ping/pong for connection health
      ws.isAlive = true;
      ws.on('pong', () => {
        ws.isAlive = true;
      });
      
      // Handle client connection
      ws.on('message', (message) => {
        try {
          const data = JSON.parse(message);
          this.handleMessage(ws, data);
        } catch (error) {
          console.error('❌ Error parsing WebSocket message:', error);
          this.sendError(ws, 'Invalid message format');
        }
      });

      // Handle client disconnection
      ws.on('close', (code, reason) => {
        console.log('🔌 WebSocket connection closed:', code, reason);
        this.handleDisconnect(ws);
      });

      // Handle errors
      ws.on('error', (error) => {
        console.error('❌ WebSocket error:', error);
        this.handleDisconnect(ws);
      });
    });

    // Set up heartbeat to detect dead connections
    const interval = setInterval(() => {
      this.wss.clients.forEach((ws) => {
        if (ws.isAlive === false) {
          console.log('💀 Terminating dead connection');
          return ws.terminate();
        }
        
        ws.isAlive = false;
        ws.ping();
      });
    }, 30000); // Check every 30 seconds

    this.wss.on('close', () => {
      clearInterval(interval);
    });

    this.wss.on('error', (error) => {
      console.error('❌ WebSocket server error:', error);
    });

    console.log('✅ WebSocket server initialized on path /ws');
    console.log('📊 Server info:', {
      path: '/ws',
      clientTracking: this.wss.clientTracking,
      maxPayload: this.wss.options.maxPayload
    });
  }

  handleMessage(ws, data) {
    const { type, ticketId, userId, userType, message, agentName, customerName, tenantId } = data;

    // Validate required fields based on message type
    if (!type) {
      this.sendError(ws, 'Message type is required');
      return;
    }

    // Get tenantId from client info if not provided
    const clientInfo = this.clients.get(ws);
    const actualTenantId = tenantId || clientInfo?.tenantId || 1;

    switch (type) {
      case 'JOIN_TICKET':
        if (!ticketId || !userType) {
          this.sendError(ws, 'ticketId and userType are required for JOIN_TICKET');
          return;
        }
        this.joinTicketRoom(ws, ticketId, userId, userType, actualTenantId);
        break;
      
      case 'SEND_MESSAGE':
        if (!ticketId || !message || !userType) {
          this.sendError(ws, 'ticketId, message, and userType are required for SEND_MESSAGE');
          return;
        }
        this.handleSendMessage(ws, ticketId, message, userType, agentName, customerName, actualTenantId);
        break;
      
      case 'TYPING':
        if (!ticketId || !userType) {
          this.sendError(ws, 'ticketId and userType are required for TYPING');
          return;
        }
        this.handleTyping(ws, ticketId, userType, agentName, customerName, true);
        break;
      
      case 'STOP_TYPING':
        if (!ticketId || !userType) {
          this.sendError(ws, 'ticketId and userType are required for STOP_TYPING');
          return;
        }
        this.handleTyping(ws, ticketId, userType, agentName, customerName, false);
        break;
      
      default:
        console.log('❓ Unknown message type:', type);
        this.sendError(ws, `Unknown message type: ${type}`);
    }
  }

  async joinTicketRoom(ws, ticketId, userId, userType, tenantId = null) {
    try {
      console.log(`🔄 Attempting to join ticket ${ticketId} as ${userType}, tenant: ${tenantId || 'default'}`);
      
      // Validate ticket exists (tenant-filtered if tenantId provided)
      let query = 'SELECT id, status, tenant_id FROM tickets WHERE id = ?';
      let params = [ticketId];
      
      if (tenantId) {
        query += ' AND tenant_id = ?';
        params.push(tenantId);
      }
      
      const [tickets] = await pool.execute(query, params);

      if (tickets.length === 0) {
        console.log(`❌ Ticket ${ticketId} not found`);
        this.sendError(ws, 'Ticket not found');
        return;
      }

      const ticket = tickets[0];
      console.log(`✅ Ticket ${ticketId} found, status: ${ticket.status}`);

      // Store client information (with tenant_id)
      const actualTenantId = tickets[0].tenant_id || tenantId || 1;
      this.clients.set(ws, {
        ticketId,
        userId,
        userType,
        tenantId: actualTenantId,
        joinedAt: new Date()
      });

      // Create or get ticket room
      if (!this.ticketRooms.has(ticketId)) {
        this.ticketRooms.set(ticketId, new Set());
      }
      
      this.ticketRooms.get(ticketId).add(ws);
      
      console.log(`👥 User ${userType} joined ticket ${ticketId} room. Total clients: ${this.ticketRooms.get(ticketId).size}`);
      
      // Create or join chat session (with tenant_id)
      try {
        await this.createOrJoinSession(ticketId, userId, userType, userType === 'agent' ? 'Agent' : 'Customer', actualTenantId);
      } catch (sessionError) {
        console.error('⚠️ Session creation failed, but continuing:', sessionError.message);
        // Continue even if session creation fails
      }
      
      // Send confirmation to client
      ws.send(JSON.stringify({
        type: 'JOINED_ROOM',
        ticketId,
        userType,
        message: `Successfully joined ticket ${ticketId} chat room`
      }));
      
      console.log(`✅ Successfully joined ticket ${ticketId} room`);
      
    } catch (error) {
      console.error('❌ Error joining ticket room:', error);
      this.sendError(ws, 'Failed to join ticket room. Please try again.');
    }
  }

  async createOrJoinSession(ticketId, userId, userType, userName, tenantId = 1) {
    try {
      console.log(`🔄 Creating/joining session for ticket ${ticketId}, userType: ${userType}, userId: ${userId}, tenant: ${tenantId}`);
      
      // Handle non-integer user IDs (like 'admin')
      const numericUserId = userId && !isNaN(userId) ? parseInt(userId) : null;
      
      // Check if active session exists (tenant-filtered)
      let [sessions] = await pool.execute(`
        SELECT session_id FROM chat_sessions 
        WHERE ticket_id = ? AND tenant_id = ? AND status = 'active'
        LIMIT 1
      `, [ticketId, tenantId]);
      
      let sessionId;
      
      if (sessions.length === 0) {
        // Create new session
        sessionId = `session_${ticketId}_${Date.now()}`;
        
        // Use different queries based on userType to avoid SQL injection
        let insertQuery;
        let insertParams;
        
        if (userType === 'agent') {
          insertQuery = `
            INSERT INTO chat_sessions (tenant_id, ticket_id, session_id, agent_id, last_activity_at, status)
            VALUES (?, ?, ?, ?, NOW(), 'active')
          `;
          insertParams = [tenantId, ticketId, sessionId, numericUserId];
        } else if (userType === 'customer') {
          insertQuery = `
            INSERT INTO chat_sessions (tenant_id, ticket_id, session_id, customer_id, last_activity_at, status)
            VALUES (?, ?, ?, ?, NOW(), 'active')
          `;
          insertParams = [tenantId, ticketId, sessionId, numericUserId];
        } else {
          // For system or other user types, don't set specific user ID
          insertQuery = `
            INSERT INTO chat_sessions (tenant_id, ticket_id, session_id, last_activity_at, status)
            VALUES (?, ?, ?, NOW(), 'active')
          `;
          insertParams = [tenantId, ticketId, sessionId];
        }
        
        await pool.execute(insertQuery, insertParams);
        console.log(`✅ Created new session: ${sessionId}`);
      } else {
        sessionId = sessions[0].session_id;
        console.log(`✅ Using existing session: ${sessionId}`);
        
        // Update last activity (tenant-filtered)
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
      `, [tenantId, sessionId, numericUserId, userType, userName]);
      
      console.log(`✅ Successfully joined session ${sessionId} as ${userType}`);
      return sessionId;
    } catch (error) {
      console.error('❌ Error creating/joining session:', error);
      throw error;
    }
  }

  async handleSendMessage(ws, ticketId, message, userType, agentName, customerName, tenantId = 1) {
    try {
      // Save message to database first (with tenant_id)
      const savedMessage = await this.saveMessageToDatabase(ticketId, message, userType, agentName, customerName, tenantId);
      
      if (!savedMessage) {
        this.sendError(ws, 'Failed to save message');
        return;
      }

      // Broadcast message to all clients in the ticket room
      this.broadcastMessage(ticketId, {
        type: 'NEW_MESSAGE',
        ticketId,
        message,
        userType,
        agentName,
        customerName,
        messageId: savedMessage.id,
        timestamp: savedMessage.created_at
      });

      // Send confirmation to sender
      ws.send(JSON.stringify({
        type: 'MESSAGE_SENT',
        messageId: savedMessage.id,
        timestamp: savedMessage.created_at
      }));
    } catch (error) {
      console.error('❌ Error sending message:', error);
      this.sendError(ws, 'Failed to send message');
    }
  }

  async handleTyping(ws, ticketId, userType, agentName, customerName, isTyping) {
    try {
      // Get tenantId from client info
      const clientInfo = this.clients.get(ws);
      const tenantId = clientInfo?.tenantId || 1;
      
      console.log(`🔄 Updating typing status for ticket ${ticketId}, userType: ${userType}, isTyping: ${isTyping}, tenant: ${tenantId}`);
      
      // Get the actual session ID for this ticket (tenant-filtered)
      const [sessions] = await pool.execute(`
        SELECT session_id FROM chat_sessions 
        WHERE ticket_id = ? AND tenant_id = ? AND status = 'active'
        LIMIT 1
      `, [ticketId, tenantId]);
      
      if (sessions.length === 0) {
        console.log(`⚠️ No active session found for ticket ${ticketId}`);
        return;
      }
      
      const sessionId = sessions[0].session_id;
      
      // Update typing status in database - use user_type instead of user_id for non-numeric IDs (tenant-filtered)
      await pool.execute(`
        UPDATE chat_participants 
        SET is_typing = ?, last_typing_at = ?
        WHERE session_id = ? AND tenant_id = ? AND user_type = ?
      `, [isTyping, isTyping ? new Date() : null, sessionId, tenantId, userType]);

      console.log(`✅ Updated typing status for session ${sessionId}`);

      // Broadcast typing status to other users
      this.broadcastToOthers(ws, ticketId, {
        type: isTyping ? 'USER_TYPING' : 'USER_STOPPED_TYPING',
        ticketId,
        userType,
        agentName,
        customerName
      });
    } catch (error) {
      console.error('❌ Error updating typing status:', error);
      this.sendError(ws, 'Failed to update typing status');
    }
  }

  broadcastMessage(ticketId, message) {
    const room = this.ticketRooms.get(ticketId);
    if (room) {
      const messageStr = JSON.stringify(message);
      let sentCount = 0;
      
      room.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
          try {
            client.send(messageStr);
            sentCount++;
          } catch (error) {
            console.error('❌ Error sending message to client:', error);
          }
        }
      });
      
      console.log(`📢 Broadcasted message to ${sentCount}/${room.size} clients in ticket ${ticketId}`);
    } else {
      console.log(`⚠️ No active room found for ticket ${ticketId}`);
    }
  }

  broadcastToOthers(ws, ticketId, message) {
    const room = this.ticketRooms.get(ticketId);
    if (room) {
      const messageStr = JSON.stringify(message);
      let sentCount = 0;
      
      room.forEach(client => {
        if (client !== ws && client.readyState === WebSocket.OPEN) {
          try {
            client.send(messageStr);
            sentCount++;
          } catch (error) {
            console.error('❌ Error sending message to client:', error);
          }
        }
      });
      
      console.log(`📢 Broadcasted to ${sentCount} other clients in ticket ${ticketId}`);
    }
  }

  async saveMessageToDatabase(ticketId, message, userType, agentName, customerName, tenantId = 1) {
    try {
      const senderType = userType === 'customer' ? 'customer' : 'agent';
      const senderName = userType === 'customer' ? customerName : agentName;
      
      // Get tenant_id from ticket if not provided
      if (!tenantId) {
        const [tickets] = await pool.execute(
          'SELECT tenant_id FROM tickets WHERE id = ?',
          [ticketId]
        );
        tenantId = tickets.length > 0 ? tickets[0].tenant_id : 1;
      }
      
      const [result] = await pool.execute(
        'INSERT INTO chat_messages (tenant_id, ticket_id, sender_type, sender_name, message) VALUES (?, ?, ?, ?, ?)',
        [tenantId, ticketId, senderType, senderName, message]
      );
      
      // Get the inserted message
      const [messages] = await pool.execute(
        'SELECT * FROM chat_messages WHERE id = ?',
        [result.insertId]
      );
      
      console.log(`💾 Saved message to chat_messages for ticket ${ticketId}`);
      return messages[0];
    } catch (error) {
      console.error('❌ Error saving message to database:', error);
      return null;
    }
  }

  sendError(ws, message) {
    try {
      ws.send(JSON.stringify({
        type: 'ERROR',
        message: message,
        timestamp: new Date().toISOString()
      }));
    } catch (error) {
      console.error('❌ Error sending error message:', error);
    }
  }

  handleDisconnect(ws) {
    const clientInfo = this.clients.get(ws);
    if (clientInfo) {
      const { ticketId, userType } = clientInfo;
      
      // Remove from ticket room
      const room = this.ticketRooms.get(ticketId);
      if (room) {
        room.delete(ws);
        if (room.size === 0) {
          this.ticketRooms.delete(ticketId);
          console.log(`🏁 Last user left ticket ${ticketId}, room closed`);
        }
      }
      
      // Remove from clients map
      this.clients.delete(ws);
      
      console.log(`👋 Client disconnected from ticket ${ticketId}`);
    }
  }

  // Get connected clients count for a ticket
  getTicketClientsCount(ticketId) {
    const room = this.ticketRooms.get(ticketId);
    return room ? room.size : 0;
  }

  // Get all connected clients info
  getConnectedClients() {
    const clients = [];
    this.clients.forEach((info, ws) => {
      clients.push({
        ...info,
        connected: ws.readyState === WebSocket.OPEN
      });
    });
    return clients;
  }

  // Get server statistics
  getServerStats() {
    return {
      totalConnections: this.clients.size,
      activeRooms: this.ticketRooms.size,
      connectedClients: this.getConnectedClients()
    };
  }
}

module.exports = WebSocketServer; 