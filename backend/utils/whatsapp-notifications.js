const axios = require('axios');

// WhatsApp API configuration
const WHATSAPP_API_URL = process.env.WHATSAPP_API_URL || 'https://graph.facebook.com/v18.0';
const WHATSAPP_PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID || "521803094347148";
const WHATSAPP_ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;

// Add timeout and retry configuration
const axiosConfig = {
  timeout: 10000, // 10 seconds
  headers: {
    'Authorization': `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
    'Content-Type': 'application/json'
  }
};

// Get base URL for links (matches emailService)
function getAppUrl() {
  return process.env.PUBLIC_BASE_URL || 'http://localhost:3000';
}

// Notification for ticket creation
async function sendTicketCreatedNotification(ticket) {
  if (!ticket.mobile) return null;
  const baseUrl = getAppUrl();
  const whatsappMessage = `🆕 *Ticket Created*\n\n` +
    `🎫 *Ticket ID:* #${ticket.id}\n` +
    `🏷️ *Issue:* ${ticket.issue_title || 'Support Request'}\n\n` +
    `Your support ticket has been created. We'll assign an agent shortly.\n\n` +
    `🔗 *View Ticket:* ${baseUrl}/chat/${ticket.id}\n\n` +
    `Thank you for contacting us!`;
  return await sendWhatsAppMessage(ticket.mobile, whatsappMessage);
}

// Function to send WhatsApp message
async function sendWhatsAppMessage(phoneNumber, message) {
  try {
    // Check if WhatsApp is properly configured
    if (!WHATSAPP_ACCESS_TOKEN || !WHATSAPP_PHONE_NUMBER_ID) {
      console.log('❌ WhatsApp API not configured');
      return null;
    }

    // Format phone number for WhatsApp API (remove + and ensure proper format)
    let formattedPhone = phoneNumber;
    if (formattedPhone.startsWith('+')) {
      formattedPhone = formattedPhone.substring(1);
    }
    
    // Ensure it's a valid international format
    if (formattedPhone.length < 10) {
      console.log(`❌ Invalid phone number format: ${phoneNumber}`);
      return null;
    }

    console.log(`📤 Sending WhatsApp notification to ${formattedPhone} (original: ${phoneNumber})`);

    const response = await axios.post(
      `${WHATSAPP_API_URL}/${WHATSAPP_PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: 'whatsapp',
        to: formattedPhone,
        type: 'text',
        text: {
          body: message
        }
      },
      axiosConfig
    );

    console.log('✅ WhatsApp notification sent successfully');
    return response.data;
  } catch (error) {
    console.error('❌ Error sending WhatsApp notification:', error.response?.data || error.message);
    return null;
  }
}

// Notification for agent replies
async function sendAgentReplyNotification(ticket, agentName, message) {
  if (!ticket.mobile) return null;
  
  // Format the message for better readability
  const formattedMessage = message.length > 100 ? 
    message.substring(0, 100) + '...' : message;
  
  const baseUrl = getAppUrl();
  const whatsappMessage = `🔔 *New Reply from Support Team*\n\n` +
    `🎫 *Ticket:* #${ticket.id}\n` +
    `🏷️ *Issue:* ${ticket.issue_title}\n` +
    `👨‍💼 *Agent:* ${agentName}\n\n` +
    `💬 *Reply:*\n${formattedMessage}\n\n` +
    `📱 *Want to continue chatting?*\n` +
    `Reply to this message or open the app for full conversation.\n\n` +
    `🔗 *App Link:* ${baseUrl}/chat/${ticket.id}\n\n` +
    `Thank you for your patience! 🙏`;
  
  return await sendWhatsAppMessage(ticket.mobile, whatsappMessage);
}

// Notification for ticket status updates
async function sendStatusUpdateNotification(ticket, newStatus) {
  if (!ticket.mobile) return null;
  
  const statusEmoji = {
    'new': '🆕',
    'in_progress': '⏳',
    'closed': '✅',
    'escalated': '🚨'
  };
  
  const statusText = {
    'new': 'New',
    'in_progress': 'In Progress',
    'closed': 'Resolved',
    'escalated': 'Escalated'
  };
  
  const baseUrl = getAppUrl();
  const whatsappMessage = `📋 *Ticket Status Update*\n\n` +
    `🎫 *Ticket ID:* #${ticket.id}\n` +
    `🏷️ *Issue:* ${ticket.issue_title}\n` +
    `📊 *Status:* ${statusEmoji[newStatus]} ${statusText[newStatus]}\n\n` +
    `Your ticket has been updated. We'll keep you informed of any progress!\n\n` +
    `🔗 *View Details:* ${baseUrl}/chat/${ticket.id}`;
  
  return await sendWhatsAppMessage(ticket.mobile, whatsappMessage);
}

// Notification for ticket assignment
async function sendAssignmentNotification(ticket, agentName) {
  if (!ticket.mobile) return null;
  const baseUrl = getAppUrl();
  const whatsappMessage = `👨‍💼 *Ticket Assigned*\n\n` +
    `🎫 *Ticket ID:* #${ticket.id}\n` +
    `🏷️ *Issue:* ${ticket.issue_title}\n` +
    `👨‍💼 *Assigned to:* ${agentName}\n\n` +
    `Your ticket has been assigned to a support agent who will assist you shortly.\n\n` +
    `🔗 *View Details:* ${baseUrl}/chat/${ticket.id}`;
  
  return await sendWhatsAppMessage(ticket.mobile, whatsappMessage);
}

// Notification for ticket escalation
async function sendEscalationNotification(ticket, reason = '') {
  if (!ticket.mobile) return null;
  const baseUrl = getAppUrl();
  const whatsappMessage = `🚨 *Ticket Escalated*\n\n` +
    `🎫 *Ticket ID:* #${ticket.id}\n` +
    `🏷️ *Issue:* ${ticket.issue_title}\n` +
    `📊 *Status:* Escalated to Senior Support\n\n` +
    `${reason ? `📝 *Reason:* ${reason}\n\n` : ''}` +
    `Your ticket has been escalated for specialized attention. We'll get back to you soon.\n\n` +
    `🔗 *View Details:* ${baseUrl}/chat/${ticket.id}`;
  
  return await sendWhatsAppMessage(ticket.mobile, whatsappMessage);
}

// Notification for ticket resolution
async function sendResolutionNotification(ticket, resolution = '') {
  if (!ticket.mobile) return null;
  const baseUrl = getAppUrl();
  const whatsappMessage = `✅ *Ticket Resolved*\n\n` +
    `🎫 *Ticket ID:* #${ticket.id}\n` +
    `🏷️ *Issue:* ${ticket.issue_title}\n` +
    `📊 *Status:* Resolved\n\n` +
    `${resolution ? `💡 *Resolution:* ${resolution}\n\n` : ''}` +
    `Your ticket has been resolved. Thank you for using our support service!\n\n` +
    `🔗 *View Details:* ${baseUrl}/chat/${ticket.id}\n\n` +
    `📝 *Rate your experience:* ${baseUrl}/feedback/${ticket.id}`;
  
  return await sendWhatsAppMessage(ticket.mobile, whatsappMessage);
}

// Notification for SLA breach warning
async function sendSLABreachWarning(ticket, slaTime) {
  if (!ticket.mobile) return null;
  const baseUrl = getAppUrl();
  const whatsappMessage = `⏰ *SLA Warning*\n\n` +
    `🎫 *Ticket ID:* #${ticket.id}\n` +
    `🏷️ *Issue:* ${ticket.issue_title}\n` +
    `⏱️ *SLA Time:* ${slaTime} minutes\n\n` +
    `Your ticket is approaching the SLA time limit. We're working to resolve it quickly.\n\n` +
    `🔗 *View Details:* ${baseUrl}/chat/${ticket.id}`;
  
  return await sendWhatsAppMessage(ticket.mobile, whatsappMessage);
}

// Notification for customer satisfaction request
async function sendSatisfactionRequest(ticket) {
  if (!ticket.mobile) return null;
  const baseUrl = getAppUrl();
  const whatsappMessage = `⭐ *Rate Your Experience*\n\n` +
    `🎫 *Ticket ID:* #${ticket.id}\n` +
    `🏷️ *Issue:* ${ticket.issue_title}\n\n` +
    `How was your support experience? Please rate us:\n\n` +
    `🔗 *Rate Now:* ${baseUrl}/feedback/${ticket.id}\n\n` +
    `Your feedback helps us improve our service! 🙏`;
  
  return await sendWhatsAppMessage(ticket.mobile, whatsappMessage);
}

module.exports = {
  sendWhatsAppMessage,
  sendTicketCreatedNotification,
  sendAgentReplyNotification,
  sendStatusUpdateNotification,
  sendAssignmentNotification,
  sendEscalationNotification,
  sendResolutionNotification,
  sendSLABreachWarning,
  sendSatisfactionRequest
};
