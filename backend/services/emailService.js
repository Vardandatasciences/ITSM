const nodemailer = require('nodemailer');
require('dotenv').config({ path: './config.env' });

class EmailService {
  constructor() {
    this.transporter = null;
    this.initializeTransporter();
  }

  /**
   * Get base URL for public ticket links (SMTP confirmations, etc.)
   * Uses PUBLIC_BASE_URL, or falls back to localhost:3000
   */
  getAppUrl() {
    return process.env.PUBLIC_BASE_URL || 'http://localhost:3000';
  }

  /**
   * Get SMTP auth: prefer SMTP_* vars, fallback to legacy EMAIL_*
   */
  _getSmtpConfig() {
    const user = process.env.SMTP_EMAIL || process.env.EMAIL_USER;
    const pass = process.env.SMTP_PASSWORD || process.env.EMAIL_PASS;
    const fromName = process.env.EMAIL_FROM_NAME || 'ITSM Support Team';
    const fromAddress = process.env.SMTP_EMAIL || process.env.EMAIL_FROM_ADDRESS || user;
    return { user, pass, fromName, fromAddress };
  }

  initializeTransporter() {
    try {
      const { user, pass } = this._getSmtpConfig();
      if (!user || !pass) {
        console.warn('⚠️ SMTP credentials not configured (SMTP_EMAIL/SMTP_PASSWORD or EMAIL_USER/EMAIL_PASS). Email sending disabled.');
        return;
      }

      this.transporter = nodemailer.createTransport({
        host: process.env.SMTP_SERVER || process.env.EMAIL_HOST || 'smtp.gmail.com',
        port: parseInt(process.env.SMTP_PORT || process.env.EMAIL_PORT) || 587,
        secure: (process.env.SMTP_PORT || process.env.EMAIL_PORT) === '465',
        auth: { user, pass },
        tls: { rejectUnauthorized: false }
      });

      console.log('✅ Email service (SMTP) initialized successfully');
    } catch (error) {
      console.error('❌ Error initializing email service:', error);
    }
  }

  // Send welcome email to first-time support URL users (with personalized URL to save)
  async sendSupportWelcomeEmail(customerEmail, customerName, productSlug, personalizedUrl) {
    try {
      if (!this.transporter) {
        console.warn('⚠️ Email transporter not initialized, skipping support welcome email');
        return { success: false, error: 'Email not configured' };
      }

      const { fromName, fromAddress } = this._getSmtpConfig();
      const subject = 'Welcome to ITSM Support – Your personalized support link';

      const htmlContent = `
        <!DOCTYPE html>
        <html lang="en">
        <head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
        <body style="font-family:Arial,sans-serif;line-height:1.6;color:#333;max-width:600px;margin:0 auto;padding:20px;background:#f4f4f4">
          <div style="background:white;padding:30px;border-radius:10px;box-shadow:0 2px 10px rgba(0,0,0,0.1)">
            <div style="text-align:center;padding-bottom:20px;border-bottom:2px solid #e2e8f0;margin-bottom:30px">
              <div style="font-size:24px;font-weight:bold;color:#3b82f6;margin-bottom:10px">🎫 ITSM Support</div>
              <h1>Welcome to Our Support Platform</h1>
            </div>
            <p>Hi <strong>${customerName || 'Customer'}</strong>,</p>
            <p>Welcome to our support platform! You can use this link anytime you need to raise a ticket or view your support requests.</p>
            <div style="background:#f8fafc;padding:20px;border-radius:8px;margin:20px 0;border-left:4px solid #3b82f6">
              <p style="margin:0 0 10px 0;font-weight:bold">Your personalized support URL:</p>
              <p style="margin:0;word-break:break-all"><a href="${personalizedUrl}" style="color:#3b82f6">${personalizedUrl}</a></p>
              <p style="margin:10px 0 0 0;font-size:14px;color:#6b7280">Save this link for quick access whenever you need support.</p>
            </div>
            <div style="text-align:center;margin-top:25px">
              <a href="${personalizedUrl}" style="display:inline-block;background:#3b82f6;color:white;padding:12px 30px;text-decoration:none;border-radius:6px;font-weight:bold">Open Support</a>
            </div>
            <p style="margin-top:30px;color:#6b7280;font-size:14px">This is an automated email. Please do not reply.</p>
          </div>
        </body>
        </html>
      `;

      const textContent = `Hi ${customerName || 'Customer'},\n\nWelcome to our support platform! Save this URL to access support whenever you need:\n\n${personalizedUrl}\n\nDo not reply to this email.`;

      const mailOptions = {
        from: `"${fromName}" <${fromAddress}>`,
        to: customerEmail,
        subject,
        text: textContent,
        html: htmlContent
      };

      const result = await this.transporter.sendMail(mailOptions);
      console.log(`✅ Support welcome email sent to ${customerEmail}`);
      return { success: true, messageId: result.messageId };
    } catch (error) {
      console.error('❌ Error sending support welcome email:', error);
      return { success: false, error: error.message };
    }
  }

  // Send ticket creation confirmation with public link
  async sendTicketConfirmation(customerEmail, customerName, ticketId, ticketTitle, appUrl) {
    try {
      if (!this.transporter) {
        console.warn('⚠️ Email transporter not initialized, skipping ticket confirmation');
        return { success: false, error: 'Email not configured' };
      }

      const url = appUrl || this.getAppUrl();
      const { fromName, fromAddress } = this._getSmtpConfig();

      const subject = `Support Ticket #${ticketId} Created`;
      const htmlContent = `
        <!DOCTYPE html>
        <html lang="en">
        <head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
        <body style="font-family:Arial,sans-serif;line-height:1.6;color:#333;max-width:600px;margin:0 auto;padding:20px;background:#f4f4f4">
          <div style="background:white;padding:30px;border-radius:10px;box-shadow:0 2px 10px rgba(0,0,0,0.1)">
            <div style="text-align:center;padding-bottom:20px;border-bottom:2px solid #e2e8f0;margin-bottom:30px">
              <div style="font-size:24px;font-weight:bold;color:#3b82f6;margin-bottom:10px">🎫 ITSM Support</div>
              <h1>Ticket Confirmed</h1>
            </div>
            <p>Hi <strong>${customerName || 'Customer'}</strong>,</p>
            <p>Your support ticket has been created successfully.</p>
            <div style="background:#f8fafc;padding:20px;border-radius:8px;margin:20px 0;border-left:4px solid #3b82f6">
              <p><strong>Ticket ID:</strong> #${ticketId}</p>
              <p><strong>Subject:</strong> ${ticketTitle || 'No subject'}</p>
            </div>
            <div style="text-align:center">
              <a href="${url}/ticket/${ticketId}" style="display:inline-block;background:#3b82f6;color:white;padding:12px 30px;text-decoration:none;border-radius:6px;font-weight:bold">📱 View Ticket</a>
            </div>
            <p style="margin-top:30px;color:#6b7280;font-size:14px">This is an automated email. Please do not reply.</p>
          </div>
        </body>
        </html>
      `;
      const textContent = `Hi ${customerName || 'Customer'},\n\nYour support ticket #${ticketId} has been created.\nSubject: ${ticketTitle || 'No subject'}\n\nView your ticket: ${url}/ticket/${ticketId}\n\nDo not reply to this email.`;

      const mailOptions = {
        from: `"${fromName}" <${fromAddress}>`,
        to: customerEmail,
        subject,
        text: textContent,
        html: htmlContent
      };

      const result = await this.transporter.sendMail(mailOptions);
      console.log(`✅ Ticket confirmation sent to ${customerEmail} for ticket #${ticketId}`);
      return { success: true, messageId: result.messageId };
    } catch (error) {
      console.error('❌ Error sending ticket confirmation:', error);
      return { success: false, error: error.message };
    }
  }

  // Send email notification to customer when agent replies
  async sendAgentReplyNotification(customerEmail, customerName, ticketId, ticketTitle, agentName, agentMessage, appUrl) {
    try {
      if (!this.transporter) {
        throw new Error('Email transporter not initialized');
      }

      const baseUrl = appUrl || this.getAppUrl();
      const subject = `New Reply on Your Support Ticket #${ticketId}`;
      
      const htmlContent = `
        <!DOCTYPE html>
        <html lang="en">
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>New Reply from Support</title>
          <style>
            body {
              font-family: Arial, sans-serif;
              line-height: 1.6;
              color: #333;
              max-width: 600px;
              margin: 0 auto;
              padding: 20px;
              background-color: #f4f4f4;
            }
            .email-container {
              background: white;
              padding: 30px;
              border-radius: 10px;
              box-shadow: 0 2px 10px rgba(0,0,0,0.1);
            }
            .header {
              text-align: center;
              padding-bottom: 20px;
              border-bottom: 2px solid #e2e8f0;
              margin-bottom: 30px;
            }
            .logo {
              font-size: 24px;
              font-weight: bold;
              color: #3b82f6;
              margin-bottom: 10px;
            }
            .ticket-info {
              background: #f8fafc;
              padding: 20px;
              border-radius: 8px;
              margin: 20px 0;
              border-left: 4px solid #3b82f6;
            }
            .agent-reply {
              background: #ecfdf5;
              padding: 20px;
              border-radius: 8px;
              margin: 20px 0;
              border-left: 4px solid #10b981;
            }
            .cta-button {
              display: inline-block;
              background: #3b82f6;
              color: white;
              padding: 12px 30px;
              text-decoration: none;
              border-radius: 6px;
              margin: 20px 0;
              font-weight: bold;
            }
            .footer {
              text-align: center;
              margin-top: 30px;
              padding-top: 20px;
              border-top: 1px solid #e2e8f0;
              color: #6b7280;
              font-size: 14px;
            }
            .warning {
              background: #fef3c7;
              padding: 15px;
              border-radius: 6px;
              margin: 20px 0;
              border-left: 4px solid #f59e0b;
            }
          </style>
        </head>
        <body>
          <div class="email-container">
            <div class="header">
              <div class="logo">🎫 ITSM Support</div>
              <h1>You've Got a Reply!</h1>
            </div>

            <p>Hi <strong>${customerName}</strong>,</p>
            
            <p>Great news! Our support agent <strong>${agentName}</strong> has replied to your support ticket.</p>

            <div class="ticket-info">
              <h3>📋 Ticket Details</h3>
              <p><strong>Ticket ID:</strong> #${ticketId}</p>
              <p><strong>Subject:</strong> ${ticketTitle}</p>
              <p><strong>Agent:</strong> ${agentName}</p>
            </div>

            <div class="agent-reply">
              <h3>💬 Agent's Reply</h3>
              <p>${agentMessage.length > 200 ? agentMessage.substring(0, 200) + '...' : agentMessage}</p>
            </div>

            <div style="text-align: center;">
              <a href="${baseUrl}/ticket/${ticketId}" class="cta-button">
                📱 View & Reply in App
              </a>
            </div>

            <div class="warning">
              <p><strong>⚡ Quick Response Needed!</strong></p>
              <p>To ensure faster resolution, please respond via our app rather than replying to this email.</p>
            </div>

            <p>Thank you for using our support system. We're here to help!</p>

            <div class="footer">
              <p>🔒 This email was sent from an automated system. Please do not reply to this email.</p>
              <p>© 2024 ITSM Support Team. All rights reserved.</p>
            </div>
          </div>
        </body>
        </html>
      `;

      const textContent = `
Hi ${customerName},

You've received a new reply from our support agent ${agentName} on your ticket #${ticketId}.

Ticket: ${ticketTitle}
Agent: ${agentName}

Reply: ${agentMessage}

To view the full conversation and respond, please visit: ${baseUrl}/ticket/${ticketId}

Please respond via our app for faster resolution.

Thank you!
ITSM Support Team

Note: This is an automated email. Please do not reply to this email.
      `;

      const { fromName, fromAddress } = this._getSmtpConfig();

      const mailOptions = {
        from: `"${fromName}" <${fromAddress}>`,
        to: customerEmail,
        subject: subject,
        text: textContent,
        html: htmlContent
      };

      const result = await this.transporter.sendMail(mailOptions);
      console.log(`✅ Email sent successfully to ${customerEmail} for ticket #${ticketId}`);
      return { success: true, messageId: result.messageId };

    } catch (error) {
      console.error('❌ Error sending email notification:', error);
      return { success: false, error: error.message };
    }
  }

  // Send welcome email to new customers
  async sendWelcomeEmail(customerEmail, customerName) {
    try {
      if (!this.transporter) {
        throw new Error('Email transporter not initialized');
      }

      const subject = 'Welcome to ITSM Support!';
      
      const htmlContent = `
        <!DOCTYPE html>
        <html lang="en">
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>Welcome to ITSM Support</title>
          <style>
            body {
              font-family: Arial, sans-serif;
              line-height: 1.6;
              color: #333;
              max-width: 600px;
              margin: 0 auto;
              padding: 20px;
              background-color: #f4f4f4;
            }
            .email-container {
              background: white;
              padding: 30px;
              border-radius: 10px;
              box-shadow: 0 2px 10px rgba(0,0,0,0.1);
            }
            .header {
              text-align: center;
              padding-bottom: 20px;
              border-bottom: 2px solid #e2e8f0;
              margin-bottom: 30px;
            }
            .logo {
              font-size: 24px;
              font-weight: bold;
              color: #3b82f6;
              margin-bottom: 10px;
            }
            .feature-list {
              background: #f8fafc;
              padding: 20px;
              border-radius: 8px;
              margin: 20px 0;
            }
            .footer {
              text-align: center;
              margin-top: 30px;
              padding-top: 20px;
              border-top: 1px solid #e2e8f0;
              color: #6b7280;
              font-size: 14px;
            }
          </style>
        </head>
        <body>
          <div class="email-container">
            <div class="header">
              <div class="logo">🎫 ITSM Support</div>
              <h1>Welcome Aboard!</h1>
            </div>

            <p>Hi <strong>${customerName}</strong>,</p>
            
            <p>Welcome to our ITSM Support system! We're excited to help you with all your support needs.</p>

            <div class="feature-list">
              <h3>🚀 What you can do:</h3>
              <ul>
                <li>📝 Create support tickets easily</li>
                <li>💬 Chat with our support agents</li>
                <li>📊 Track your ticket status</li>
                <li>📧 Get email notifications for replies</li>
                <li>📱 Access from any device</li>
              </ul>
            </div>

            <p>If you have any questions or need assistance, don't hesitate to create a support ticket.</p>

            <p>Thank you for choosing our support system!</p>

            <div class="footer">
              <p>© 2024 ITSM Support Team. All rights reserved.</p>
            </div>
          </div>
        </body>
        </html>
      `;

      const { fromName, fromAddress } = this._getSmtpConfig();
      const mailOptions = {
        from: `"${fromName}" <${fromAddress}>`,
        to: customerEmail,
        subject: subject,
        html: htmlContent
      };

      const result = await this.transporter.sendMail(mailOptions);
      console.log(`✅ Welcome email sent to ${customerEmail}`);
      return { success: true, messageId: result.messageId };

    } catch (error) {
      console.error('❌ Error sending welcome email:', error);
      return { success: false, error: error.message };
    }
  }

  // Send email notification to agent when assigned a new ticket
  async sendAgentAssignmentNotification(agentEmail, agentName, ticketId, customerName, ticketTitle, appUrl) {
    try {
      if (!this.transporter) {
        throw new Error('Email transporter not initialized');
      }

      const baseUrl = appUrl || this.getAppUrl();
      const { fromName, fromAddress } = this._getSmtpConfig();
      const subject = `New Ticket Assignment - Ticket #${ticketId}`;
      
      const htmlContent = `
        <!DOCTYPE html>
        <html lang="en">
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>New Ticket Assignment</title>
          <style>
            body {
              font-family: Arial, sans-serif;
              line-height: 1.6;
              color: #333;
              max-width: 600px;
              margin: 0 auto;
              padding: 20px;
              background-color: #f4f4f4;
            }
            .email-container {
              background: white;
              padding: 30px;
              border-radius: 10px;
              box-shadow: 0 2px 10px rgba(0,0,0,0.1);
            }
            .header {
              text-align: center;
              padding-bottom: 20px;
              border-bottom: 2px solid #e2e8f0;
              margin-bottom: 30px;
            }
            .logo {
              font-size: 24px;
              font-weight: bold;
              color: #3b82f6;
              margin-bottom: 10px;
            }
            .ticket-info {
              background: #f8fafc;
              padding: 20px;
              border-radius: 8px;
              margin: 20px 0;
              border-left: 4px solid #3b82f6;
            }
            .assignment-notice {
              background: #ecfdf5;
              padding: 20px;
              border-radius: 8px;
              margin: 20px 0;
              border-left: 4px solid #10b981;
            }
            .cta-button {
              display: inline-block;
              background: #3b82f6;
              color: white;
              padding: 12px 30px;
              text-decoration: none;
              border-radius: 6px;
              margin: 20px 0;
              font-weight: bold;
            }
            .footer {
              text-align: center;
              margin-top: 30px;
              padding-top: 20px;
              border-top: 1px solid #e2e8f0;
              color: #6b7280;
              font-size: 14px;
            }
            .priority {
              background: #fef3c7;
              padding: 15px;
              border-radius: 6px;
              margin: 20px 0;
              border-left: 4px solid #f59e0b;
            }
          </style>
        </head>
        <body>
          <div class="email-container">
            <div class="header">
              <div class="logo">🎫 ITSM Support</div>
              <h1>New Ticket Assignment</h1>
            </div>

            <p>Hi <strong>${agentName}</strong>,</p>
            
            <p>You have been assigned a new support ticket. Please review and respond as soon as possible.</p>

            <div class="assignment-notice">
              <h3>🎯 New Assignment</h3>
              <p><strong>You have a newly assigned ticket</strong></p>
            </div>

            <div class="ticket-info">
              <h3>📋 Ticket Details</h3>
              <p><strong>Ticket ID:</strong> #${ticketId}</p>
              <p><strong>Customer:</strong> ${customerName}</p>
              <p><strong>Subject:</strong> ${ticketTitle}</p>
              <p><strong>Assigned to:</strong> ${agentName}</p>
            </div>

            <div class="priority">
              <p><strong>⚡ Action Required!</strong></p>
              <p>Please log into your dashboard to view the full ticket details and respond to the customer.</p>
            </div>

            <div style="text-align: center;">
              <a href="${baseUrl}/agent-dashboard" class="cta-button">
                📱 View Ticket in Dashboard
              </a>
            </div>

            <p>Thank you for your prompt attention to this ticket.</p>

            <div class="footer">
              <p>🔒 This email was sent from an automated system. Please do not reply to this email.</p>
              <p>© 2024 ITSM Support Team. All rights reserved.</p>
            </div>
          </div>
        </body>
        </html>
      `;

      const textContent = `
Hi ${agentName},

You have a newly assigned ticket.

Ticket Details:
- Ticket ID: #${ticketId}
- Customer: ${customerName}
- Subject: ${ticketTitle}
- Assigned to: ${agentName}

Please log into your dashboard to view the full ticket details and respond to the customer.

Dashboard: ${baseUrl}/agent-dashboard

Thank you for your prompt attention to this ticket.

ITSM Support Team

Note: This is an automated email. Please do not reply to this email.
      `;

      const mailOptions = {
        from: `"${fromName}" <${fromAddress}>`,
        to: agentEmail,
        subject: subject,
        text: textContent,
        html: htmlContent
      };

      const result = await this.transporter.sendMail(mailOptions);
      console.log(`✅ Agent assignment email sent successfully to ${agentEmail} for ticket #${ticketId}`);
      return { success: true, messageId: result.messageId };

    } catch (error) {
      console.error('❌ Error sending agent assignment email:', error);
      return { success: false, error: error.message };
    }
  }

  // Test email configuration
  async testEmailConfig() {
    try {
      if (!this.transporter) {
        throw new Error('Email transporter not initialized');
      }

      await this.transporter.verify();
      console.log('✅ Email configuration is valid');
      return { success: true, message: 'Email configuration is valid' };
    } catch (error) {
      console.error('❌ Email configuration test failed:', error);
      return { success: false, error: error.message };
    }
  }
}

module.exports = new EmailService();
