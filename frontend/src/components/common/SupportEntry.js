import React, { useEffect, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { buildApiUrl } from '../../utils/api';
import UserDashboard from '../dashboards/UserDashboard';
import './SupportEntry.css';

/**
 * Universal Support URL Entry Point (UTM-based)
 * Handles URLs like: https://itsm.vardands.com/{utm}?user_email={email}
 * Path uses utm_description (e.g. GRC, VOC) for secure product identification.
 */
const SupportEntry = ({ onLogin }) => {
  const { product: productUtm } = useParams();
  const [searchParams] = useSearchParams();
  const [status, setStatus] = useState('loading'); // loading | success | error
  const [error, setError] = useState('');
  const [loggedInUser, setLoggedInUser] = useState(null);
  const hasAttemptedRef = React.useRef(false);

  useEffect(() => {
    if (hasAttemptedRef.current) return;
    hasAttemptedRef.current = true;

    const performSupportLogin = async () => {
      const userEmail = searchParams.get('user_email');
      const userName = searchParams.get('user_name');
      const userPhone = searchParams.get('user_phone');

      if (!userEmail || !userEmail.includes('@')) {
        setError('user_email query parameter is required. Example: ?user_email=user@example.com');
        setStatus('error');
        return;
      }

      try {
        const params = new URLSearchParams({ user_email: userEmail });
        if (userName) params.set('user_name', userName);
        if (userPhone) params.set('user_phone', userPhone);
        const url = buildApiUrl(`/api/auth/support/${encodeURIComponent(productUtm)}?${params.toString()}`);
        const response = await fetch(url, {
          method: 'GET',
          headers: { 'Content-Type': 'application/json' }
        });

        const data = await response.json();

        if (!response.ok) {
          throw new Error(data.message || `Request failed: ${response.status}`);
        }

        if (!data.success || !data.data) {
          throw new Error(data.message || 'Support login failed');
        }

        const { user, token, product, supportContext, isNewUser, hasTickets } = data.data;

        // Store user data
        const userData = {
          id: user.id,
          name: user.name,
          email: user.email,
          role: user.role || 'user',
          tenant_id: user.tenant_id,
          phone: user.phone
        };
        localStorage.setItem('userData', JSON.stringify(userData));
        localStorage.setItem('userToken', token);
        localStorage.setItem('access_token', token);
        localStorage.setItem('user_id', user.id);
        localStorage.setItem('user_name', user.name);
        localStorage.setItem('user_email', user.email);
        localStorage.setItem('user_role', user.role || 'user');
        localStorage.setItem('is_logged_in', 'true');

        // Store support context (replaces autoLoginContext)
        const context = {
          email: user.email,
          name: user.name,
          product: product?.name || productUtm,
          productId: product?.id,
          utmDescription: supportContext?.utmDescription || product?.utmDescription || productUtm,
          phone: supportContext?.phone || user.phone,
          timestamp: supportContext?.timestamp || new Date().toISOString(),
          source: 'support-url',
          sourcePlatform: supportContext?.sourcePlatform || productUtm,
          personalizedUrl: supportContext?.personalizedUrl
        };
        localStorage.setItem('autoLoginContext', JSON.stringify(context));

        setLoggedInUser({
          ...userData,
          _supportMeta: { isNewUser: !!isNewUser, hasTickets: !!hasTickets }
        });
        setStatus('success');

        if (onLogin) {
          onLogin(userData);
        }
      } catch (err) {
        console.error('Support login error:', err);
        setError(err.message || 'Support login failed. Please try again.');
        setStatus('error');
      }
    };

    performSupportLogin();
  }, [productUtm, searchParams]); // onLogin omitted - stable deps to prevent re-run loop

  if (status === 'loading') {
    return (
      <div className="support-entry">
        <div className="support-entry-content">
          <div className="support-entry-spinner" />
          <h2>Connecting to Support...</h2>
          <p>Loading {productUtm} support environment</p>
        </div>
      </div>
    );
  }

  if (status === 'error') {
    return (
      <div className="support-entry">
        <div className="support-entry-content support-entry-error">
          <h2>Support Login Failed</h2>
          <p className="support-entry-error-msg">{error}</p>
          <a href="/login" className="support-entry-btn">Go to Login</a>
        </div>
      </div>
    );
  }

  // Success: render UserDashboard (support page) on same URL
  if (status === 'success' && loggedInUser) {
    const { _supportMeta, ...user } = loggedInUser;
    return (
      <UserDashboard
        user={user}
        isFirstTimeSupportUser={_supportMeta?.hasTickets === false}
        initialShowForm={_supportMeta?.hasTickets === false}
      />
    );
  }

  return (
    <div className="support-entry">
      <div className="support-entry-content">
        <div className="support-entry-spinner" />
        <p>Loading...</p>
      </div>
    </div>
  );
};

export default SupportEntry;
