const express = require('express');
const { body, validationResult } = require('express-validator');
const { pool } = require('../database');
const { 
  authenticateToken, 
  authorizeRole, 
  generateToken, 
  hashPassword, 
  comparePassword 
} = require('../middleware/auth');
const bcrypt = require('bcryptjs'); // Added for global login

const router = express.Router();

// Validation middleware
const validateLogin = [
  body('email').isEmail().normalizeEmail().withMessage('Valid email is required'),
  body('password').isLength({ min: 6 }).withMessage('Password must be at least 6 characters')
];

const validateRegistration = [
  body('email').isEmail().normalizeEmail().withMessage('Valid email is required'),
  body('name').trim().isLength({ min: 2, max: 100 }).withMessage('Name must be between 2 and 100 characters'),
  body('password').isLength({ min: 6 }).withMessage('Password must be at least 6 characters'),
  body('role').optional().isIn(['user', 'agent', 'manager', 'ceo']).withMessage('Invalid role'),
  body('department').optional().trim().isLength({ max: 100 }).withMessage('Department must be less than 100 characters')
];

// POST /api/auth/login - User login
router.post('/login', validateLogin, async (req, res) => {
  try {
    // Check for validation errors
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        message: 'Validation failed',
        errors: errors.array()
      });
    }

    const { email, password } = req.body;

    // Find user by email (now using agents table)
    const [users] = await pool.execute(
      'SELECT * FROM agents WHERE email = ? AND is_active = TRUE',
      [email]
    );

    if (users.length === 0) {
      return res.status(401).json({
        success: false,
        message: 'Invalid email or password'
      });
    }

    const user = users[0];

    // Check password
    const isValidPassword = await comparePassword(password, user.password_hash);
    if (!isValidPassword) {
      return res.status(401).json({
        success: false,
        message: 'Invalid email or password'
      });
    }

    // Update last login
    await pool.execute(
      'UPDATE agents SET last_login = NOW() WHERE id = ?',
      [user.id]
    );

    // Generate JWT token
    const token = generateToken(user);

    // Return user data (without password)
    const userData = {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      department: user.department,
      managerId: user.manager_id,
      lastLogin: user.last_login
    };

    res.json({
      success: true,
      message: 'Login successful',
      data: {
        user: userData,
        token
      }
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({
      success: false,
      message: 'Login failed'
    });
  }
});

// POST /api/auth/register - User registration (manager/ceo only)
router.post('/register', authenticateToken, authorizeRole(['manager', 'ceo']), validateRegistration, async (req, res) => {
  try {
    // Check for validation errors
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        message: 'Validation failed',
        errors: errors.array()
      });
    }

    const { email, name, password, role, department, managerId } = req.body;

    // Check if user already exists
    const [existingUsers] = await pool.execute(
      'SELECT id FROM agents WHERE email = ?',
      [email]
    );

    if (existingUsers.length > 0) {
      return res.status(400).json({
        success: false,
        message: 'User with this email already exists'
      });
    }

    // Hash password
    const hashedPassword = await hashPassword(password);

    // Create user
    const [result] = await pool.execute(
      `INSERT INTO agents (email, name, password_hash, role, department, manager_id) 
       VALUES (?, ?, ?, ?, ?, ?)`,
      [email, name, hashedPassword, role || 'user', department, managerId]
    );

    // Get created user
    const [newUsers] = await pool.execute(
      'SELECT id, email, name, role, department, manager_id FROM agents WHERE id = ?',
      [result.insertId]
    );

    res.status(201).json({
      success: true,
      message: 'User created successfully',
      data: newUsers[0]
    });
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({
      success: false,
      message: 'Registration failed'
    });
  }
});

// GET /api/auth/profile - Get user profile
router.get('/profile', authenticateToken, async (req, res) => {
  try {
    const [users] = await pool.execute(
      'SELECT id, email, name, role, department, manager_id, created_at, last_login FROM agents WHERE id = ?',
      [req.user.id]
    );

    if (users.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    res.json({
      success: true,
      data: users[0]
    });
  } catch (error) {
    console.error('Profile fetch error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch profile'
    });
  }
});

// PUT /api/auth/profile - Update user profile
router.put('/profile', authenticateToken, async (req, res) => {
  try {
    const { name, department } = req.body;

    // Validate input
    if (name && (name.length < 2 || name.length > 100)) {
      return res.status(400).json({
        success: false,
        message: 'Name must be between 2 and 100 characters'
      });
    }

    // Update profile
    const updateFields = [];
    const updateValues = [];

    if (name) {
      updateFields.push('name = ?');
      updateValues.push(name);
    }

    if (department !== undefined) {
      updateFields.push('department = ?');
      updateValues.push(department);
    }

    if (updateFields.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'No fields to update'
      });
    }

    updateValues.push(req.user.id);

    await pool.execute(
      `UPDATE agents SET ${updateFields.join(', ')} WHERE id = ?`,
      updateValues
    );

    res.json({
      success: true,
      message: 'Profile updated successfully'
    });
  } catch (error) {
    console.error('Profile update error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update profile'
    });
  }
});

// POST /api/auth/logout - User logout
router.post('/logout', authenticateToken, async (req, res) => {
  try {
    // In a real application, you might want to blacklist the token
    // For now, we'll just return success
    res.json({
      success: true,
      message: 'Logout successful'
    });
  } catch (error) {
    console.error('Logout error:', error);
    res.status(500).json({
      success: false,
      message: 'Logout failed'
    });
  }
});

// POST /api/auth/global-login - Global login for all user types
router.post('/global-login', [
  body('login_id').notEmpty().withMessage('Login ID is required'),
  body('password').notEmpty().withMessage('Password is required')
], async (req, res) => {
  try {
    console.log('🔍 Global login request:', { login_id: req.body.login_id });

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      console.log('❌ Validation errors:', errors.array());
      return res.status(400).json({
        success: false,
        message: 'Validation failed',
        errors: errors.array()
      });
    }

    const { login_id, password } = req.body;
    console.log('📝 Login attempt for login_id:', login_id);

    // Check agents table (staff members only) - check email, login_id, and name
    let [agents] = await pool.execute(
      'SELECT * FROM agents WHERE email = ? OR login_id = ? OR name = ?',
      [login_id, login_id, login_id]
    );
    
    console.log('🔍 Found agents:', agents.length);

    // If not found in agents, check users table (customers only)
    let [users] = await pool.execute(
      'SELECT * FROM users WHERE email = ? OR name = ?',
      [login_id, login_id]
    );
    
    console.log('🔍 Found users:', users.length);

    let user = null;
    let userType = null;

    // Check staff members first (agents table only)
    if (agents.length > 0) {
      user = agents[0];
      userType = 'agent';
      console.log('✅ Staff member found:', user.name, 'Role:', user.role);
    } else if (users.length > 0) {
      // Only allow regular customers from users table (not staff roles)
      const customer = users[0];
      if (customer.role === 'user' || !customer.role) {
        user = customer;
        userType = 'user';
        console.log('✅ Customer found:', user.name, 'Role:', user.role);
      } else {
        console.log('❌ Found staff role in users table, should be in agents table:', customer.name, 'Role:', customer.role);
        return res.status(401).json({
          success: false,
          message: 'Invalid Login ID or Password'
        });
      }
    } else {
      console.log('❌ User not found in either table:', login_id);
      return res.status(401).json({
        success: false,
        message: 'Invalid Login ID or Password'
      });
    }

    // Check if user is active
    if (!user.is_active) {
      console.log('❌ User account is not active:', user.email);
      return res.status(401).json({
        success: false,
        message: 'Your account is not active. Please contact administrator.'
      });
    }

    // Verify password
    if (!user.password_hash) {
      console.log('❌ User has no password hash:', user.email);
      return res.status(401).json({
        success: false,
        message: 'Invalid Login ID or Password'
      });
    }

    const isPasswordValid = await bcrypt.compare(password, user.password_hash);
    if (!isPasswordValid) {
      console.log('❌ Invalid password for user:', user.email);
      return res.status(401).json({
        success: false,
        message: 'Invalid Login ID or Password'
      });
    }

    // Update last login based on user type
    if (userType === 'agent') {
      await pool.execute(
        'UPDATE agents SET last_login = NOW() WHERE id = ?',
        [user.id]
      );
    } else {
      await pool.execute(
        'UPDATE users SET last_login = NOW() WHERE id = ?',
        [user.id]
      );
    }

    // Generate JWT token
    const token = generateToken(user);

    // Map roles for proper frontend routing
    let mappedRole = user.role;
    if (userType === 'agent') {
      // Map agent roles to frontend-expected roles
      if (user.role === 'agent' || user.role === 'support_agent' || !user.role) {
        mappedRole = 'support_agent';
      } else if (user.role === 'manager' || user.role === 'support_manager') {
        mappedRole = 'support_manager';
      }
      // ceo role stays the same
    }
    
    // Determine dashboard type based on mapped role
    let dashboardType = 'user';
    if (['support_agent', 'support_manager', 'ceo', 'admin'].includes(mappedRole)) {
      dashboardType = 'staff';
    }

    // Return user data with dashboard information
    const userData = {
      id: user.id,
      name: user.name,
      email: user.email,
      role: mappedRole,
      department: user.department,
      manager_id: user.manager_id,
      is_active: user.is_active,
      created_at: user.created_at,
      last_login: user.last_login,
      dashboard_type: dashboardType,
      user_type: userType
    };

    console.log('✅ Global login successful for:', user.name, 'Original Role:', user.role, 'Mapped Role:', mappedRole, 'Dashboard:', dashboardType);

    res.json({
      success: true,
      message: 'Login successful',
      data: {
        user: userData,
        token,
        dashboard_type: dashboardType
      }
    });
  } catch (error) {
    console.error('❌ Global login error:', error);
    res.status(500).json({
      success: false,
      message: 'Login failed: ' + error.message
    });
  }
});

// GET /api/auth/users - Get users (support_manager/ceo only)
router.get('/users', authenticateToken, authorizeRole(['support_manager', 'ceo']), async (req, res) => {
  try {
    let query = 'SELECT id, email, name, role, department, manager_id, created_at, last_login, is_active FROM agents';
    const params = [];

    // Support managers can only see their team
    if (req.user.role === 'support_manager') {
      query += ' WHERE manager_id = ? OR id = ?';
      params.push(req.user.id, req.user.id);
    }

    query += ' ORDER BY created_at DESC';

    const [users] = await pool.execute(query, params);

    res.json({
      success: true,
      data: users
    });
  } catch (error) {
    console.error('Users fetch error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch users'
    });
  }
});

// GET /api/auth/support/:product?user_email= - Universal Support URL Integration
// URL format: https://itsm.vardands.com/{utm}?user_email={email}
// Path uses utm_description (e.g. GRC, VOC) - more secure than predictable slugs
// Optional: user_name, user_phone for form auto-fill
router.get('/support/:product', async (req, res) => {
  try {
    const productUtm = req.params.product;
    const userEmail = req.query.user_email;
    const userName = req.query.user_name;
    const userPhone = req.query.user_phone;

    if (!productUtm || !productUtm.trim()) {
      return res.status(400).json({
        success: false,
        message: 'Product UTM is required in the URL path'
      });
    }

    if (!userEmail || !userEmail.includes('@')) {
      return res.status(400).json({
        success: false,
        message: 'user_email query parameter is required and must be a valid email'
      });
    }

    const email = userEmail.trim();
    const name = (userName && userName.trim()) ? userName.trim() : email.split('@')[0];

    console.log('🔗 Universal Support URL (UTM):', { utm: productUtm, email });

    // Resolve product by utm_description first (primary), then slug, then name (case-insensitive)
    let productRow;
    try {
      const [products] = await pool.execute(
        `SELECT * FROM products 
         WHERE status = 'active' 
         AND (LOWER(COALESCE(utm_description, '')) = LOWER(?) 
              OR LOWER(COALESCE(slug, '')) = LOWER(?) 
              OR LOWER(name) = LOWER(?))
         ORDER BY (LOWER(COALESCE(utm_description, '')) = LOWER(?)) DESC,
                  (LOWER(COALESCE(slug, '')) = LOWER(?)) DESC
         LIMIT 1`,
        [productUtm, productUtm, productUtm, productUtm, productUtm]
      );
      productRow = products[0];
    } catch (err) {
      if (err.code === 'ER_BAD_FIELD_ERROR' && (err.message?.includes('slug') || err.message?.includes('utm_description'))) {
        // Fallback if columns missing - try name only
        const [products] = await pool.execute(
          'SELECT * FROM products WHERE status = ? AND LOWER(name) = LOWER(?) LIMIT 1',
          ['active', productUtm]
        );
        productRow = products[0];
      } else {
        throw err;
      }
    }

    if (!productRow) {
      return res.status(404).json({
        success: false,
        message: `Product "${productUtm}" not found. Add the product with a matching utm_description, slug, or name.`
      });
    }

    const productName = productRow.name;
    const utmDescription = productRow.utm_description || productUtm;

    // SECURITY: Block staff members - support URL is for customers only
    const [agents] = await pool.execute('SELECT * FROM agents WHERE email = ?', [email]);
    if (agents.length > 0) {
      return res.status(403).json({
        success: false,
        message: 'Support URL is for customers only. Staff should use the regular login.',
        redirectUrl: `${process.env.FRONTEND_URL || 'http://localhost:3000'}/login`
      });
    }

    // Find or create user by email
    const [users] = await pool.execute('SELECT * FROM users WHERE email = ?', [email]);
    let user;
    let isNewUser = false;

    const tenantId = productRow.tenant_id ?? 1;

    if (users.length === 0) {
      try {
        const [result] = await pool.execute(
          `INSERT INTO users (name, email, phone, role, created_at, is_active, last_login) 
           VALUES (?, ?, ?, 'user', NOW(), TRUE, NOW())`,
          [name, email, null]
        );
        const [newUsers] = await pool.execute('SELECT * FROM users WHERE id = ?', [result.insertId]);
        if (!newUsers.length) throw new Error('Failed to retrieve new user');
        user = newUsers[0];
        isNewUser = true;
        console.log('✅ New customer created:', user.email, 'for product:', productName);
      } catch (insertError) {
        console.error('❌ Error creating user:', insertError);
        return res.status(500).json({
          success: false,
          message: 'Failed to create user account: ' + insertError.message
        });
      }
    } else {
      user = users[0];
      if (name && (!user.name || user.name === user.email)) {
        await pool.execute('UPDATE users SET name = ? WHERE id = ?', [name, user.id]);
        user.name = name;
      }
      if (userPhone && userPhone.trim()) {
        await pool.execute('UPDATE users SET phone = ? WHERE id = ?', [userPhone.trim(), user.id]);
        user.phone = userPhone.trim();
      }
      if (!user.is_active) {
        await pool.execute('UPDATE users SET is_active = TRUE WHERE id = ?', [user.id]);
        user.is_active = true;
      }
    }

    // Check if user has any tickets (existing vs first-time experience)
    const [ticketCountRows] = await pool.execute(
      'SELECT COUNT(*) as cnt FROM tickets WHERE (user_id = ? OR email = ?)',
      [user.id, user.email]
    );
    const hasTickets = (ticketCountRows[0]?.cnt || 0) > 0;

    if (user.role !== 'user' && user.role !== 'customer') {
      return res.status(403).json({
        success: false,
        message: 'Support URL is for customers only.',
        redirectUrl: `${process.env.FRONTEND_URL || 'http://localhost:3000'}/login`
      });
    }

    await pool.execute('UPDATE users SET last_login = NOW() WHERE id = ?', [user.id]);

    const token = generateToken({ ...user, tenant_id: user.tenant_id ?? tenantId });

    const baseUrl = process.env.PUBLIC_BASE_URL || process.env.FRONTEND_URL || 'http://localhost:3000';
    const personalizedUrl = `${baseUrl}/${encodeURIComponent(utmDescription)}?user_email=${encodeURIComponent(user.email)}`;

    const supportContext = {
      email: user.email,
      name: user.name,
      product: productName,
      productId: productRow.id,
      utmDescription,
      phone: userPhone && userPhone.trim() ? userPhone.trim() : user.phone,
      timestamp: new Date().toISOString(),
      source: 'support-url',
      sourcePlatform: utmDescription,
      personalizedUrl
    };

    // Send welcome email to first-time users (created just now)
    if (isNewUser) {
      try {
        const emailService = require('../services/emailService');
        await emailService.sendSupportWelcomeEmail(
          user.email,
          user.name,
          utmDescription,
          personalizedUrl
        );
      } catch (emailErr) {
        console.warn('⚠️ Could not send support welcome email:', emailErr.message);
      }
    }

    const userData = {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      phone: user.phone,
      tenant_id: user.tenant_id ?? tenantId,
      is_active: user.is_active,
      created_at: user.created_at,
      last_login: user.last_login
    };

    console.log('✅ Support login:', user.email, '| Product:', productName, '|', isNewUser ? 'NEW' : 'EXISTING');

    res.json({
      success: true,
      message: 'Support session initialized',
      data: {
        user: userData,
        token,
        product: { id: productRow.id, name: productName, utmDescription },
        supportContext,
        isNewUser,
        hasTickets,
        personalizedUrl
      }
    });
  } catch (error) {
    console.error('❌ Support login error:', error);
    res.status(500).json({
      success: false,
      message: 'Support login failed: ' + error.message
    });
  }
});

module.exports = router; 