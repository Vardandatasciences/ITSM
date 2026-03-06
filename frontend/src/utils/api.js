/**
 * Centralized API utility functions for authentication headers
 * This ensures all API requests include proper authentication for multi-tenancy
 */

/**
 * Get authentication headers for API requests
 * Extracts token and tenant_id from localStorage
 * 
 * @returns {Object} Headers object with Authorization and X-Tenant-ID
 */
export const getAuthHeaders = () => {
  // Try multiple possible token storage keys
  const token = localStorage.getItem('userToken') || 
                localStorage.getItem('access_token') || 
                localStorage.getItem('token') ||
                localStorage.getItem('agentToken');
  
  // Try multiple possible user data storage keys
  const userData = localStorage.getItem('userData') || 
                   localStorage.getItem('tickUser') || 
                   localStorage.getItem('agentData');
  
  let tenantId = null;
  
  // Extract tenant_id from user data
  if (userData) {
    try {
      const user = JSON.parse(userData);
      tenantId = user?.tenant_id;
    } catch (e) {
      console.error('Error parsing user data:', e);
    }
  }
  
  // If tenant_id is not in user data, try to extract from JWT token
  if (!tenantId && token) {
    try {
      const payload = JSON.parse(atob(token.split('.')[1]));
      tenantId = payload.tenant_id;
    } catch (e) {
      console.warn('Could not extract tenant_id from token:', e);
    }
  }
  
  // Fallback to tenant 1 for single-tenant setups (e.g. IMAP-created tickets use tenant_id=1)
  if (!tenantId) {
    tenantId = 1;
  }
  
  const headers = {
    'Content-Type': 'application/json'
  };
  
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  
  if (tenantId) {
    headers['X-Tenant-ID'] = tenantId.toString();
  }
  
  return headers;
};

/**
 * Get the current tenant ID for the logged-in user
 * Used by WebSocket and other non-HTTP contexts that need tenant context
 *
 * @returns {number} Tenant ID (defaults to 1)
 */
export const getTenantId = () => {
  const userData = localStorage.getItem('userData') ||
    localStorage.getItem('tickUser') ||
    localStorage.getItem('agentData');

  if (userData) {
    try {
      const user = JSON.parse(userData);
      if (user?.tenant_id != null) return Number(user.tenant_id);
    } catch (e) {
      console.error('Error parsing user data:', e);
    }
  }

  const token = localStorage.getItem('userToken') ||
    localStorage.getItem('access_token') ||
    localStorage.getItem('token') ||
    localStorage.getItem('agentToken');
  if (token) {
    try {
      const payload = JSON.parse(atob(token.split('.')[1]));
      if (payload.tenant_id != null) return Number(payload.tenant_id);
    } catch (e) {
      console.warn('Could not extract tenant_id from token:', e);
    }
  }

  return 1;
};

/**
 * Get authentication headers for FormData requests
 * Does not set Content-Type (browser will set it with boundary)
 * 
 * @returns {Object} Headers object with Authorization and X-Tenant-ID (no Content-Type)
 */
export const getAuthHeadersFormData = () => {
  const token = localStorage.getItem('userToken') || 
                localStorage.getItem('access_token') || 
                localStorage.getItem('token') ||
                localStorage.getItem('agentToken');
  
  const userData = localStorage.getItem('userData') || 
                   localStorage.getItem('tickUser') || 
                   localStorage.getItem('agentData');
  
  let tenantId = null;
  
  if (userData) {
    try {
      const user = JSON.parse(userData);
      tenantId = user?.tenant_id;
    } catch (e) {
      console.error('Error parsing user data:', e);
    }
  }
  
  if (!tenantId && token) {
    try {
      const payload = JSON.parse(atob(token.split('.')[1]));
      tenantId = payload.tenant_id;
    } catch (e) {
      console.warn('Could not extract tenant_id from token:', e);
    }
  }
  
  // Fallback to tenant 1 for single-tenant setups
  if (!tenantId) {
    tenantId = 1;
  }
  
  const headers = {};
  
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  
  if (tenantId) {
    headers['X-Tenant-ID'] = tenantId.toString();
  }
  
  return headers;
};

/**
 * Make authenticated API request
 * Wrapper function for fetch with automatic auth headers
 * 
 * @param {string} url - API endpoint URL
 * @param {Object} options - Fetch options (method, body, etc.)
 * @param {boolean} isFormData - Whether the request uses FormData
 * @returns {Promise<Response>} Fetch response
 */
export const authenticatedFetch = async (url, options = {}, isFormData = false) => {
  const headers = isFormData ? getAuthHeadersFormData() : getAuthHeaders();
  
  // Merge with existing headers
  const mergedHeaders = {
    ...headers,
    ...(options.headers || {})
  };
  
  // Remove Content-Type for FormData (browser sets it automatically)
  if (isFormData && mergedHeaders['Content-Type']) {
    delete mergedHeaders['Content-Type'];
  }
  
  return fetch(url, {
    ...options,
    headers: mergedHeaders
  });
};

/**
 * Get base API URL
 * Can be configured via environment variable
 * 
 * @returns {string} Base API URL
 */
export const getApiBaseUrl = () => {
  return process.env.REACT_APP_API_URL || 'http://localhost:5000';
};

/**
 * Build full API URL
 * 
 * @param {string} endpoint - API endpoint path (e.g., '/api/tickets')
 * @returns {string} Full API URL
 */
export const buildApiUrl = (endpoint) => {
  const baseUrl = getApiBaseUrl();
  // Remove leading slash from endpoint if present to avoid double slashes
  const cleanEndpoint = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
  return `${baseUrl}${cleanEndpoint}`;
};

