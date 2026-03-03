import React, { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { getAuthHeaders, authenticatedFetch } from '../../utils/api';
import TicketChat from './TicketChat';
import './CustomerChatPage.css';

const CustomerChatPage = ({ user: propUser }) => {
  const { ticketId } = useParams();
  const navigate = useNavigate();
  const [ticket, setTicket] = useState(null);
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    console.log('🔍 CustomerChatPage: Starting user detection...');
    
    // First try to use the user prop from App.js
    if (propUser) {
      console.log('✅ Using user prop from App.js:', propUser);
      setUser(propUser);
    } else {
      console.log('🔍 No user prop, checking localStorage...');
      
      // Check for userData (JSON format)
      const storedUser = localStorage.getItem('userData');
      if (storedUser) {
        try {
          const userData = JSON.parse(storedUser);
          console.log('✅ Found userData in localStorage:', userData);
          setUser(userData);
        } catch (error) {
          console.error('Error parsing stored user data:', error);
          setError('User data error');
          setLoading(false);
          return;
        }
      } else {
        console.log('🔍 No userData, checking individual localStorage items...');
        
        // Check for individual localStorage items (UserDashboard format)
        const userId = localStorage.getItem('user_id');
        const userName = localStorage.getItem('user_name');
        const userEmail = localStorage.getItem('user_email');
        const userRole = localStorage.getItem('user_role');
        
        if (userId && userName && userEmail) {
          const individualUser = {
            id: userId,
            name: userName,
            email: userEmail,
            role: userRole || 'user'
          };
          console.log('✅ Found individual user items in localStorage:', individualUser);
          setUser(individualUser);
        } else {
          console.log('🔍 No individual items, checking legacy format...');
          
          // Check for legacy user format
          const legacyUser = localStorage.getItem('tickUser');
          if (legacyUser) {
            try {
              const legacyUserData = JSON.parse(legacyUser);
              console.log('✅ Found legacy user data:', legacyUserData);
              setUser(legacyUserData);
            } catch (error) {
              console.error('Error parsing legacy user data:', error);
              setError('User data error');
              setLoading(false);
              return;
            }
          } else {
            console.log('🔍 No legacy data, checking auto-login context...');
            
            // Check for auto-login context
            const autoLoginContext = localStorage.getItem('autoLoginContext');
            if (autoLoginContext) {
              try {
                const context = JSON.parse(autoLoginContext);
                console.log('✅ Found auto-login context:', context);
                
                // Try to get user data from auto-login context
                const autoLoginUser = {
                  id: localStorage.getItem('user_id'),
                  name: localStorage.getItem('user_name'),
                  email: localStorage.getItem('user_email'),
                  role: localStorage.getItem('user_role') || 'user'
                };
                
                if (autoLoginUser.id && autoLoginUser.name && autoLoginUser.email) {
                  console.log('✅ Using auto-login user data:', autoLoginUser);
                  setUser(autoLoginUser);
                } else {
                  console.log('❌ Auto-login context found but user data incomplete');
                  setError('User not found');
                  setLoading(false);
                  return;
                }
              } catch (error) {
                console.error('Error parsing auto-login context:', error);
                setError('User data error');
                setLoading(false);
                return;
              }
            } else {
              console.log('❌ No user data found in any storage location');
              console.log('🔍 Available localStorage keys:', Object.keys(localStorage));
              setError('User not found');
              setLoading(false);
              return;
            }
          }
        }
      }
    }

    // Test token validity first, then fetch ticket data
    testTokenAndFetchTicket();
  }, [ticketId]);

  const testTokenAndFetchTicket = async () => {
    // Fetch the ticket directly (skip token test for now)
    fetchTicket();
  };

  const fetchTicket = async () => {
    try {
      console.log('🔍 Fetching ticket data for ID:', ticketId);
      
      const headers = getAuthHeaders();
      console.log('🔑 Using auth headers for ticket fetch');
      
      const response = await fetch(`http://localhost:5000/api/tickets/${ticketId}`, {
        method: 'GET',
        headers: headers
      });
      
      console.log('📡 Response status:', response.status);
      
      if (response.status === 401) {
        console.error('❌ Unauthorized - Token might be invalid or missing');
        setError('Authentication required. Please log in again.');
        setLoading(false);
        return;
      }
      
      if (response.status === 404) {
        console.error('❌ Ticket not found');
        setError('Ticket not found');
        setLoading(false);
        return;
      }
      
      const data = await response.json();
      console.log('📋 Response data:', data);
      
      if (data.success) {
        setTicket(data.data);
      } else {
        setError(data.message || 'Ticket not found');
      }
    } catch (error) {
      console.error('❌ Error fetching ticket:', error);
      setError('Failed to load ticket');
    } finally {
      setLoading(false);
    }
  };

  const handleBackToDashboard = () => {
    navigate('/userdashboard');
  };

  if (loading) {
    return (
      <div className="customer-chat-loading">
        <div className="loading-spinner"></div>
        <p>Loading chat...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="customer-chat-error">
        <div className="error-icon">❌</div>
        <h3>Error</h3>
        <p>{error}</p>
        <button className="back-btn" onClick={handleBackToDashboard}>
          ← Back to Dashboard
        </button>
      </div>
    );
  }

  if (!ticket) {
    return (
      <div className="customer-chat-error">
        <div className="error-icon">❌</div>
        <h3>Ticket Not Found</h3>
        <p>The requested ticket could not be found.</p>
        <button className="back-btn" onClick={handleBackToDashboard}>
          ← Back to Dashboard
        </button>
      </div>
    );
  }

  return (
    <div className="customer-chat-page">
      {/* Header */}
      <div className="chat-page-header">
        <div className="header-content">
          <button className="back-button" onClick={handleBackToDashboard}>
            ← Back to Dashboard
          </button>
          <div className="ticket-info">
            <h1>💬 Support Chat - Ticket #{ticket.id}</h1>
            <div className="ticket-meta">
              <span className="ticket-title">{ticket.issue_title || 'Untitled Ticket'}</span>
              <span className="ticket-status">{ticket.status}</span>
            </div>
          </div>
        </div>
      </div>

      {/* Chat Interface - Using Working TicketChat Component */}
      <div className="chat-interface">
        <TicketChat
          ticket={ticket}
          user={user}
          userType="customer"
          onClose={handleBackToDashboard}
          onReplyAdded={() => {}}
          showChatButton={false}
          awsStyle={true}
        />
      </div>
    </div>
  );
};

export default CustomerChatPage;
