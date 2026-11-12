/**
 * Fixit Web Platform - Main Application Logic
 * Supports dual-mode:
 * 1. Full SQLite Backend Mode (when running server.js on port 3000)
 * 2. Client-Side LocalStorage Fallback Mode (when opened via VS Code Live Server on port 5500 or file://)
 */

// Haversine distance calculator in kilometers
function calculateDistanceKm(lat1, lon1, lat2, lon2) {
  if (lat1 === undefined || lat1 === null || lon1 === undefined || lon1 === null ||
      lat2 === undefined || lat2 === null || lon2 === undefined || lon2 === null) {
    return null;
  }
  const R = 6371; // Earth radius in km
  const dLat = (Number(lat2) - Number(lat1)) * Math.PI / 180;
  const dLon = (Number(lon2) - Number(lon1)) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(Number(lat1) * Math.PI / 180) * Math.cos(Number(lat2) * Math.PI / 180) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return Math.round(R * c * 10) / 10;
}

// Safe HTML escaping helper
function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Determine API base URL
function getApiBase() {
  const port = window.location.port;
  // If running directly on the node server (port 3000) or hosted live in the cloud (standard port 80/443 or empty)
  if (!port || port === '3000' || port === '80' || port === '443') {
    return '/api';
  }
  // If running via Live Server (e.g. port 5500) or other static dev server, attempt to connect to backend on 3000
  if (window.location.protocol.startsWith('http')) {
    const host = window.location.hostname || 'localhost';
    return `${window.location.protocol}//${host}:3000/api`;
  }
  return null; // file://
}

// Application State
let initialUser = null;
try {
  const rawUser = localStorage.getItem('fixit_current_user');
  if (rawUser) initialUser = JSON.parse(rawUser);
} catch(e){}

let initialProvider = null;
try {
  const rawProvider = localStorage.getItem('fixit_current_provider');
  if (rawProvider) initialProvider = JSON.parse(rawProvider);
} catch(e){}

const state = {
  currentUser: initialUser,
  currentProvider: initialProvider,
  token: localStorage.getItem('fixit_token') || null,
  userMode: localStorage.getItem('fixit_user_mode') || 'provider',
  currentView: 'home',
  categories: [],
  providers: [],
  customerRequests: [],
  providerJobs: [],
  notifications: [],
  unreadNotifications: 0,
  uploadedPhotoBase64: null,
  adminTab: 'providers',
  backendConnected: false,
  charts: {
    categoryChart: null,
    statusChart: null
  }
};

// ---------------- LOCALSTORAGE CLIENT-SIDE ENGINE (FALLBACK) ----------------
const MockDB = {
  KEY: 'fixit_local_storage_v3_clean',
  getData() {
    const raw = localStorage.getItem(this.KEY);
    if (raw) {
      try {
        return JSON.parse(raw);
      } catch(e){}
    }
    const seed = this.getSeedData();
    localStorage.setItem(this.KEY, JSON.stringify(seed));
    return seed;
  },
  saveData(data) {
    localStorage.setItem(this.KEY, JSON.stringify(data));
  },
  getSeedData() {
    return {
      categories: [
        { id: 1, name: 'Plumbing Services', slug: 'plumbing', icon: 'fa-wrench', base_price: 399.0, description: 'Leak repairs, pipe installations, drain clearing, tap & fixture repairs.', providers_count: 0, requests_count: 0 },
        { id: 2, name: 'Electrical Works', slug: 'electrical', icon: 'fa-bolt', base_price: 449.0, description: 'Wiring, circuit breakers, light fixtures, switchboard installations.', providers_count: 0, requests_count: 0 },
        { id: 3, name: 'Carpentry & Woodwork', slug: 'carpentry', icon: 'fa-hammer', base_price: 349.0, description: 'Furniture repair, door locks, custom cabinets, hinge alignment.', providers_count: 0, requests_count: 0 },
        { id: 4, name: 'AC Repair & HVAC', slug: 'ac-repair', icon: 'fa-snowflake', base_price: 599.0, description: 'AC servicing, gas charging, filter cleaning, cooling diagnostics.', providers_count: 0, requests_count: 0 },
        { id: 5, name: 'Appliance Repair', slug: 'appliances', icon: 'fa-tv', base_price: 399.0, description: 'Washing machines, refrigerators, microwaves, dishwashers, TVs.', providers_count: 0, requests_count: 0 },
        { id: 6, name: 'Painting & Waterproofing', slug: 'painting', icon: 'fa-paint-roller', base_price: 699.0, description: 'Wall touch-ups, full room painting, dampness sealing, plastering.', providers_count: 0, requests_count: 0 },
        { id: 7, name: 'Smart Home & Security', slug: 'smart-home-security', icon: 'fa-microchip', base_price: 499.0, description: 'Smart locks, doorbell cameras, home automation, and security setup.', providers_count: 0, requests_count: 0 },
        { id: 8, name: 'Others', slug: 'others', icon: 'fa-ellipsis', base_price: 399.0, description: 'General handyman, custom trades, and specialized home repairs.', providers_count: 0, requests_count: 0 }
      ],
      users: [
        { id: 1, name: 'Super Admin', email: 'admin@fixit.com', role: 'admin', phone: '+91 98765 00001', status: 'active', avatar: 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?auto=format&fit=crop&w=256&h=256&q=80' }
      ],
      providers: [],
      requests: [],
      reviews: [],
      messages: [],
      notifications: []
    };
  }
};

// ---------------- API CLIENT WITH RESILIENT FALLBACK ----------------
async function api(endpoint, options = {}) {
  const apiBase = getApiBase();

  // Try real backend API first if host is available
  if (apiBase) {
    try {
      const headers = {
        'Content-Type': 'application/json',
        ...(options.headers || {})
      };
      if (state.token) {
        headers['Authorization'] = `Bearer ${state.token}`;
      }

      const controller = new AbortController();
      // Generous timeout: 30 seconds for SMTP email dispatches (which can take 3-6s), 15s for regular APIs
      const isEmailEndpoint = endpoint.includes('otp') || endpoint.includes('register') || endpoint.includes('forgot') || endpoint.includes('reset');
      const timeoutMs = isEmailEndpoint ? 30000 : 15000;
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

      const res = await fetch(`${apiBase}${endpoint}`, {
        ...options,
        headers,
        signal: controller.signal
      });
      clearTimeout(timeoutId);

      const text = await res.text();
      let data = {};
      try {
        data = text ? JSON.parse(text) : {};
      } catch (jsonErr) {
        throw new Error(`Invalid JSON response: ${text.slice(0, 100)}`);
      }

      if (!res.ok) {
        state.backendConnected = true;
        updateBackendStatusPill(true);
        const errMsg = data.error || `HTTP ${res.status}`;
        const error = new Error(errMsg);
        error.isApiError = true;
        throw error;
      }

      state.backendConnected = true;
      updateBackendStatusPill(true);
      return data;
    } catch (err) {
      if (err.isApiError) {
        throw err;
      }
      // If connected to Node backend (port 3000) or calling auth endpoints, NEVER fall back to MockDB!
      // MockDB contains separate mock data and causes false "No account found" errors.
      if (window.location.port === '3000' || endpoint.startsWith('/auth/')) {
        state.backendConnected = true;
        throw new Error(err.name === 'AbortError' ? 'Request timed out while delivering email. Please try again.' : (err.message || 'Server request failed'));
      }
      console.warn(`Backend API unavailable at ${apiBase}${endpoint} (${err.message}). Using local engine fallback.`);
      state.backendConnected = false;
      updateBackendStatusPill(false);
      // Fall through to MockDB engine!
    }
  } else {
    updateBackendStatusPill(false);
  }

  // Handle request in local mock DB engine
  return handleMockApi(endpoint, options);
}

function updateBackendStatusPill(isConnected) {
  let pill = document.getElementById('backend-status-pill');
  if (!pill) {
    const bar = document.getElementById('quick-switcher-bar');
    if (bar) {
      pill = document.createElement('span');
      pill.id = 'backend-status-pill';
      pill.className = 'text-[11px] font-semibold px-2 py-0.5 rounded-full flex items-center gap-1 ml-auto';
      bar.appendChild(pill);
    }
  }
  if (pill) {
    if (isConnected) {
      pill.className = 'text-[11px] font-semibold px-2.5 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 flex items-center gap-1.5 ml-auto';
      pill.innerHTML = `<span class="w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></span> SQLite Backend`;
    } else {
      pill.className = 'text-[11px] font-semibold px-2.5 py-0.5 rounded-full bg-amber-500/20 text-amber-300 border border-amber-500/30 flex items-center gap-1.5 ml-auto';
      pill.innerHTML = `<span class="w-2 h-2 rounded-full bg-amber-400"></span> Live Server Mode`;
    }
  }
}

// Client-Side Mock API Implementation
function handleMockApi(endpoint, options = {}) {
  const method = (options.method || 'GET').toUpperCase();
  const db = MockDB.getData();
  const body = options.body ? JSON.parse(options.body) : {};

  // Auth: Demo Switcher
  if (endpoint === '/auth/demo' && method === 'POST') {
    let email = 'alice@fixit.com';
    if (body.role === 'avdhut' || body.role === 'devkate') email = 'devkate.avdhut2003@gmail.com';
    else if (body.role === 'provider') email = 'mike@fixit.com';
    else if (body.role === 'admin') email = 'admin@fixit.com';
    else if (body.role === 'provider-pending') email = 'sam@fixit.com';
    else if (body.role === 'customer-david') email = 'david@fixit.com';

    let user = db.users.find(u => u.email === email);
    if (!user && (body.role === 'avdhut' || body.role === 'devkate')) {
      user = {
        id: 13,
        name: 'Avdhut S Devkate',
        email: 'devkate.avdhut2003@gmail.com',
        role: 'provider',
        phone: '+91 98765 43210',
        address: 'Service Address',
        status: 'active',
        avatar: 'https://api.dicebear.com/7.x/avataaars/svg?seed=Avdhut'
      };
      db.users.push(user);
    }
    user = user || db.users[1];
    const provider = db.providers.find(p => p.user_id === user.id) || null;
    const token = 'tok_mock_' + user.id + '_' + Math.random().toString(36).substring(2);

    return { user, provider, token };
  }

  // Auth: Request Register OTP
  if (endpoint === '/auth/register-request' && method === 'POST') {
    const cleanEmail = (body.email || '').toLowerCase().trim();
    if (!cleanEmail) throw new Error('Email address is required');
    const existing = db.users.find(u => u.email.toLowerCase() === cleanEmail);
    if (existing) throw new Error('An account with this email already exists. Please sign in.');
    window._mockPendingReg = { data: body, otp: '123456' };
    return {
      success: true,
      message: `Verification code sent to ${cleanEmail}`,
      email: cleanEmail
    };
  }

  // Auth: Verify Register OTP
  if (endpoint === '/auth/verify-register' && method === 'POST') {
    const pending = window._mockPendingReg;
    if (!pending || pending.otp !== String(body.otp).trim()) throw new Error('Invalid verification code');
    const reg = pending.data;
    const id = db.users.length + 1;
    const role = ['customer', 'provider'].includes(reg.role) ? reg.role : 'customer';
    const newUser = {
      id,
      name: reg.name,
      email: reg.email,
      role,
      phone: reg.phone || '',
      district: reg.district || '',
      address: reg.address || reg.district || '',
      status: 'active',
      avatar: `https://api.dicebear.com/7.x/avataaars/svg?seed=${encodeURIComponent(reg.name)}`
    };
    db.users.push(newUser);
    let provider = null;
    if (role === 'provider') {
      const pId = db.providers.length + 1;
      const cat = db.categories.find(c => c.id === Number(reg.category_id)) || db.categories[0];
      const customTrade = reg.custom_trade ? reg.custom_trade.trim() : null;
      let skillsArr = reg.skills ? reg.skills.split(',').map(s=>s.trim()).filter(Boolean) : [];
      if (customTrade && !skillsArr.includes(customTrade)) skillsArr.unshift(customTrade);
      if (skillsArr.length === 0) skillsArr = ['General Repairs'];
      provider = {
        id: pId,
        user_id: id,
        name: reg.name,
        email: reg.email,
        category_id: cat.id,
        category_name: customTrade || cat.name,
        category_icon: cat.icon || 'fa-tools',
        skills: JSON.stringify(skillsArr),
        hourly_rate: Number(reg.hourly_rate) || 499,
        experience_years: 3,
        bio: customTrade ? `Specialist in ${customTrade} services and general repairs.` : 'Skilled technician ready to help.',
        rating: 5.0,
        reviews_count: 0,
        verification_status: 'approved',
        is_available: 1,
        district: reg.district || '',
        state: 'Maharashtra',
        latitude: null,
        longitude: null,
        avatar: newUser.avatar
      };
      db.providers.push(provider);
    }
    MockDB.saveData(db);
    delete window._mockPendingReg;
    return {
      success: true,
      message: 'Account verified successfully!',
      user: newUser,
      provider,
      token: 'tok_mock_' + id
    };
  }

  // Auth: Resend Register OTP
  if (endpoint === '/auth/resend-register-otp' && method === 'POST') {
    return { success: true, message: 'New verification code sent!' };
  }

  // Auth: Forgot Password Request OTP
  if (endpoint === '/auth/forgot-password-request' && method === 'POST') {
    const email = (body.email || '').toLowerCase().trim();
    const user = db.users.find(u => u.email.toLowerCase() === email);
    if (!user) throw new Error('No account found with this email address');
    window._mockResetOtp = { email, otp: '123456' };
    return { success: true, message: 'Reset code sent to ' + email, email };
  }

  // Auth: Reset Password Verify OTP
  if (endpoint === '/auth/reset-password-verify' && method === 'POST') {
    const email = (body.email || '').toLowerCase().trim();
    if (!window._mockResetOtp || window._mockResetOtp.otp !== String(body.otp).trim()) {
      throw new Error('Invalid verification code');
    }
    let user = db.users.find(u => u.email.toLowerCase() === email);
    if (!user) throw new Error('No Fixit account found with that email address');
    user.password = body.new_password;
    MockDB.saveData(db);
    delete window._mockResetOtp;
    const provider = db.providers.find(p => p.user_id === user.id) || null;
    return { success: true, message: 'Password reset successful', user, provider, token: 'tok_mock_' + user.id };
  }

  // Auth: Login
  if (endpoint === '/auth/login' && method === 'POST') {
    const user = db.users.find(u => u.email.toLowerCase() === (body.email || '').toLowerCase());
    if (!user) throw new Error('Invalid email or password');
    const provider = db.providers.find(p => p.user_id === user.id) || null;
    return { user, provider, token: 'tok_mock_' + Math.random().toString(36).substring(2) };
  }

  // Categories
  if (endpoint.startsWith('/categories') && method === 'GET') {
    return { categories: db.categories };
  }

  if (endpoint === '/categories' && method === 'POST') {
    const newCat = {
      id: db.categories.length + 1,
      name: body.name,
      slug: body.name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
      icon: body.icon || 'fa-tools',
      base_price: Number(body.base_price) || 50,
      description: body.description || '',
      providers_count: 0,
      requests_count: 0
    };
    db.categories.push(newCat);
    MockDB.saveData(db);
    return { category: newCat };
  }

  // Providers
  if (endpoint.startsWith('/providers') && method === 'GET') {
    const url = new URL(`http://localhost${endpoint}`);
    const cat = url.searchParams.get('category_id');
    const search = (url.searchParams.get('search') || '').toLowerCase();
    const status = url.searchParams.get('status') || 'approved';

    let list = db.providers;
    if (status !== 'all') {
      list = list.filter(p => p.verification_status === status);
    }
    if (cat && cat !== 'all') {
      list = list.filter(p => p.category_id === Number(cat));
    }
    const excludeUserId = url.searchParams.get('exclude_user_id');
    if (excludeUserId) {
      list = list.filter(p => Number(p.user_id) !== Number(excludeUserId));
    }
    if (search) {
      list = list.filter(p => p.name.toLowerCase().includes(search) || (p.bio && p.bio.toLowerCase().includes(search)));
    }
    return { providers: list };
  }

  // Provider update profile
  if (endpoint === '/providers/profile' && method === 'PUT') {
    if (state.currentUser) {
      const p = db.providers.find(pr => pr.user_id === state.currentUser.id);
      if (p) {
        if (body.hourly_rate) p.hourly_rate = Number(body.hourly_rate);
        if (body.experience_years) p.experience_years = Number(body.experience_years);
        if (body.bio) p.bio = body.bio;
        if (body.skills) p.skills = JSON.stringify(body.skills);
        if (body.is_available !== undefined) p.is_available = body.is_available ? 1 : 0;
        MockDB.saveData(db);
        return { success: true, provider: p };
      }
    }
    return { success: true };
  }

  // Admin verify provider
  if (endpoint.match(/^\/providers\/\d+\/verify$/) && method === 'PUT') {
    const pId = Number(endpoint.split('/')[2]);
    const p = db.providers.find(pr => pr.id === pId);
    if (p) {
      p.verification_status = body.status;
      MockDB.saveData(db);
      return { success: true, provider: p };
    }
    throw new Error('Provider not found');
  }

  // Requests: GET
  if (endpoint.startsWith('/requests') && method === 'GET') {
    const url = new URL(`http://localhost${endpoint}`);
    const statusFilter = url.searchParams.get('status');

    let reqs = db.requests;
    let currentProv = null;

    if (state.currentUser) {
      if (state.currentUser.role === 'customer') {
        reqs = reqs.filter(r => r.user_id === state.currentUser.id);
      } else if (state.currentUser.role === 'provider') {
        currentProv = db.providers.find(p => p.user_id === state.currentUser.id);
        if (currentProv) {
          reqs = reqs.filter(r => r.provider_id === currentProv.id || (r.category_id === currentProv.category_id && r.status === 'Pending'));
        }
      }
    }
    if (statusFilter && statusFilter !== 'all') {
      reqs = reqs.filter(r => r.status === statusFilter);
    }

    const pLat = currentProv?.latitude || 37.7833;
    const pLng = currentProv?.longitude || -122.4167;
    const pRadius = currentProv?.service_radius_km || 5.0;

    const mapped = reqs.slice().reverse().map(r => {
      const dist = (r.latitude && r.longitude) ? calculateDistanceKm(pLat, pLng, r.latitude, r.longitude) : null;
      return {
        ...r,
        distance_km: dist,
        within_radius: dist !== null ? dist <= pRadius : true
      };
    });

    return { requests: mapped };
  }

  // Requests: POST (Create)
  if (endpoint === '/requests' && method === 'POST') {
    const cat = db.categories.find(c => c.id === Number(body.category_id)) || db.categories[0];
    const ticket_number = 'FIX-' + Math.floor(1000 + Math.random() * 9000);
    const newReq = {
      id: db.requests.length + 1,
      ticket_number,
      user_id: state.currentUser ? state.currentUser.id : null,
      customer_name: state.currentUser ? state.currentUser.name : 'Customer',
      customer_phone: state.currentUser ? state.currentUser.phone : '',
      provider_id: body.provider_id ? Number(body.provider_id) : null,
      provider_name: null,
      category_id: cat.id,
      category_name: cat.name,
      category_icon: cat.icon,
      title: body.title,
      description: body.description,
      photos: JSON.stringify(body.photos || []),
      preferred_date: body.preferred_date,
      preferred_time: body.preferred_time || 'Morning',
      address: body.address || 'Address provided',
      latitude: body.latitude || null,
      longitude: body.longitude || null,
      urgency: body.urgency || 'normal',
      status: 'Pending',
      estimated_cost: cat.base_price,
      created_at: new Date().toISOString()
    };

    if (body.provider_id) {
      const assigned = db.providers.find(p => p.id === Number(body.provider_id));
      if (assigned) {
        newReq.provider_name = assigned.name;
        newReq.provider_phone = '+1 (555) 438-9901';
      }
    }

    db.requests.push(newReq);
    db.notifications.unshift({
      id: db.notifications.length + 1,
      user_id: newReq.user_id,
      title: 'Request Created',
      message: `Your request "${newReq.title}" (${ticket_number}) was submitted.`,
      type: 'info',
      is_read: 0,
      created_at: new Date().toISOString()
    });

    // Alert matching category providers whose service radius covers this request
    const categoryProviders = db.providers.filter(p => p.category_id === cat.id && p.verification_status === 'approved');
    categoryProviders.forEach(p => {
      let dist = null;
      let inRadius = true;
      if (newReq.latitude && newReq.longitude && p.latitude && p.longitude) {
        dist = calculateDistanceKm(newReq.latitude, newReq.longitude, p.latitude, p.longitude);
        const radius = p.service_radius_km || 5.0;
        if (dist !== null && dist > radius) inRadius = false;
      }
      if (inRadius) {
        const distMsg = dist !== null ? ` (📍 ${dist} km away • within ${p.service_radius_km || 5}km)` : '';
        db.notifications.unshift({
          id: db.notifications.length + 1,
          user_id: p.user_id,
          title: 'Nearby Repair Job Alert',
          message: `New complaint in your category${distMsg}: "${newReq.title}" at ${newReq.address}.`,
          type: 'info',
          is_read: 0,
          created_at: new Date().toISOString()
        });
      }
    });

    MockDB.saveData(db);
    return { request: newReq };
  }

  // Request: Status update
  if (endpoint.match(/^\/requests\/\d+\/status$/) && method === 'PUT') {
    const rId = Number(endpoint.split('/')[2]);
    const r = db.requests.find(rq => rq.id === rId);
    if (!r) throw new Error('Request not found');

    r.status = body.status;
    if (body.rejection_reason) r.rejection_reason = body.rejection_reason;
    if (body.completion_notes) r.completion_notes = body.completion_notes;
    if (body.final_cost) r.final_cost = Number(body.final_cost);

    if (state.currentUser && state.currentUser.role === 'provider' && body.status === 'Accepted') {
      const prov = db.providers.find(p => p.user_id === state.currentUser.id);
      if (prov) {
        r.provider_id = prov.id;
        r.provider_name = prov.name;
      }
    }

    db.notifications.unshift({
      id: db.notifications.length + 1,
      user_id: r.user_id,
      title: 'Status Updated',
      message: `Repair request ${r.ticket_number} is now ${r.status}.`,
      type: 'status_change',
      is_read: 0,
      created_at: new Date().toISOString()
    });

    MockDB.saveData(db);
    return { success: true, request: r };
  }

  // Request: Rate
  if (endpoint.match(/^\/requests\/\d+\/rate$/) && method === 'POST') {
    const rId = Number(endpoint.split('/')[2]);
    const r = db.requests.find(rq => rq.id === rId);
    if (r) {
      r.user_review_rating = body.rating;
      r.user_review_comment = body.comment;

      db.reviews.unshift({
        id: db.reviews.length + 1,
        request_id: rId,
        user_id: r.user_id,
        customer_name: r.customer_name,
        provider_id: r.provider_id,
        provider_name: r.provider_name || 'Assigned Provider',
        category_name: r.category_name,
        ticket_number: r.ticket_number,
        rating: Number(body.rating),
        comment: body.comment,
        created_at: new Date().toISOString()
      });

      // Recalculate provider rating
      if (r.provider_id) {
        const provReviews = db.reviews.filter(rev => rev.provider_id === r.provider_id);
        const prov = db.providers.find(p => p.id === r.provider_id);
        if (prov && provReviews.length > 0) {
          const sum = provReviews.reduce((acc, curr) => acc + curr.rating, 0);
          prov.rating = Math.round((sum / provReviews.length) * 10) / 10;
          prov.reviews_count = provReviews.length;
        }
      }

      MockDB.saveData(db);
      return { success: true };
    }
    throw new Error('Request not found');
  }

  // Messages (Chat & Negotiation)
  if (endpoint.match(/^\/requests\/\d+\/messages$/) && method === 'GET') {
    const rId = Number(endpoint.split('/')[2]);
    const r = db.requests.find(rq => rq.id === rId);
    if (!r) throw new Error('Request not found');
    const msgs = (db.messages || []).filter(m => m.request_id === rId);
    return {
      request: {
        id: r.id,
        ticket_number: r.ticket_number,
        title: r.title,
        status: r.status,
        estimated_cost: r.estimated_cost,
        agreed_price: r.agreed_price,
        offline_payment_agreed: r.offline_payment_agreed,
        customer_name: r.customer_name,
        customer_avatar: r.customer_avatar || 'https://api.dicebear.com/7.x/avataaars/svg?seed=' + r.customer_name,
        provider_name: r.provider_name,
        provider_avatar: r.provider_avatar || 'https://api.dicebear.com/7.x/avataaars/svg?seed=' + r.provider_name
      },
      messages: msgs
    };
  }

  if (endpoint.match(/^\/requests\/\d+\/messages$/) && method === 'POST') {
    const rId = Number(endpoint.split('/')[2]);
    const r = db.requests.find(rq => rq.id === rId);
    if (!r) throw new Error('Request not found');

    const u = state.currentUser || db.users[1];
    const newMsg = {
      id: (db.messages || []).length + 1,
      request_id: rId,
      sender_id: u.id,
      sender_name: u.name,
      sender_avatar: u.avatar,
      message: body.message || (body.message_type === 'price_offer' ? `Proposed offline rate: ₹${body.proposed_price}` : 'Agreed'),
      message_type: body.message_type || 'text',
      proposed_price: body.proposed_price || null,
      created_at: new Date().toISOString()
    };
    if (!db.messages) db.messages = [];
    db.messages.push(newMsg);

    if (body.message_type === 'payment_agreed' && body.proposed_price) {
      r.offline_payment_agreed = 1;
      r.agreed_price = Number(body.proposed_price);
      r.final_cost = Number(body.proposed_price);
    }

    MockDB.saveData(db);
    return { message: newMsg };
  }

  if (endpoint.match(/^\/requests\/\d+\/negotiate-price$/) && method === 'POST') {
    const rId = Number(endpoint.split('/')[2]);
    const r = db.requests.find(rq => rq.id === rId);
    if (!r) throw new Error('Request not found');

    const agreedPrice = Number(body.price);
    r.offline_payment_agreed = 1;
    r.agreed_price = agreedPrice;
    r.final_cost = agreedPrice;

    const u = state.currentUser || db.users[1];
    if (!db.messages) db.messages = [];
    db.messages.push({
      id: db.messages.length + 1,
      request_id: rId,
      sender_id: u.id,
      sender_name: u.name,
      sender_avatar: u.avatar,
      message: `🤝 Offline cash deal locked in at ₹${agreedPrice.toFixed(2)} (Cash in person upon completion).`,
      message_type: 'payment_agreed',
      proposed_price: agreedPrice,
      created_at: new Date().toISOString()
    });

    MockDB.saveData(db);
    return { success: true, agreed_price: agreedPrice };
  }

  // Notifications
  if (endpoint === '/notifications' && method === 'GET') {
    const uid = state.currentUser ? state.currentUser.id : 2;
    const list = db.notifications.filter(n => n.user_id === uid);
    const unread = list.filter(n => !n.is_read).length;
    return { notifications: list, unreadCount: unread };
  }

  if (endpoint === '/notifications/read' && method === 'POST') {
    const uid = state.currentUser ? state.currentUser.id : 2;
    db.notifications.forEach(n => { if (n.user_id === uid) n.is_read = 1; });
    MockDB.saveData(db);
    return { success: true };
  }

  // Reviews
  if (endpoint === '/reviews' && method === 'GET') {
    return { reviews: db.reviews };
  }

  // Admin Stats
  if (endpoint === '/admin/stats' && method === 'GET') {
    const totalRequests = db.requests.length;
    const pendingRequests = db.requests.filter(r => r.status === 'Pending').length;
    const inProgressRequests = db.requests.filter(r => r.status === 'In Progress').length;
    const completedRequests = db.requests.filter(r => r.status === 'Completed').length;
    const rejectedRequests = db.requests.filter(r => r.status === 'Rejected').length;
    const pendingProviders = db.providers.filter(p => p.verification_status === 'pending').length;
    const totalUsers = db.users.filter(u => u.role === 'customer').length;
    const totalRevenue = db.requests.filter(r => r.status === 'Completed').reduce((sum, r) => sum + (r.final_cost || r.estimated_cost || 0), 0);

    const categoryStats = db.categories.map(c => ({
      name: c.name,
      request_count: db.requests.filter(r => r.category_id === c.id).length
    }));

    return {
      stats: {
        totalRequests,
        pendingRequests,
        inProgressRequests,
        completedRequests,
        rejectedRequests,
        totalUsers,
        totalProviders: db.providers.filter(p => p.verification_status === 'approved').length,
        pendingProviders,
        totalRevenue: Math.round(totalRevenue * 100) / 100,
        completionRate: totalRequests > 0 ? Math.round((completedRequests / totalRequests) * 100) : 0
      },
      categoryStats
    };
  }

  // Admin Users
  if (endpoint === '/admin/users' && method === 'GET') {
    const usersWithCounts = db.users.map(u => ({
      ...u,
      orders_count: db.requests.filter(r => r.user_id === u.id).length
    }));
    return { users: usersWithCounts };
  }

  if (endpoint.match(/^\/admin\/users\/\d+\/status$/) && method === 'PUT') {
    const uId = Number(endpoint.split('/')[3]);
    const user = db.users.find(u => u.id === uId);
    if (user) {
      user.status = body.status;
      MockDB.saveData(db);
      return { success: true };
    }
  }

  if (endpoint.match(/^\/admin\/users\/\d+$/) && method === 'DELETE') {
    const uId = Number(endpoint.split('/')[3]);
    if (uId === 1) throw new Error('Cannot delete super admin');
    db.users = db.users.filter(u => u.id !== uId);
    db.providers = db.providers.filter(p => p.user_id !== uId);
    db.requests = db.requests.filter(r => r.user_id !== uId);
    MockDB.saveData(db);
    return { success: true, message: `User #${uId} removed` };
  }

  return { success: true };
}

// ---------------- TOAST NOTIFICATIONS ----------------
function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  if (!container) return;
  const toast = document.createElement('div');

  const icons = {
    success: 'fa-circle-check text-emerald-600',
    error: 'fa-circle-xmark text-rose-600',
    warning: 'fa-triangle-exclamation text-amber-600',
    info: 'fa-circle-info text-teal-600'
  };

  toast.className = `toast-msg p-4 rounded-2xl bg-[#edf2f7] text-slate-900 shadow-[8px_8px_22px_rgba(148,163,184,0.45),-6px_-6px_18px_rgba(255,255,255,0.95)] flex items-center gap-3 border border-white/90 text-xs pointer-events-auto transform transition-all duration-300 translate-y-2 opacity-0`;
  toast.innerHTML = `
    <i class="fa-solid ${icons[type] || icons.info} text-base"></i>
    <div class="flex-1 font-semibold">${message}</div>
    <button onclick="this.parentElement.remove()" class="text-slate-400 hover:text-slate-700 p-1">
      <i class="fa-solid fa-xmark"></i>
    </button>
  `;

  container.appendChild(toast);
  requestAnimationFrame(() => {
    toast.classList.remove('translate-y-2', 'opacity-0');
  });

  setTimeout(() => {
    toast.classList.add('opacity-0', 'translate-y-2');
    setTimeout(() => toast.remove(), 300);
  }, 4000);
}

// ---------------- NAVIGATION ----------------
function navigate(viewName) {
  // Mode & Role Access Guards
  if (viewName === 'provider-dashboard') {
    if (!state.currentUser || (state.currentUser.role !== 'provider' && state.currentUser.role !== 'admin')) {
      showToast('Technician access only. Please sign in as an approved provider.', 'warning');
      navigate('home');
      return;
    }
    if (state.currentUser.role === 'provider' && state.userMode === 'customer') {
      state.userMode = 'provider';
      localStorage.setItem('fixit_user_mode', 'provider');
      updateAuthUI();
      showToast('Switched to Provider Mode to view your technician jobs.', 'info');
    }
  }

  if (viewName === 'customer-requests') {
    if (!state.currentUser) {
      showToast('Please sign in to view your service requests.', 'info');
      openAuthModal('login');
      return;
    }
    if (state.currentUser.role === 'provider' && state.userMode !== 'customer') {
      state.userMode = 'customer';
      localStorage.setItem('fixit_user_mode', 'customer');
      updateAuthUI();
      showToast('Switched to Customer Mode to view your service requests.', 'info');
    }
  }

  state.currentView = viewName;

  document.querySelectorAll('.nav-btn').forEach(btn => {
    if (btn.dataset.view === viewName) {
      btn.classList.add('active');
    } else {
      btn.classList.remove('active');
    }
  });

  document.querySelectorAll('.view-panel').forEach(panel => {
    panel.classList.add('hidden');
  });

  const activePanel = document.getElementById(`view-${viewName}`);
  if (activePanel) {
    activePanel.classList.remove('hidden');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  // Update mobile bottom nav active indicators
  if (typeof updateMobileBottomNavUI === 'function') {
    updateMobileBottomNavUI();
  }

  // Close mobile drawer if opened
  const drawer = document.getElementById('mobile-drawer');
  if (drawer && !drawer.classList.contains('hidden')) {
    drawer.classList.add('hidden');
  }

  if (viewName === 'home') {
    loadHomeData();
  } else if (viewName === 'categories') {
    renderAllCategories();
  } else if (viewName === 'providers') {
    loadProviders();
  } else if (viewName === 'customer-requests') {
    loadCustomerRequests();
  } else if (viewName === 'provider-dashboard') {
    loadProviderDashboard();
  } else if (viewName === 'admin-dashboard') {
    loadAdminDashboard();
  }
}

// ---------------- LIQUID GLASS & 3D SCROLL / PERSPECTIVE SYSTEM ----------------
let scrollObserver3D = null;

function init3DScrollEffects() {
  if (typeof IntersectionObserver !== 'undefined') {
    scrollObserver3D = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          entry.target.classList.add('visible-3d');
        }
      });
    }, {
      threshold: 0.08,
      rootMargin: '0px 0px -30px 0px'
    });
  }
  refresh3DObservers();
  setup3DCardTilt();
}

function refresh3DObservers() {
  const elements = document.querySelectorAll('.scroll-3d');
  elements.forEach(el => {
    if (scrollObserver3D) {
      scrollObserver3D.observe(el);
    } else {
      el.classList.add('visible-3d');
    }
  });
}

function setup3DCardTilt() {
  const tiltCards = document.querySelectorAll('.glass-tilt');
  tiltCards.forEach(card => {
    if (card.dataset.tiltInitialized) return;
    card.dataset.tiltInitialized = 'true';

    card.addEventListener('mousemove', (e) => {
      const rect = card.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const centerX = rect.width / 2;
      const centerY = rect.height / 2;

      const rotateX = Number(((centerY - y) / centerY * 6).toFixed(2));
      const rotateY = Number(((x - centerX) / centerX * 6).toFixed(2));

      card.style.transform = `perspective(1000px) rotateX(${rotateX}deg) rotateY(${rotateY}deg) translateY(-4px)`;
      card.style.setProperty('--glare-x', `${x}px`);
      card.style.setProperty('--glare-y', `${y}px`);
    });

    card.addEventListener('mouseleave', () => {
      card.style.transform = '';
      card.style.setProperty('--glare-x', '50%');
      card.style.setProperty('--glare-y', '50%');
    });
  });
}

// ---------------- INITIALIZATION & AUTH ----------------
async function initApp() {
  // Immediately render cached auth state (prevents any visual delay/flicker)
  updateAuthUI();
  init3DScrollEffects();

  await loadCategories();

  // Validate or refresh session with backend
  if (state.token) {
    try {
      const data = await api('/auth/me');
      if (data && data.user) {
        state.currentUser = data.user;
        state.currentProvider = data.provider || null;
        localStorage.setItem('fixit_current_user', JSON.stringify(data.user));
        if (data.provider) localStorage.setItem('fixit_current_provider', JSON.stringify(data.provider));
        else localStorage.removeItem('fixit_current_provider');
      } else {
        throw new Error('Invalid session');
      }
    } catch (err) {
      console.warn('Session verification error:', err.message);
      // Only clear if server explicitly returned 401 Not Authenticated
      if (err.message && (err.message.includes('401') || err.message.includes('Not authenticated') || err.message.includes('Invalid session'))) {
        state.currentUser = null;
        state.currentProvider = null;
        state.token = null;
        localStorage.removeItem('fixit_token');
        localStorage.removeItem('fixit_current_user');
        localStorage.removeItem('fixit_current_provider');
      }
    }
  } else {
    state.currentUser = null;
    state.currentProvider = null;
    localStorage.removeItem('fixit_current_user');
    localStorage.removeItem('fixit_current_provider');
  }

  updateAuthUI();
  loadNotifications();
  loadHomeData();

  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const dateInput = document.getElementById('booking-date');
  if (dateInput) {
    dateInput.value = tomorrow.toISOString().split('T')[0];
    dateInput.min = new Date().toISOString().split('T')[0];
  }

  setInterval(() => {
    if (state.currentUser) {
      loadNotifications(true);
    }
  }, 10000);
}

function updateAuthUI() {
  const authButtons = document.getElementById('auth-buttons');
  const userPill = document.getElementById('user-profile-pill');
  const navMyRequests = document.getElementById('nav-my-requests');
  const navProviderJobs = document.getElementById('nav-provider-jobs');
  const navAdmin = document.getElementById('nav-admin');
  const reportBtn = document.getElementById('btn-report-problem');
  const roleToggleBtn = document.getElementById('btn-role-mode-toggle');
  const roleModeLabel = document.getElementById('role-mode-label');
  const mobileRoleBadge = document.getElementById('mobile-current-role-badge');

  if (state.currentUser) {
    if (authButtons) {
      authButtons.style.setProperty('display', 'none', 'important');
      authButtons.classList.add('hidden');
    }
    if (userPill) {
      userPill.style.setProperty('display', 'flex', 'important');
      userPill.classList.remove('hidden');
    }

    const nameEl = document.getElementById('user-name');
    if (nameEl) nameEl.textContent = state.currentUser.name;
    const avatarEl = document.getElementById('user-avatar');
    if (avatarEl) avatarEl.src = state.currentUser.avatar || 'https://api.dicebear.com/7.x/avataaars/svg?seed=user';

    if (mobileRoleBadge) {
      mobileRoleBadge.textContent = state.currentUser.name;
    }

    if (state.currentUser.role === 'customer') {
      if (roleToggleBtn) {
        roleToggleBtn.style.setProperty('display', 'none', 'important');
        roleToggleBtn.classList.add('hidden');
        roleToggleBtn.classList.remove('lg:inline-flex', 'inline-flex');
      }
      const badge = document.getElementById('user-role-badge');
      if (badge) badge.textContent = 'Customer';
      if (navMyRequests) {
        navMyRequests.style.removeProperty('display');
        navMyRequests.classList.remove('hidden');
      }
      if (navProviderJobs) {
        navProviderJobs.style.setProperty('display', 'none', 'important');
        navProviderJobs.classList.add('hidden');
      }
      if (navAdmin) {
        navAdmin.style.setProperty('display', 'none', 'important');
        navAdmin.classList.add('hidden');
      }
      if (reportBtn) {
        reportBtn.style.removeProperty('display');
        reportBtn.classList.remove('hidden');
        reportBtn.classList.add('hidden', 'md:inline-flex');
      }
    } else if (state.currentUser.role === 'provider') {
      // Dual-role provider support
      if (roleToggleBtn) {
        roleToggleBtn.style.removeProperty('display');
        roleToggleBtn.classList.remove('hidden');
        roleToggleBtn.classList.add('lg:inline-flex');
      }
      
      const mode = state.userMode || 'provider';
      if (mode === 'customer') {
        // Provider acting as Customer: provider features are disabled
        if (roleModeLabel) roleModeLabel.textContent = 'Switch to Pro Mode';
        const badge = document.getElementById('user-role-badge');
        if (badge) badge.textContent = 'Customer Mode';
        if (navMyRequests) {
          navMyRequests.style.removeProperty('display');
          navMyRequests.classList.remove('hidden');
        }
        if (navProviderJobs) {
          navProviderJobs.style.setProperty('display', 'none', 'important');
          navProviderJobs.classList.add('hidden');
        }
        if (reportBtn) {
          reportBtn.style.removeProperty('display');
          reportBtn.classList.remove('hidden');
          reportBtn.classList.add('hidden', 'md:inline-flex');
        }
      } else {
        // Provider acting as Technician: making customer requests is disabled
        if (roleModeLabel) roleModeLabel.textContent = 'Switch to Customer Mode';
        const badge = document.getElementById('user-role-badge');
        if (badge) badge.textContent = 'Provider Mode';
        if (navMyRequests) {
          navMyRequests.style.setProperty('display', 'none', 'important');
          navMyRequests.classList.add('hidden');
        }
        if (navProviderJobs) {
          navProviderJobs.style.removeProperty('display');
          navProviderJobs.classList.remove('hidden');
        }
        if (reportBtn) {
          // In provider mode, hide "Report a Problem"
          reportBtn.style.setProperty('display', 'none', 'important');
          reportBtn.classList.add('hidden');
        }
      }

      if (navAdmin) {
        navAdmin.style.setProperty('display', 'none', 'important');
        navAdmin.classList.add('hidden');
      }
    } else if (state.currentUser.role === 'admin') {
      if (roleToggleBtn) {
        roleToggleBtn.style.setProperty('display', 'none', 'important');
        roleToggleBtn.classList.add('hidden');
        roleToggleBtn.classList.remove('lg:inline-flex', 'inline-flex');
      }
      const badge = document.getElementById('user-role-badge');
      if (badge) badge.textContent = 'Admin';
      if (navMyRequests) {
        navMyRequests.style.removeProperty('display');
        navMyRequests.classList.remove('hidden');
      }
      if (navProviderJobs) {
        navProviderJobs.style.removeProperty('display');
        navProviderJobs.classList.remove('hidden');
      }
      if (navAdmin) {
        navAdmin.style.removeProperty('display');
        navAdmin.classList.remove('hidden');
      }
      if (reportBtn) {
        reportBtn.style.removeProperty('display');
        reportBtn.classList.remove('hidden');
        reportBtn.classList.add('hidden', 'md:inline-flex');
      }
    }
  } else {
    // Logged out / Guest: Role switcher button MUST NOT APPEAR!
    if (authButtons) {
      authButtons.style.setProperty('display', 'flex', 'important');
      authButtons.classList.remove('hidden');
    }
    if (userPill) {
      userPill.style.setProperty('display', 'none', 'important');
      userPill.classList.add('hidden');
    }
    if (roleToggleBtn) {
      roleToggleBtn.style.setProperty('display', 'none', 'important');
      roleToggleBtn.classList.add('hidden');
      roleToggleBtn.classList.remove('lg:inline-flex', 'inline-flex');
    }
    if (navMyRequests) {
      navMyRequests.style.setProperty('display', 'none', 'important');
      navMyRequests.classList.add('hidden');
    }
    if (navProviderJobs) {
      navProviderJobs.style.setProperty('display', 'none', 'important');
      navProviderJobs.classList.add('hidden');
    }
    if (navAdmin) {
      navAdmin.style.setProperty('display', 'none', 'important');
      navAdmin.classList.add('hidden');
    }
    if (reportBtn) {
      reportBtn.style.removeProperty('display');
      reportBtn.classList.remove('hidden');
      reportBtn.classList.add('hidden', 'md:inline-flex');
    }
    if (mobileRoleBadge) {
      mobileRoleBadge.textContent = 'Not Signed In';
    }
  }

  // Update responsive components
  if (typeof updateMobileDrawerUI === 'function') updateMobileDrawerUI();
  if (typeof updateMobileBottomNavUI === 'function') updateMobileBottomNavUI();
}

function toggleUserRoleMode() {
  if (!state.currentUser || state.currentUser.role !== 'provider') return;
  state.userMode = state.userMode === 'customer' ? 'provider' : 'customer';
  localStorage.setItem('fixit_user_mode', state.userMode);
  updateAuthUI();
  if (state.userMode === 'customer') {
    showToast('Switched to Customer Mode. You can now book services and hire pros!', 'success');
    if (state.currentView === 'providers') loadProviders();
    navigate('customer-requests');
  } else {
    showToast('Switched to Provider Mode. Welcome to your Pro Job Board!', 'success');
    if (state.currentView === 'providers') loadProviders();
    navigate('provider-dashboard');
  }
}

function logout() {
  state.currentUser = null;
  state.currentProvider = null;
  state.token = null;
  localStorage.removeItem('fixit_token');
  localStorage.removeItem('fixit_current_user');
  localStorage.removeItem('fixit_current_provider');
  clearAuthForms();
  updateAuthUI();
  showToast('Logged out successfully', 'info');
  navigate('home');
}


// ---------------- FORGOT PASSWORD (MANDATORY OTP VERIFICATION) ----------------
state.pendingResetEmail = null;

function openForgotPasswordModal() {
  closeAuthModal();
  const modal = document.getElementById('forgot-password-modal');
  if (!modal) return;
  modal.classList.remove('hidden');

  // Reset to Step 1
  const step1 = document.getElementById('form-reset-step1');
  const step2 = document.getElementById('form-reset-step2');
  if (step1) step1.classList.remove('hidden');
  if (step2) step2.classList.add('hidden');

  const reqEmailInput = document.getElementById('reset-req-email');
  if (reqEmailInput) {
    const loginEmailInput = document.getElementById('login-email');
    if (loginEmailInput && loginEmailInput.value.trim()) {
      reqEmailInput.value = loginEmailInput.value.trim();
    } else if (state.currentUser?.email) {
      reqEmailInput.value = state.currentUser.email;
    } else {
      reqEmailInput.value = '';
    }
    setTimeout(() => reqEmailInput.focus(), 100);
  }

  const otpInput = document.getElementById('reset-otp-input');
  if (otpInput) otpInput.value = '';
  const newPass = document.getElementById('reset-new-password');
  if (newPass) newPass.value = '';
  const confPass = document.getElementById('reset-confirm-password');
  if (confPass) confPass.value = '';
}

function closeForgotPasswordModal() {
  const modal = document.getElementById('forgot-password-modal');
  if (modal) modal.classList.add('hidden');
}

function backToResetStep1() {
  const step1 = document.getElementById('form-reset-step1');
  const step2 = document.getElementById('form-reset-step2');
  if (step1) step1.classList.remove('hidden');
  if (step2) step2.classList.add('hidden');
}

async function handleRequestResetOtp(e) {
  e.preventDefault();
  const emailInput = document.getElementById('reset-req-email');
  const email = emailInput ? emailInput.value.trim() : '';

  if (!email) {
    showToast('Please enter your email address', 'warning');
    return;
  }

  const sendBtn = document.getElementById('btn-send-reset-otp');
  const origText = sendBtn ? sendBtn.innerHTML : '';
  if (sendBtn) {
    sendBtn.disabled = true;
    sendBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin mr-1"></i> Sending OTP...';
  }

  try {
    const res = await api('/auth/forgot-password-request', {
      method: 'POST',
      body: JSON.stringify({ email })
    });

    state.pendingResetEmail = res.email || email;

    // Switch to Step 2
    const step1 = document.getElementById('form-reset-step1');
    const step2 = document.getElementById('form-reset-step2');
    if (step1) step1.classList.add('hidden');
    if (step2) step2.classList.remove('hidden');

    const dispEmail = document.getElementById('reset-display-email');
    if (dispEmail) dispEmail.textContent = state.pendingResetEmail;

    const otpInput = document.getElementById('reset-otp-input');
    if (otpInput) {
      otpInput.value = '';
      setTimeout(() => otpInput.focus(), 100);
    }

    showToast(res.message || 'OTP verification code sent to your email!', 'info');
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    if (sendBtn) {
      sendBtn.disabled = false;
      sendBtn.innerHTML = origText;
    }
  }
}

async function resendResetOtp() {
  const email = state.pendingResetEmail || document.getElementById('reset-display-email')?.textContent?.trim();
  if (!email) {
    showToast('Please enter your email in Step 1 first.', 'warning');
    backToResetStep1();
    return;
  }

  const resendBtn = document.getElementById('btn-resend-reset-otp');
  if (resendBtn) resendBtn.disabled = true;

  try {
    const res = await api('/auth/forgot-password-request', {
      method: 'POST',
      body: JSON.stringify({ email })
    });

    showToast(res.message || 'A fresh reset code has been sent!', 'success');
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    if (resendBtn) resendBtn.disabled = false;
  }
}

async function handleVerifyResetPassword(e) {
  e.preventDefault();
  const email = state.pendingResetEmail || document.getElementById('reset-display-email')?.textContent?.trim();
  const otp = document.getElementById('reset-otp-input')?.value.trim();
  const newPassword = document.getElementById('reset-new-password')?.value;
  const confirmPassword = document.getElementById('reset-confirm-password')?.value;

  if (!email || !otp) {
    showToast('Please enter the 6-digit OTP code', 'warning');
    return;
  }

  if (newPassword.length < 6) {
    showToast('New password must be at least 6 characters long', 'warning');
    return;
  }

  if (newPassword !== confirmPassword) {
    showToast('Passwords do not match. Please verify.', 'error');
    return;
  }

  const submitBtn = e.target.querySelector('button[type="submit"]');
  const origHtml = submitBtn ? submitBtn.innerHTML : '';
  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin mr-1"></i> Updating Password...';
  }

  try {
    const res = await api('/auth/reset-password-verify', {
      method: 'POST',
      body: JSON.stringify({ email, otp, new_password: newPassword })
    });

    closeForgotPasswordModal();
    if (res.token && res.user) {
      state.currentUser = res.user;
      state.currentProvider = res.provider;
      state.token = res.token;
      localStorage.setItem('fixit_token', res.token);
      localStorage.setItem('fixit_current_user', JSON.stringify(res.user));
      if (res.provider) localStorage.setItem('fixit_current_provider', JSON.stringify(res.provider));
      updateAuthUI();
      loadNotifications();
    }
    showToast(res.message || 'Password reset successfully! You are now logged in.', 'success');
    if (res.user?.role === 'provider') navigate('provider-dashboard');
    else navigate('customer-requests');
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.innerHTML = origHtml;
    }
  }
}

// ---------------- MOBILE DRAWER & BOTTOM NAV CONTROLLER ----------------
function toggleMobileDrawer() {
  const drawer = document.getElementById('mobile-drawer');
  if (drawer) {
    drawer.classList.toggle('hidden');
    if (!drawer.classList.contains('hidden')) {
      updateMobileDrawerUI();
    }
  }
}

function updateMobileDrawerUI() {
  const userSec = document.getElementById('drawer-user-section');
  const authSec = document.getElementById('drawer-auth-actions');
  const reqBtn = document.getElementById('drawer-nav-my-requests');
  const jobBtn = document.getElementById('drawer-nav-provider-jobs');
  const admBtn = document.getElementById('drawer-nav-admin');

  if (!userSec) return;

  if (state.currentUser) {
    const roleColor = state.currentUser.role === 'provider' ? 'emerald' : (state.currentUser.role === 'admin' ? 'rose' : 'sky');
    userSec.innerHTML = `
      <div class="flex items-center gap-3">
        <img src="${state.currentUser.avatar || 'https://api.dicebear.com/7.x/avataaars/svg?seed=user'}" class="w-12 h-12 rounded-full border border-slate-200 ring-2 ring-brand-500/20 object-cover" alt="avatar">
        <div class="flex-1 min-w-0">
          <div class="font-bold text-slate-900 text-sm truncate">${escapeHtml(state.currentUser.name)}</div>
          <div class="text-xs text-slate-500 truncate">${escapeHtml(state.currentUser.email)}</div>
          <div class="mt-1 flex items-center gap-2">
            <span class="px-2 py-0.5 rounded-full text-[10px] font-bold bg-${roleColor}-100 text-${roleColor}-800 capitalize">${state.currentUser.role}</span>
            ${state.currentUser.role === 'provider' ? `
              <button onclick="toggleUserRoleMode(); toggleMobileDrawer();" class="text-[10px] font-bold text-brand-700 underline">
                ${state.userMode === 'customer' ? 'Switch to Pro Mode' : 'Switch to Customer'}
              </button>
            ` : ''}
          </div>
        </div>
      </div>
    `;

    if (authSec) {
      authSec.innerHTML = `
        <button onclick="logout(); toggleMobileDrawer();" class="w-full py-2 bg-rose-50 hover:bg-rose-100 text-rose-700 font-bold rounded-xl border border-rose-200 text-xs flex items-center justify-center gap-2 transition">
          <i class="fa-solid fa-arrow-right-from-bracket"></i>
          <span>Log Out</span>
        </button>
      `;
    }

    if (state.currentUser.role === 'customer') {
      if (reqBtn) reqBtn.classList.remove('hidden');
      if (jobBtn) jobBtn.classList.add('hidden');
      if (admBtn) admBtn.classList.add('hidden');
    } else if (state.currentUser.role === 'provider') {
      const mode = state.userMode || 'provider';
      if (mode === 'customer') {
        if (reqBtn) reqBtn.classList.remove('hidden');
        if (jobBtn) jobBtn.classList.add('hidden');
      } else {
        if (reqBtn) reqBtn.classList.add('hidden');
        if (jobBtn) jobBtn.classList.remove('hidden');
      }
      if (admBtn) admBtn.classList.add('hidden');
    } else if (state.currentUser.role === 'admin') {
      if (reqBtn) reqBtn.classList.remove('hidden');
      if (jobBtn) jobBtn.classList.remove('hidden');
      if (admBtn) admBtn.classList.remove('hidden');
    }
  } else {
    userSec.innerHTML = `
      <div class="text-center py-2 space-y-1">
        <div class="font-bold text-slate-900 text-sm">Welcome to Fixit</div>
        <p class="text-xs text-slate-500">Sign in to book certified handymen or manage repair jobs.</p>
      </div>
    `;

    if (authSec) {
      authSec.innerHTML = `
        <button onclick="openAuthModal('login'); toggleMobileDrawer();" class="flex-1 py-2 bg-slate-900 text-white font-bold rounded-xl text-xs transition">Sign In</button>
        <button onclick="openAuthModal('register'); toggleMobileDrawer();" class="flex-1 py-2 bg-brand-50 text-brand-700 border border-brand-200 font-bold rounded-xl text-xs transition">Register</button>
      `;
    }

    if (reqBtn) reqBtn.classList.add('hidden');
    if (jobBtn) jobBtn.classList.add('hidden');
    if (admBtn) admBtn.classList.add('hidden');
  }
}

function updateMobileBottomNavUI() {
  const reqBtn = document.querySelector('.mobile-nav-btn[data-view="requests"]');
  if (reqBtn) {
    const isProMode = state.currentUser?.role === 'provider' && state.userMode !== 'customer';
    const label = reqBtn.querySelector('span');
    const icon = reqBtn.querySelector('i');
    if (isProMode) {
      if (label) label.textContent = 'Jobs';
      if (icon) icon.className = 'fa-solid fa-briefcase text-base';
    } else {
      if (label) label.textContent = 'Requests';
      if (icon) icon.className = 'fa-solid fa-clipboard-list text-base';
    }
  }

  document.querySelectorAll('.mobile-nav-btn').forEach(btn => {
    const v = btn.dataset.view;
    if (v === state.currentView || (v === 'requests' && (state.currentView === 'customer-requests' || state.currentView === 'provider-dashboard'))) {
      btn.classList.add('text-brand-600', 'font-bold');
      btn.classList.remove('text-slate-600');
    } else {
      btn.classList.remove('text-brand-600', 'font-bold');
      btn.classList.add('text-slate-600');
    }
  });
}

function navigateRoleRequests() {
  if (!state.currentUser) {
    openAuthModal('login');
    return;
  }
  if (state.currentUser.role === 'provider') {
    if (state.userMode === 'customer') navigate('customer-requests');
    else navigate('provider-dashboard');
  } else if (state.currentUser.role === 'admin') {
    navigate('admin-dashboard');
  } else {
    navigate('customer-requests');
  }
}

// ---------------- REGISTRATION EMAIL OTP VERIFICATION ----------------
state.pendingRegisterEmail = null;

function openOtpVerifyModal(email) {
  state.pendingRegisterEmail = email;
  const modal = document.getElementById('otp-verify-modal');
  if (!modal) return;
  modal.classList.remove('hidden');

  const emailEl = document.getElementById('otp-target-email');
  if (emailEl) emailEl.textContent = email;

  const input = document.getElementById('reg-otp-input');
  if (input) {
    input.value = '';
    setTimeout(() => input.focus(), 100);
  }
}

function closeOtpVerifyModal() {
  const modal = document.getElementById('otp-verify-modal');
  if (modal) modal.classList.add('hidden');
}

async function handleOtpVerifySubmit(e) {
  e.preventDefault();
  const email = state.pendingRegisterEmail || document.getElementById('otp-target-email')?.textContent?.trim();
  const otp = document.getElementById('reg-otp-input')?.value?.trim();

  if (!email || !otp) {
    showToast('Please enter the 6-digit verification code', 'warning');
    return;
  }

  const btn = document.getElementById('btn-submit-verify-otp');
  const origBtnText = btn ? btn.innerHTML : '';
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin mr-1"></i> Verifying...';
  }

  try {
    const res = await api('/auth/verify-register', {
      method: 'POST',
      body: JSON.stringify({ email, otp })
    });

    closeOtpVerifyModal();
    state.currentUser = res.user;
    state.currentProvider = res.provider;
    state.token = res.token;
    localStorage.setItem('fixit_token', res.token);
    localStorage.setItem('fixit_current_user', JSON.stringify(res.user));
    if (res.provider) localStorage.setItem('fixit_current_provider', JSON.stringify(res.provider));
    else localStorage.removeItem('fixit_current_provider');

    updateAuthUI();
    loadNotifications();
    showToast(res.message || `Account verified successfully! Welcome ${res.user.name}`, 'success');

    if (res.user.role === 'provider') {
      navigate('provider-dashboard');
    } else {
      navigate('customer-requests');
    }
  } catch (err) {
    showToast('Verification failed: ' + err.message, 'error');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = origBtnText;
    }
  }
}

async function resendRegisterOtp() {
  const email = state.pendingRegisterEmail || document.getElementById('otp-target-email')?.textContent?.trim();
  if (!email) {
    showToast('No pending registration email found. Please register again.', 'warning');
    return;
  }

  const resendBtn = document.getElementById('btn-resend-register-otp');
  if (resendBtn) resendBtn.disabled = true;

  try {
    const res = await api('/auth/resend-register-otp', {
      method: 'POST',
      body: JSON.stringify({ email })
    });

    showToast(res.message || 'A fresh verification code has been dispatched to your email!', 'success');
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    if (resendBtn) resendBtn.disabled = false;
  }
}







// ---------------- CATEGORIES ----------------
async function loadCategories() {
  try {
    const data = await api('/categories');
    state.categories = data.categories || [];

    const bookingSelect = document.getElementById('booking-category');
    const filterSelect = document.getElementById('provider-category-filter');
    const regCatSelect = document.getElementById('reg-category');

    if (bookingSelect) {
      bookingSelect.innerHTML = state.categories.map(c => `
        <option value="${c.id}">${c.name} (Base ₹${c.base_price})</option>
      `).join('');
    }

    if (filterSelect) {
      filterSelect.innerHTML = `<option value="all">All Categories</option>` + state.categories.map(c => `
        <option value="${c.id}">${c.name}</option>
      `).join('');
    }

    if (regCatSelect) {
      regCatSelect.innerHTML = state.categories.map(c => `
        <option value="${c.id}">${c.name}</option>
      `).join('');
    }
  } catch (err) {
    console.error('Error loading categories:', err);
  }
}

function renderCategoryCards(categories, containerId) {
  const container = document.getElementById(containerId);
  if (!container) return;

  container.innerHTML = categories.map(cat => `
    <div class="scroll-3d glass-tilt group bg-white rounded-3xl p-6 border border-slate-100 shadow-sm hover:shadow-xl hover:border-brand-200 transition-all duration-300 flex flex-col justify-between">
      <div>
        <div class="flex items-center justify-between mb-4">
          <div class="w-12 h-12 rounded-2xl bg-brand-50 text-brand-600 flex items-center justify-center text-xl group-hover:scale-110 group-hover:bg-brand-600 group-hover:text-white transition-all shadow-sm">
            <i class="fa-solid ${cat.icon || 'fa-tools'}"></i>
          </div>
          <span class="text-xs font-bold text-slate-400 bg-slate-50 px-2.5 py-1 rounded-full">
            From ₹${cat.base_price}
          </span>
        </div>
        <h3 class="text-base font-black text-slate-900 group-hover:text-brand-700 transition">${cat.name}</h3>
        <p class="text-xs text-slate-500 mt-2 leading-relaxed">${cat.description}</p>
      </div>

      <div class="pt-6 mt-4 border-t border-slate-100 flex items-center justify-between">
        <span class="text-[11px] font-semibold text-slate-500">
          <i class="fa-solid fa-user-check text-brand-600 mr-1"></i> ${cat.providers_count || 1} verified pros
        </span>
        <button onclick="openBookingModalWithCategory(${cat.id})" class="text-xs font-bold text-brand-600 group-hover:text-brand-700 flex items-center gap-1">
          <span>Book Now</span>
          <i class="fa-solid fa-arrow-right text-[10px] group-hover:translate-x-1 transition-transform"></i>
        </button>
      </div>
    </div>
  `).join('');

  refresh3DObservers();
  setup3DCardTilt();
}

function renderAllCategories() {
  renderCategoryCards(state.categories, 'all-categories-grid');
}

// ---------------- PROVIDERS ----------------
async function loadProviders() {
  const catFilter = document.getElementById('provider-category-filter')?.value || 'all';
  const search = document.getElementById('provider-search-box')?.value || '';

  let endpoint = `/providers?status=approved`;
  if (catFilter !== 'all') endpoint += `&category_id=${catFilter}`;
  if (search) endpoint += `&search=${encodeURIComponent(search)}`;
  if (state.currentUser && state.currentUser.id) endpoint += `&exclude_user_id=${state.currentUser.id}`;

  try {
    const data = await api(endpoint);
    state.providers = data.providers || [];
    renderProvidersGrid(state.providers, 'providers-list-grid');
  } catch (err) {
    showToast('Failed to load providers: ' + err.message, 'error');
  }
}

function filterProviders() {
  loadProviders();
}

document.getElementById('provider-search-box')?.addEventListener('input', debounce(() => {
  loadProviders();
}, 300));

function renderProvidersGrid(providers, containerId) {
  const container = document.getElementById(containerId);
  if (!container) return;

  // Never display the currently logged-in user's own provider account in the find/hire list
  const filtered = (providers || []).filter(p => {
    if (!state.currentUser) return true;
    if (p.user_id && state.currentUser.id && Number(p.user_id) === Number(state.currentUser.id)) return false;
    if (state.currentProvider && state.currentProvider.id && Number(p.id) === Number(state.currentProvider.id)) return false;
    if (p.email && state.currentUser.email && p.email.toLowerCase() === state.currentUser.email.toLowerCase()) return false;
    return true;
  });

  if (filtered.length === 0) {
    container.innerHTML = `
      <div class="col-span-full py-16 text-center text-slate-400 bg-white rounded-3xl border border-dashed border-slate-200">
        <i class="fa-solid fa-user-slash text-3xl mb-2"></i>
        <div class="font-bold text-sm text-slate-700">No Service Providers Found</div>
        <p class="text-xs text-slate-400 mt-1">Try adjusting your search keywords or category filters.</p>
      </div>
    `;
    return;
  }

  container.innerHTML = filtered.map(p => {
    let skills = [];
    try {
      skills = typeof p.skills === 'string' ? JSON.parse(p.skills) : (p.skills || []);
    } catch(e) {
      skills = p.skills ? p.skills.split(',') : [];
    }

    return `
      <div class="scroll-3d glass-tilt bg-white rounded-3xl p-6 border border-slate-100 shadow-sm hover:shadow-xl transition-all duration-300 flex flex-col justify-between">
        <div>
          <div class="flex items-start gap-4">
            <img src="${p.avatar || 'https://api.dicebear.com/7.x/avataaars/svg?seed=' + p.name}" alt="${p.name}" class="w-14 h-14 rounded-2xl object-cover ring-2 ring-brand-500/10">
            <div class="flex-1 min-w-0">
              <div class="flex items-center gap-2">
                <h3 class="font-bold text-slate-900 text-sm truncate">${p.name}</h3>
                <span title="Verified Pro" class="text-teal-600"><i class="fa-solid fa-circle-check text-xs"></i></span>
              </div>
              <div class="text-xs font-semibold text-brand-600 mt-0.5">${p.category_name || 'General Repair'}</div>
              <div class="flex items-center gap-3 mt-1.5 text-xs text-slate-500">
                <span class="flex items-center text-amber-500 font-bold">
                  <i class="fa-solid fa-star text-[11px] mr-1"></i> ${Number(p.rating || 5.0).toFixed(1)}
                  <span class="text-slate-400 font-normal ml-1">(${p.reviews_count || 0})</span>
                </span>
                <span>•</span>
                <span>${p.experience_years || 3} yrs exp</span>
              </div>
              <div class="text-[11px] text-slate-500 font-medium flex items-center gap-1.5 mt-1">
                <i class="fa-solid fa-location-dot text-rose-500 text-[10px]"></i>
                <span class="truncate">${p.district || 'India'}</span>
              </div>
            </div>
          </div>

          <p class="text-xs text-slate-600 mt-4 line-clamp-2 leading-relaxed">${p.bio || 'Experienced technician dedicated to high quality repairs.'}</p>

          <div class="flex flex-wrap gap-1.5 mt-4">
            ${skills.slice(0, 3).map(s => `
              <span class="text-[10px] font-semibold bg-slate-100 text-slate-700 px-2.5 py-0.5 rounded-lg">${s}</span>
            `).join('')}
            ${skills.length > 3 ? `<span class="text-[10px] text-slate-400 font-medium">+${skills.length - 3} more</span>` : ''}
          </div>
        </div>

        <div class="pt-5 mt-5 border-t border-slate-100 flex items-center justify-between">
          <div>
            <div class="text-[10px] text-slate-400 uppercase font-semibold">Service Rate</div>
            <div class="text-base font-black text-slate-900">₹${p.hourly_rate}<span class="text-xs font-normal text-slate-500">/hr</span></div>
          </div>
          <button onclick="bookSpecificProvider(${p.id}, ${p.category_id || 1}, '${p.name.replace(/'/g, "\\'")}')" class="bg-brand-600 hover:bg-brand-700 text-white text-xs font-bold px-4 py-2 rounded-xl transition shadow shadow-brand-500/20 flex items-center gap-1.5">
            <i class="fa-solid fa-calendar-check text-[11px]"></i>
            <span>Book Pro</span>
          </button>
        </div>
      </div>
    `;
  }).join('');

  refresh3DObservers();
  setup3DCardTilt();
}

// ---------------- HOME VIEW LOADER ----------------
async function loadHomeData() {
  if (state.categories.length === 0) {
    await loadCategories();
  }
  renderCategoryCards(state.categories.slice(0, 6), 'home-categories-grid');

  try {
    let pEndpoint = '/providers?status=approved';
    if (state.currentUser && state.currentUser.id) pEndpoint += `&exclude_user_id=${state.currentUser.id}`;
    const pData = await api(pEndpoint);
    renderProvidersGrid((pData.providers || []).slice(0, 3), 'home-featured-providers-grid');
  } catch(e){}

  try {
    const rData = await api('/reviews');
    const reviews = (rData.reviews || []).slice(0, 3);
    const revContainer = document.getElementById('home-reviews-grid');
    if (revContainer && reviews.length > 0) {
      revContainer.innerHTML = reviews.map(r => `
        <div class="scroll-3d glass-tilt bg-slate-800/80 backdrop-blur-xl rounded-3xl p-6 border border-slate-700/80 shadow-lg flex flex-col justify-between">
          <div>
            <div class="flex items-center gap-1 text-amber-400 text-xs mb-3">
              ${Array.from({ length: r.rating || 5 }).map(() => '<i class="fa-solid fa-star"></i>').join('')}
            </div>
            <p class="text-xs text-slate-300 leading-relaxed italic">"${r.comment || 'Great service, highly satisfied!'}"</p>
          </div>
          <div class="flex items-center gap-3 pt-4 mt-4 border-t border-slate-700/60">
            <img src="${r.customer_avatar || 'https://api.dicebear.com/7.x/avataaars/svg?seed=' + r.customer_name}" alt="${r.customer_name}" class="w-8 h-8 rounded-full object-cover">
            <div>
              <div class="text-xs font-bold text-white">${r.customer_name}</div>
              <div class="text-[10px] text-brand-400 font-medium">${r.category_name} Service</div>
            </div>
          </div>
        </div>
      `).join('');
      refresh3DObservers();
      setup3DCardTilt();
    }
  } catch(e){}
}

function handleHomeSearch() {
  const query = document.getElementById('home-search-input')?.value;
  navigate('providers');
  const searchBox = document.getElementById('provider-search-box');
  if (searchBox) {
    searchBox.value = query;
    loadProviders();
  }
}

// ---------------- CUSTOMER PORTAL & REQUEST TRACKER ----------------
async function loadCustomerRequests(viewAll = false) {
  if (!state.currentUser) {
    showToast('Please sign in to view your service requests', 'warning');
    openAuthModal('login');
    return;
  }

  const statusFilter = document.getElementById('customer-status-filter')?.value || 'all';
  let endpoint = viewAll ? `/requests?all=true` : `/requests?scope=customer`;
  if (statusFilter !== 'all') endpoint += `&status=${statusFilter}`;

  try {
    const data = await api(endpoint);
    state.customerRequests = data.requests || [];
    renderCustomerRequests(state.customerRequests, viewAll);
  } catch (err) {
    showToast('Failed to load requests: ' + err.message, 'error');
  }
}

function renderCustomerRequests(requests, isViewingAll = false) {
  const container = document.getElementById('customer-requests-container');
  if (!container) return;

  if (requests.length === 0) {
    const currentName = state.currentUser ? state.currentUser.name : 'your account';
    container.innerHTML = `
      <div class="py-16 text-center text-slate-400 bg-white rounded-3xl border border-dashed border-slate-200 p-8 space-y-4">
        <i class="fa-solid fa-clipboard-list text-3xl text-slate-300"></i>
        <div>
          <div class="font-bold text-sm text-slate-700">No Service Requests Found for ${currentName}</div>
          <p class="text-xs text-slate-400 mt-1">You haven't submitted a repair request under this active account yet.</p>
        </div>
        <div class="flex items-center justify-center gap-3 pt-2 flex-wrap">
          <button onclick="openBookingModal()" class="bg-brand-600 hover:bg-brand-700 text-white text-xs font-bold px-4 py-2 rounded-xl transition shadow flex items-center gap-1.5">
            <i class="fa-solid fa-plus"></i> Report a Problem Now
          </button>
          <button onclick="loadCustomerRequests(true)" class="bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-bold px-4 py-2 rounded-xl transition flex items-center gap-1.5">
            <i class="fa-solid fa-list-check"></i> View All Platform Requests (Show All Active)
          </button>
        </div>
      </div>
    `;
    return;
  }

  const headerNotice = isViewingAll ? `
    <div class="bg-amber-50 border border-amber-200 rounded-2xl p-3.5 mb-4 flex items-center justify-between text-xs text-amber-900">
      <div class="flex items-center gap-2">
        <i class="fa-solid fa-circle-info text-amber-600"></i>
        <span>Viewing <strong>All Platform Requests</strong> (${requests.length} requests across all customers).</span>
      </div>
      <button onclick="loadCustomerRequests(false)" class="underline font-bold text-amber-800 hover:text-amber-950">Switch to My Requests</button>
    </div>
  ` : '';

  container.innerHTML = headerNotice + requests.map(req => {
    let photos = [];
    try {
      photos = typeof req.photos === 'string' ? JSON.parse(req.photos) : (req.photos || []);
    } catch(e) {
      photos = [];
    }

    let stepIndex = 0;
    if (req.status === 'Accepted') stepIndex = 1;
    else if (req.status === 'In Progress') stepIndex = 2;
    else if (req.status === 'Completed') stepIndex = 3;

    const isRejected = req.status === 'Rejected';

    return `
      <div class="scroll-3d glass-tilt bg-white rounded-3xl p-6 border border-slate-100 shadow-sm hover:shadow-md transition">
        <div class="flex flex-col sm:flex-row sm:items-center justify-between pb-4 border-b border-slate-100 gap-2">
          <div class="flex items-center gap-3">
            <span class="text-xs font-black tracking-wider px-2.5 py-1 rounded-lg bg-slate-100 text-slate-700">${req.ticket_number}</span>
            <span class="text-xs font-bold text-brand-700 bg-brand-50 px-2.5 py-1 rounded-lg flex items-center gap-1.5">
              <i class="fa-solid ${req.category_icon || 'fa-tools'}"></i>
              ${req.category_name}
            </span>
            <span class="text-[11px] text-slate-400">${new Date(req.created_at || Date.now()).toLocaleDateString()}</span>
          </div>
          <div>
            <span class="text-xs font-bold px-3 py-1 rounded-full badge-${req.status.toLowerCase().replace(' ', '-')}">
              ${req.status}
            </span>
          </div>
        </div>

        <div class="grid grid-cols-1 md:grid-cols-12 gap-6 my-6">
          <div class="md:col-span-8 space-y-2">
            <h3 class="text-base font-bold text-slate-900">${req.title}</h3>
            <p class="text-xs text-slate-600 leading-relaxed">${req.description}</p>
            
            <div class="flex flex-wrap gap-4 pt-2 text-xs text-slate-500 font-medium">
              <div><i class="fa-regular fa-calendar text-brand-600 mr-1.5"></i> ${req.preferred_date} (${req.preferred_time})</div>
              <div><i class="fa-solid fa-location-dot text-rose-500 mr-1.5"></i> ${req.address}</div>
              <div><i class="fa-solid fa-bolt text-amber-500 mr-1.5"></i> Urgency: <span class="capitalize font-semibold text-slate-800">${req.urgency}</span></div>
            </div>

            ${req.rejection_reason ? `
              <div class="mt-3 p-3 rounded-xl bg-rose-50 border border-rose-100 text-rose-800 text-xs">
                <span class="font-bold">Decline Reason:</span> ${req.rejection_reason}
              </div>
            ` : ''}

            ${req.completion_notes ? `
              <div class="mt-3 p-3 rounded-xl bg-emerald-50 border border-emerald-100 text-emerald-900 text-xs">
                <span class="font-bold">Completion Notes:</span> ${req.completion_notes}
                <div class="font-bold mt-1 text-emerald-800">Final Total Billed: ₹${req.final_cost || req.estimated_cost}</div>
              </div>
            ` : ''}
          </div>

          <div class="md:col-span-4 flex items-center justify-end">
            ${photos.length > 0 ? `
              <div class="relative group">
                <img src="${photos[0]}" alt="Damage Photo" class="w-32 h-32 rounded-2xl object-cover border border-slate-200 shadow-sm cursor-pointer hover:scale-105 transition" onclick="window.open('${photos[0]}', '_blank')">
                <div class="text-[10px] text-center text-slate-400 mt-1">Uploaded Photo</div>
              </div>
            ` : `
              <div class="w-32 h-32 rounded-2xl bg-slate-50 border border-dashed border-slate-200 flex flex-col items-center justify-center text-slate-400 text-xs">
                <i class="fa-regular fa-image text-2xl mb-1"></i>
                <span class="text-[10px]">No photo</span>
              </div>
            `}
          </div>
        </div>

        ${!isRejected ? `
          <div class="bg-slate-50 rounded-2xl p-4 mb-4 border border-slate-100">
            <div class="text-[11px] font-bold text-slate-400 uppercase tracking-wider mb-3">Service Lifecycle Tracker</div>
            <div class="flex items-center justify-between">
              <div class="stepper-item ${stepIndex >= 0 ? (stepIndex === 0 ? 'active' : 'completed') : ''}">
                <div class="stepper-circle"><i class="fa-solid fa-clock"></i></div>
                <div class="stepper-label">1. Pending</div>
              </div>
              <div class="stepper-item ${stepIndex >= 1 ? (stepIndex === 1 ? 'active' : 'completed') : ''}">
                <div class="stepper-circle"><i class="fa-solid fa-handshake"></i></div>
                <div class="stepper-label">2. Accepted</div>
              </div>
              <div class="stepper-item ${stepIndex >= 2 ? (stepIndex === 2 ? 'active' : 'completed') : ''}">
                <div class="stepper-circle"><i class="fa-solid fa-wrench"></i></div>
                <div class="stepper-label">3. In Progress</div>
              </div>
              <div class="stepper-item ${stepIndex >= 3 ? 'completed' : ''}">
                <div class="stepper-circle"><i class="fa-solid fa-check"></i></div>
                <div class="stepper-label">4. Completed</div>
              </div>
            </div>
          </div>
        ` : ''}

        <div class="flex flex-col sm:flex-row sm:items-center justify-between pt-4 border-t border-slate-100 gap-4">
          <div class="flex items-center gap-3">
            ${req.provider_name ? `
              <img src="${req.provider_avatar || 'https://api.dicebear.com/7.x/avataaars/svg?seed=' + req.provider_name}" class="w-10 h-10 rounded-full object-cover border border-slate-200">
              <div>
                <div class="text-xs font-bold text-slate-900">${req.provider_name}</div>
                <div class="text-[11px] text-slate-500">Contact: <span class="font-medium text-slate-800">${req.provider_phone || 'Assigned Pro'}</span>${req.provider_district ? ` • <span class="text-rose-600 font-semibold"><i class="fa-solid fa-location-dot"></i> ${req.provider_district}</span>` : ''}</div>
              </div>
            ` : `
              <div class="w-10 h-10 rounded-full bg-slate-100 flex items-center justify-center text-slate-400 text-xs">
                <i class="fa-solid fa-user-clock"></i>
              </div>
              <div>
                <div class="text-xs font-bold text-slate-700">Waiting for Pro Assignment</div>
                <div class="text-[11px] text-slate-400">Technicians in your area have been alerted</div>
              </div>
            `}
          </div>

          <div class="flex items-center flex-wrap gap-2">
            ${(req.status !== 'Rejected') ? `
              <button onclick="openChatModal(${req.id})" class="bg-brand-600 hover:bg-brand-700 text-white text-xs font-bold px-3.5 py-2 rounded-xl transition shadow flex items-center gap-1.5" title="Message provider and negotiate offline payment">
                <i class="fa-solid fa-comments"></i> Chat & Negotiate
              </button>
            ` : ''}

            ${req.offline_payment_agreed ? `
              <span class="text-[11px] font-bold px-2.5 py-1 rounded-xl bg-amber-50 text-amber-800 border border-amber-200 flex items-center gap-1">
                <i class="fa-solid fa-handshake"></i> Offline Deal: ₹${req.agreed_price || req.final_cost}
              </span>
            ` : ''}

            ${req.status === 'Completed' ? `
              ${req.user_review_rating ? `
                <div class="text-xs font-semibold text-slate-700 flex items-center gap-1.5 bg-amber-50 px-3 py-1.5 rounded-xl border border-amber-200">
                  <span class="text-amber-500 font-bold">${req.user_review_rating} <i class="fa-solid fa-star"></i></span>
                  <span class="text-slate-500 italic">"${req.user_review_comment || 'Rated'}"</span>
                </div>
              ` : `
                <button onclick="openReviewModal(${req.id})" class="bg-amber-500 hover:bg-amber-600 text-white text-xs font-bold px-4 py-2 rounded-xl transition shadow flex items-center gap-1.5">
                  <i class="fa-solid fa-star"></i> Rate & Review Service
                </button>
              `}
            ` : ''}
          </div>
        </div>
      </div>
    `;
  }).join('');

  refresh3DObservers();
  setup3DCardTilt();
}

// ---------------- PROVIDER WORKSPACE & LIVE LOCATION RADAR ----------------
state.providerJobFilter = 'all';

function setProviderJobFilter(filter) {
  state.providerJobFilter = filter;
  const btnAll = document.getElementById('provider-filter-all');
  const btn5km = document.getElementById('provider-filter-5km');
  if (btnAll && btn5km) {
    if (filter === 'all') {
      btnAll.className = 'text-xs font-bold px-3 py-1.5 rounded-xl bg-slate-900 text-white shadow-sm transition';
      btn5km.className = 'text-xs font-bold px-3 py-1.5 rounded-xl bg-white text-slate-700 border border-slate-200 hover:bg-emerald-50 hover:text-emerald-800 hover:border-emerald-300 transition flex items-center gap-1.5';
    } else {
      btn5km.className = 'text-xs font-bold px-3 py-1.5 rounded-xl bg-emerald-600 text-white shadow-sm transition flex items-center gap-1.5';
      btnAll.className = 'text-xs font-bold px-3 py-1.5 rounded-xl bg-white text-slate-700 border border-slate-200 hover:bg-slate-50 transition';
    }
  }
  renderProviderJobs(state.providerJobs || []);
}

// Robust Device Location Resolver (Browser GPS -> IP Geolocation Fallback -> User Profile Location)
async function getDeviceLiveLocation() {
  // 1. Try real GPS via navigator.geolocation first
  if (navigator.geolocation) {
    try {
      const position = await new Promise((resolve, reject) => {
        navigator.geolocation.getCurrentPosition(resolve, reject, {
          enableHighAccuracy: true,
          timeout: 6000,
          maximumAge: 60000
        });
      });
      if (position && position.coords && position.coords.latitude) {
        const lat = position.coords.latitude;
        const lng = position.coords.longitude;
        return {
          latitude: lat,
          longitude: lng,
          source: 'GPS',
          label: `${lat.toFixed(4)}° N, ${lng.toFixed(4)}° E`
        };
      }
    } catch (e) {
      // Insecure context (HTTP on local IP) or user permission block
    }
  }

  // 2. If GPS unavailable/blocked, fetch exact device city & coordinates via public IP geolocation
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 3500);
    const res = await fetch('https://ipapi.co/json/', { signal: controller.signal });
    clearTimeout(timeoutId);
    if (res.ok) {
      const data = await res.json();
      if (data && data.latitude && data.longitude) {
        const cityLabel = [data.city, data.region, data.country_name].filter(Boolean).join(', ');
        return {
          latitude: Number(data.latitude),
          longitude: Number(data.longitude),
          source: 'Network',
          city: data.city || '',
          label: cityLabel || `${data.latitude.toFixed(4)}° N, ${data.longitude.toFixed(4)}° E`
        };
      }
    }
  } catch (e) {}

  // 3. Alternative IP Geolocation fallback
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 3500);
    const res = await fetch('https://freeipapi.com/api/json', { signal: controller.signal });
    clearTimeout(timeoutId);
    if (res.ok) {
      const data = await res.json();
      if (data && data.latitude && data.longitude) {
        const cityLabel = [data.cityName, data.regionName, data.countryName].filter(Boolean).join(', ');
        return {
          latitude: Number(data.latitude),
          longitude: Number(data.longitude),
          source: 'Network',
          city: data.cityName || '',
          label: cityLabel || `${data.latitude.toFixed(4)}° N, ${data.longitude.toFixed(4)}° E`
        };
      }
    }
  } catch (e) {}

  // 4. Fallback to registered provider profile location
  const regDistrict = state.currentProvider?.district || state.currentUser?.district || state.currentUser?.address || '';
  return {
    latitude: state.currentProvider?.latitude || null,
    longitude: state.currentProvider?.longitude || null,
    source: 'Profile',
    label: regDistrict || 'Location registered'
  };
}

let isDetectingProviderLoc = false;
async function autoDetectProviderLiveLocation(forceToast = false) {
  if (isDetectingProviderLoc) return;
  isDetectingProviderLoc = true;

  if (forceToast) {
    showToast('Acquiring your device location...', 'info');
  }

  try {
    const loc = await getDeviceLiveLocation();
    if (!state.currentProvider) state.currentProvider = {};

    if (loc.latitude && loc.longitude) {
      state.currentProvider.latitude = loc.latitude;
      state.currentProvider.longitude = loc.longitude;
    }

    const displayLabel = loc.city ? `${loc.label} (${loc.latitude.toFixed(4)}°, ${loc.longitude.toFixed(4)}°)` : loc.label;
    updateProviderLiveGpsUI(loc.latitude, loc.longitude, displayLabel, loc.source);

    // Update backend database with provider's live coordinates
    if (loc.latitude && loc.longitude) {
      try {
        await api('/providers/profile', {
          method: 'PUT',
          body: JSON.stringify({
            latitude: loc.latitude,
            longitude: loc.longitude,
            ...(loc.city ? { district: loc.label } : {})
          })
        });
      } catch (e) {
        console.warn('Background live location sync warn:', e);
      }

      // Recalculate job distances dynamically in client state
      if (state.providerJobs && state.providerJobs.length > 0) {
        state.providerJobs.forEach(job => {
          if (job.latitude && job.longitude) {
            job.distance_km = calculateDistanceKm(loc.latitude, loc.longitude, job.latitude, job.longitude);
            job.within_radius = (job.distance_km !== null && job.distance_km <= 5.0);
          } else {
            job.distance_km = 0.0;
            job.within_radius = true;
          }
        });
        renderProviderJobs(state.providerJobs);
      }
    }

    if (forceToast) {
      showToast(`📍 Location updated: ${displayLabel}`, 'success');
    }
  } catch (err) {
    console.warn('Location detection failed:', err);
    if (forceToast) {
      showToast('Could not acquire location. Please verify device permissions.', 'warning');
    }
  } finally {
    isDetectingProviderLoc = false;
  }
}

function updateProviderLiveGpsUI(lat, lng, label, source = 'Live') {
  const textEl = document.getElementById('provider-live-location-text');
  if (textEl) {
    textEl.textContent = label;
  }
  const pillEl = document.getElementById('provider-live-status-pill');
  if (pillEl) {
    if (lat && lng) {
      pillEl.textContent = `${source}: ${Number(lat).toFixed(2)}°, ${Number(lng).toFixed(2)}° • 5km Radius`;
    } else {
      pillEl.textContent = label ? `Location: ${label}` : 'Location Active';
    }
  }
}

async function loadProviderDashboard() {
  if (!state.currentUser) {
    showToast('Please sign in as a service provider', 'warning');
    openAuthModal('login');
    return;
  }

  const pendingWarning = document.getElementById('provider-pending-warning');
  if (state.currentProvider && state.currentProvider.verification_status === 'pending') {
    pendingWarning?.classList.remove('hidden');
  } else {
    pendingWarning?.classList.add('hidden');
  }

  // Quietly resolve live location in background (no annoying popups)
  autoDetectProviderLiveLocation(false);

  try {
    const data = await api('/requests');
    state.providerJobs = data.requests || [];
    renderProviderJobs(state.providerJobs);

    const pendingCount = state.providerJobs.filter(r => r.status === 'Pending').length;
    const activeCount = state.providerJobs.filter(r => r.status === 'Accepted' || r.status === 'In Progress').length;
    const completedCount = state.providerJobs.filter(r => r.status === 'Completed').length;

    document.getElementById('provider-stat-pending').textContent = pendingCount;
    document.getElementById('provider-stat-active').textContent = activeCount;
    document.getElementById('provider-stat-completed').textContent = completedCount;
    
    if (state.currentProvider) {
      document.getElementById('provider-stat-rating').innerHTML = `
        <span>${Number(state.currentProvider.rating || 5.0).toFixed(1)}</span> <i class="fa-solid fa-star text-base"></i>
      `;
    }
  } catch (err) {
    showToast('Failed to load provider jobs: ' + err.message, 'error');
  }
}

function renderProviderJobs(jobs) {
  const container = document.getElementById('provider-jobs-container');
  if (!container) return;

  const totalCount = (jobs || []).length;
  const radiusCount = (jobs || []).filter(j => j.within_radius || (j.distance_km !== null && j.distance_km <= 5.0)).length;

  const countAllEl = document.getElementById('count-all-jobs');
  if (countAllEl) countAllEl.textContent = totalCount;
  const countRadiusEl = document.getElementById('count-radius-jobs');
  if (countRadiusEl) countRadiusEl.textContent = radiusCount;

  let filteredJobs = jobs || [];
  if (state.providerJobFilter === '5km') {
    filteredJobs = filteredJobs.filter(j => j.within_radius || (j.distance_km !== null && j.distance_km <= 5.0));
  }

  const jobCountEl = document.getElementById('provider-job-count');
  if (jobCountEl) {
    if (state.providerJobFilter === '5km') {
      jobCountEl.textContent = `Showing ${filteredJobs.length} job(s) within 5km radius`;
    } else {
      jobCountEl.textContent = `Showing all ${totalCount} matched job(s)`;
    }
  }

  if (filteredJobs.length === 0) {
    if (state.providerJobFilter === '5km') {
      container.innerHTML = `
        <div class="py-14 text-center text-slate-500 bg-white rounded-3xl border border-dashed border-slate-200 p-6">
          <div class="w-12 h-12 rounded-full bg-emerald-50 text-emerald-600 flex items-center justify-center mx-auto mb-3 text-xl">
            <i class="fa-solid fa-location-crosshairs"></i>
          </div>
          <div class="font-bold text-sm text-slate-800">No Jobs Found Within 5km Radius</div>
          <p class="text-xs text-slate-400 mt-1 max-w-sm mx-auto">There are currently no repair requests within 5km of your detected GPS. You can view all incoming jobs across the city.</p>
          <button type="button" onclick="setProviderJobFilter('all')" class="mt-4 px-4 py-2 bg-slate-900 text-white rounded-xl text-xs font-bold hover:bg-slate-800 transition shadow">
            Switch to All Matched Jobs (${totalCount})
          </button>
        </div>
      `;
    } else {
      container.innerHTML = `
        <div class="py-16 text-center text-slate-400 bg-white rounded-3xl border border-dashed border-slate-200">
          <i class="fa-solid fa-toolbox text-3xl mb-2 text-slate-300"></i>
          <div class="font-bold text-sm text-slate-700">No Job Requests In Your Area</div>
          <p class="text-xs text-slate-400 mt-1">New complaints from clients matching your trade will show up here.</p>
        </div>
      `;
    }
    return;
  }

  container.innerHTML = filteredJobs.map(job => {
    let photos = [];
    try {
      photos = typeof job.photos === 'string' ? JSON.parse(job.photos) : (job.photos || []);
    } catch(e) {
      photos = [];
    }

    const isPending = job.status === 'Pending';
    const isAccepted = job.status === 'Accepted';
    const isInProgress = job.status === 'In Progress';
    const isCompleted = job.status === 'Completed';

    return `
      <div class="scroll-3d glass-tilt bg-white rounded-3xl p-6 border border-slate-100 shadow-sm hover:shadow-md transition">
        <div class="flex flex-col sm:flex-row sm:items-center justify-between pb-4 border-b border-slate-100 gap-2">
          <div class="flex items-center flex-wrap gap-2.5">
            <span class="text-xs font-black tracking-wider px-2.5 py-1 rounded-lg bg-slate-100 text-slate-700">${job.ticket_number}</span>
            <span class="text-xs font-bold text-brand-700 bg-brand-50 px-2.5 py-1 rounded-lg">${job.category_name}</span>
            <span class="text-xs font-bold px-2.5 py-1 rounded-full badge-${job.status.toLowerCase().replace(' ', '-')}">${job.status}</span>
            ${job.distance_km !== null && job.distance_km !== undefined ? `
              <span class="text-[11px] font-bold px-2.5 py-0.5 rounded-full flex items-center gap-1.5 ${job.within_radius ? 'bg-emerald-100 text-emerald-800 border border-emerald-200' : 'bg-amber-100 text-amber-800 border border-amber-200'}">
                <i class="fa-solid fa-location-dot ${job.within_radius ? 'text-emerald-600' : 'text-amber-600'}"></i>
                <span>${job.distance_km} km away</span>
                <span class="font-normal text-[10px]">(${job.within_radius ? 'Within 5km Alert Radius' : 'Outside radius'})</span>
              </span>
            ` : `
              <span class="text-[11px] font-bold px-2.5 py-0.5 rounded-full bg-slate-100 text-slate-600 flex items-center gap-1">
                <i class="fa-solid fa-location-dot"></i> Local City Job
              </span>
            `}
          </div>
          <div class="text-xs text-slate-500 font-semibold">
            Requested: ${job.preferred_date} (${job.preferred_time})
          </div>
        </div>

        <div class="grid grid-cols-1 md:grid-cols-12 gap-6 my-4">
          <div class="md:col-span-8 space-y-2">
            <h3 class="text-base font-bold text-slate-900">${job.title}</h3>
            <p class="text-xs text-slate-600 leading-relaxed">${job.description}</p>
            
            <div class="grid grid-cols-1 sm:grid-cols-2 gap-2 pt-2 text-xs text-slate-600">
              <div><span class="font-bold text-slate-800">Customer:</span> ${job.customer_name} (${job.customer_phone || 'Phone upon accept'})</div>
              <div><span class="font-bold text-slate-800">Address:</span> ${job.address}</div>
              <div><span class="font-bold text-slate-800">Base Estimate:</span> ₹${job.estimated_cost}</div>
              <div><span class="font-bold text-slate-800">Urgency:</span> <span class="capitalize font-semibold text-rose-600">${job.urgency}</span></div>
            </div>

            ${job.completion_notes ? `
              <div class="mt-2 p-2.5 rounded-xl bg-emerald-50 text-emerald-900 text-xs">
                <span class="font-bold">Completion Notes:</span> ${job.completion_notes} (₹${job.final_cost})
              </div>
            ` : ''}
          </div>

          <div class="md:col-span-4 flex items-center justify-end">
            ${photos.length > 0 ? `
              <img src="${photos[0]}" alt="Issue Photo" class="w-28 h-28 rounded-2xl object-cover border border-slate-200 cursor-pointer hover:scale-105 transition" onclick="window.open('${photos[0]}', '_blank')">
            ` : `
              <div class="w-28 h-28 rounded-2xl bg-slate-50 border border-dashed border-slate-200 flex items-center justify-center text-slate-300 text-xs">
                No Photo
              </div>
            `}
          </div>
        </div>

        <div class="pt-4 border-t border-slate-100 flex items-center justify-end flex-wrap gap-2">
          ${(job.status !== 'Rejected') ? `
            <button onclick="openChatModal(${job.id})" class="bg-brand-600 hover:bg-brand-700 text-white font-bold text-xs px-4 py-2 rounded-xl transition shadow flex items-center gap-1.5" title="Message customer and negotiate offline payment">
              <i class="fa-solid fa-comments"></i> Chat & Negotiate
            </button>
          ` : ''}

          ${job.offline_payment_agreed ? `
            <span class="text-[11px] font-bold px-2.5 py-1 rounded-xl bg-amber-50 text-amber-800 border border-amber-200 flex items-center gap-1">
              <i class="fa-solid fa-handshake"></i> Offline Deal: ₹${job.agreed_price || job.final_cost}
            </span>
          ` : ''}

          ${isPending ? `
            <button onclick="handleProviderAction(${job.id}, 'Rejected')" class="px-4 py-2 rounded-xl border border-rose-200 text-rose-600 hover:bg-rose-50 font-bold text-xs transition">
              Decline Job
            </button>
            <button onclick="handleProviderAction(${job.id}, 'Accepted')" class="bg-brand-600 hover:bg-brand-700 text-white font-bold text-xs px-5 py-2 rounded-xl transition shadow flex items-center gap-1.5">
              <i class="fa-solid fa-check"></i> Accept Job
            </button>
          ` : ''}

          ${isAccepted ? `
            <button onclick="handleProviderAction(${job.id}, 'In Progress')" class="bg-sky-600 hover:bg-sky-700 text-white font-bold text-xs px-5 py-2 rounded-xl transition shadow flex items-center gap-1.5">
              <i class="fa-solid fa-person-walking-arrow-right"></i> Start Work (In Progress)
            </button>
          ` : ''}

          ${isInProgress ? `
            <button onclick="openCompletionModal(${job.id}, ${job.estimated_cost})" class="bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-xs px-5 py-2 rounded-xl transition shadow flex items-center gap-1.5">
              <i class="fa-solid fa-check-double"></i> Complete Repair
            </button>
          ` : ''}

          ${isCompleted ? `
            <div class="text-xs font-semibold text-emerald-600 flex items-center gap-1.5">
              <i class="fa-solid fa-circle-check"></i> Service Completed & Invoiced
            </div>
          ` : ''}
        </div>
      </div>
    `;
  }).join('');

  refresh3DObservers();
  setup3DCardTilt();
}

async function handleProviderAction(requestId, status) {
  let rejectionReason = null;
  if (status === 'Rejected') {
    rejectionReason = prompt('Please specify reason for declining this repair request:');
    if (!rejectionReason) return;
  }

  try {
    await api(`/requests/${requestId}/status`, {
      method: 'PUT',
      body: JSON.stringify({
        status,
        rejection_reason: rejectionReason
      })
    });
    showToast(`Job status updated to: ${status}`, 'success');
    loadProviderDashboard();
  } catch (err) {
    showToast('Failed to update status: ' + err.message, 'error');
  }
}

// ---------------- ADMIN DASHBOARD ----------------
async function loadAdminDashboard() {
  if (!state.currentUser || state.currentUser.role !== 'admin') {
    showToast('Admin privilege required', 'error');
    openAuthModal('login');
    return;
  }

  try {
    const data = await api('/admin/stats');
    const stats = data.stats;

    document.getElementById('admin-stat-total-req').textContent = stats.totalRequests;
    document.getElementById('admin-stat-pending-prov').textContent = stats.pendingProviders;
    document.getElementById('admin-stat-progress').textContent = stats.inProgressRequests;
    document.getElementById('admin-stat-completed').textContent = stats.completedRequests;
    document.getElementById('admin-stat-users').textContent = stats.totalUsers;
    document.getElementById('admin-stat-revenue').textContent = `₹${stats.totalRevenue}`;
    document.getElementById('admin-pending-badge').textContent = stats.pendingProviders;

    renderAdminCharts(data.categoryStats, stats);
    switchAdminTab(state.adminTab);
  } catch (err) {
    showToast('Failed to load admin stats: ' + err.message, 'error');
  }
}

function renderAdminCharts(categoryStats, stats) {
  const catCanvas = document.getElementById('categoryChart');
  if (catCanvas) {
    if (state.charts.categoryChart) {
      state.charts.categoryChart.destroy();
    }
    const labels = (categoryStats || []).map(c => c.name);
    const dataVals = (categoryStats || []).map(c => c.request_count);

    state.charts.categoryChart = new Chart(catCanvas, {
      type: 'bar',
      data: {
        labels: labels,
        datasets: [{
          label: 'Requests',
          data: dataVals,
          backgroundColor: '#0d9488',
          borderRadius: 8
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false }
        },
        scales: {
          y: { beginAtZero: true, ticks: { precision: 0 } }
        }
      }
    });
  }

  const statusCanvas = document.getElementById('statusChart');
  if (statusCanvas) {
    if (state.charts.statusChart) {
      state.charts.statusChart.destroy();
    }
    state.charts.statusChart = new Chart(statusCanvas, {
      type: 'doughnut',
      data: {
        labels: ['Pending', 'In Progress', 'Completed', 'Rejected'],
        datasets: [{
          data: [
            stats.pendingRequests || 0,
            stats.inProgressRequests || 0,
            stats.completedRequests || 0,
            stats.rejectedRequests || 0
          ],
          backgroundColor: ['#f59e0b', '#0284c7', '#10b981', '#f43f5e']
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { position: 'bottom', labels: { boxWidth: 12, font: { size: 10 } } }
        }
      }
    });
  }
}

function switchAdminTab(tabName) {
  state.adminTab = tabName;

  document.querySelectorAll('.admin-tab-btn').forEach(btn => {
    btn.classList.remove('text-brand-600', 'border-b-2', 'border-brand-600');
    btn.classList.add('text-slate-500');
  });

  const activeBtn = document.getElementById(`tab-btn-${tabName}`);
  if (activeBtn) {
    activeBtn.classList.add('text-brand-600', 'border-b-2', 'border-brand-600');
    activeBtn.classList.remove('text-slate-500');
  }

  document.querySelectorAll('.admin-tab-content').forEach(c => c.classList.add('hidden'));
  const activeContent = document.getElementById(`admin-tab-${tabName}`);
  if (activeContent) activeContent.classList.remove('hidden');

  if (tabName === 'providers') loadAdminProviders();
  else if (tabName === 'requests') loadAdminRequests();
  else if (tabName === 'users') loadAdminUsers();
  else if (tabName === 'reviews') loadAdminReviews();
}

async function loadAdminProviders() {
  try {
    const data = await api('/providers?status=all');
    const tableBody = document.getElementById('admin-providers-table');
    if (!tableBody) return;

    tableBody.innerHTML = (data.providers || []).map(p => `
      <tr class="hover:bg-slate-50/60 transition">
        <td class="py-3 px-4 flex items-center gap-2.5">
          <img src="${p.avatar || 'https://api.dicebear.com/7.x/avataaars/svg?seed=' + p.name}" class="w-8 h-8 rounded-full object-cover">
          <div>
            <div class="font-bold text-slate-900">${p.name}</div>
            <div class="text-[10px] text-slate-400">${p.email}</div>
          </div>
        </td>
        <td class="py-3 px-4 font-semibold text-slate-700">${p.category_name || 'N/A'}</td>
        <td class="py-3 px-4 font-semibold text-slate-900">₹${p.hourly_rate}/hr • ${p.experience_years} yrs</td>
        <td class="py-3 px-4 text-amber-500 font-bold"><i class="fa-solid fa-star text-[10px]"></i> ${p.rating} (${p.reviews_count || 0})</td>
        <td class="py-3 px-4">
          <span class="px-2 py-0.5 rounded-full text-[10px] font-bold ${
            p.verification_status === 'approved' ? 'bg-emerald-100 text-emerald-800' :
            p.verification_status === 'pending' ? 'bg-amber-100 text-amber-800' : 'bg-rose-100 text-rose-800'
          }">
            ${p.verification_status}
          </span>
        </td>
        <td class="py-3 px-4 text-right space-x-1">
          ${p.verification_status === 'pending' ? `
            <button onclick="adminVerifyProvider(${p.id}, 'approved')" class="px-2.5 py-1 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-[10px] shadow">Approve</button>
            <button onclick="adminVerifyProvider(${p.id}, 'rejected')" class="px-2.5 py-1 rounded-lg bg-rose-600 hover:bg-rose-700 text-white font-bold text-[10px] shadow">Reject</button>
          ` : `
            <button onclick="adminVerifyProvider(${p.id}, '${p.verification_status === 'approved' ? 'rejected' : 'approved'}')" class="px-2 py-1 rounded text-[10px] border border-slate-200 text-slate-600 hover:bg-slate-100 font-medium">
              ${p.verification_status === 'approved' ? 'Revoke' : 'Re-approve'}
            </button>
          `}
        </td>
      </tr>
    `).join('');
  } catch(e){}
}

async function adminVerifyProvider(providerId, status) {
  try {
    await api(`/providers/${providerId}/verify`, {
      method: 'PUT',
      body: JSON.stringify({ status })
    });
    showToast(`Provider status marked as: ${status}`, 'success');
    loadAdminDashboard();
  } catch (err) {
    showToast('Failed to update provider: ' + err.message, 'error');
  }
}

async function loadAdminRequests() {
  try {
    const data = await api('/requests');
    const tableBody = document.getElementById('admin-requests-table');
    if (!tableBody) return;

    tableBody.innerHTML = (data.requests || []).map(r => `
      <tr class="hover:bg-slate-50/60 transition">
        <td class="py-3 px-4 font-bold text-slate-900">${r.ticket_number}</td>
        <td class="py-3 px-4 font-medium text-slate-800 max-w-xs truncate">${r.title}</td>
        <td class="py-3 px-4 text-brand-700 font-semibold">${r.category_name}</td>
        <td class="py-3 px-4 text-slate-700">${r.customer_name}</td>
        <td class="py-3 px-4 text-slate-700 font-medium">${r.provider_name || '<span class="text-slate-400">Unassigned</span>'}</td>
        <td class="py-3 px-4">
          <span class="px-2 py-0.5 rounded-full text-[10px] font-bold badge-${r.status.toLowerCase().replace(' ', '-')}">
            ${r.status}
          </span>
        </td>
        <td class="py-3 px-4 text-slate-400">${new Date(r.created_at || Date.now()).toLocaleDateString()}</td>
      </tr>
    `).join('');
  } catch(e){}
}

async function loadAdminUsers() {
  try {
    const data = await api('/admin/users');
    const tableBody = document.getElementById('admin-users-table');
    if (!tableBody) return;

    tableBody.innerHTML = (data.users || []).map(u => `
      <tr class="hover:bg-slate-50/60 transition">
        <td class="py-3 px-4 font-bold text-slate-900">
          <div>${u.name}</div>
          <div class="text-[10px] text-slate-400 font-normal">${u.email}</div>
        </td>
        <td class="py-3 px-4 capitalize font-semibold ${u.role === 'admin' ? 'text-rose-600' : (u.role === 'provider' ? 'text-teal-600' : 'text-slate-700')}">${u.role}</td>
        <td class="py-3 px-4 text-slate-600">${u.phone || 'N/A'}</td>
        <td class="py-3 px-4 font-bold text-slate-900">${u.orders_count || 0}</td>
        <td class="py-3 px-4">
          <span class="px-2 py-0.5 rounded-full text-[10px] font-bold ${u.status === 'active' ? 'bg-emerald-100 text-emerald-800' : 'bg-rose-100 text-rose-800'}">
            ${u.status}
          </span>
        </td>
        <td class="py-3 px-4 text-right whitespace-nowrap">
          ${u.role !== 'admin' ? `
            <button onclick="toggleUserStatus(${u.id}, '${u.status === 'active' ? 'suspended' : 'active'}')" class="px-2.5 py-1 rounded text-[10px] border font-medium ${u.status === 'active' ? 'border-amber-200 text-amber-700 hover:bg-amber-50' : 'border-emerald-200 text-emerald-600 hover:bg-emerald-50'}">
              ${u.status === 'active' ? 'Suspend' : 'Activate'}
            </button>
            <button onclick="adminDeleteUser(${u.id}, '${escapeHtml(u.name)}')" class="px-2.5 py-1 rounded text-[10px] bg-rose-50 text-rose-700 border border-rose-200 hover:bg-rose-100 font-bold ml-1.5 shadow-sm" title="Permanently delete user (Admin Only)">
              <i class="fa-solid fa-trash-can mr-0.5"></i> Delete
            </button>
          ` : '<span class="text-slate-400 text-[10px]">Superuser</span>'}
        </td>
      </tr>
    `).join('');
  } catch(e){}
}

async function adminDeleteUser(userId, userName) {
  if (!state.currentUser || state.currentUser.role !== 'admin') {
    showToast('Admin privileges required to delete accounts', 'error');
    return;
  }

  if (userId === 1) {
    showToast('Cannot delete the Super Admin account', 'warning');
    return;
  }

  if (!confirm(`ADMIN ACTION: Are you sure you want to permanently delete user "${userName}" (#${userId})?\n\nThis will remove their account and all associated records from fixit.db.`)) {
    return;
  }

  try {
    const res = await api(`/admin/users/${userId}`, { method: 'DELETE' });
    showToast(res.message || `User #${userId} removed successfully`, 'success');
    loadAdminUsers();
  } catch (err) {
    showToast('Failed to delete user: ' + err.message, 'error');
  }
}

async function toggleUserStatus(userId, status) {
  try {
    await api(`/admin/users/${userId}/status`, {
      method: 'PUT',
      body: JSON.stringify({ status })
    });
    showToast(`User status updated to ${status}`, 'success');
    loadAdminUsers();
  } catch (err) {
    showToast('Failed to update user status: ' + err.message, 'error');
  }
}

async function loadAdminReviews() {
  try {
    const data = await api('/reviews');
    const container = document.getElementById('admin-reviews-list');
    if (!container) return;

    container.innerHTML = (data.reviews || []).map(r => `
      <div class="p-4 rounded-2xl bg-slate-50 border border-slate-100 flex items-start justify-between gap-4">
        <div class="space-y-1">
          <div class="flex items-center gap-2">
            <span class="font-bold text-slate-900">${r.customer_name}</span>
            <span class="text-slate-400">• for</span>
            <span class="font-bold text-teal-700">${r.provider_name}</span>
            <span class="text-slate-400">(${r.ticket_number})</span>
          </div>
          <div class="flex items-center text-amber-500 text-xs">
            ${Array.from({ length: r.rating }).map(() => '<i class="fa-solid fa-star"></i>').join('')}
            <span class="text-slate-500 font-semibold ml-2 text-[11px]">${r.category_name} Service</span>
          </div>
          <p class="text-xs text-slate-600 italic mt-1">"${r.comment || 'No comment provided.'}"</p>
        </div>
        <div class="text-[10px] text-slate-400">${new Date(r.created_at || Date.now()).toLocaleDateString()}</div>
      </div>
    `).join('');
  } catch(e){}
}

// ---------------- BOOKING & SERVICE REQUEST MODAL ----------------
function openBookingModal(categoryId = null, providerId = null, providerName = '') {
  if (!state.currentUser) {
    showToast('Please sign in to report a problem or book a service', 'info');
    openAuthModal('login');
    return;
  }

  // A provider in Provider Mode cannot make requests until switching to Customer Mode
  if (state.currentUser.role === 'provider' && state.userMode !== 'customer') {
    showToast('You are currently in Provider Mode. Please switch to Customer Mode (top bar) to book or request a repair.', 'warning');
    return;
  }

  const modal = document.getElementById('booking-modal');
  modal.classList.remove('hidden');

  if (categoryId) {
    document.getElementById('booking-category').value = categoryId;
  }

  const directBanner = document.getElementById('booking-direct-pro-banner');
  const directName = document.getElementById('booking-direct-pro-name');
  const gpsContainer = document.getElementById('booking-gps-container');

  if (providerId) {
    document.getElementById('booking-provider-id').value = providerId;
    if (directBanner) directBanner.classList.remove('hidden');
    if (directName) directName.textContent = providerName || 'Assigned Technician';
    if (gpsContainer) gpsContainer.classList.add('hidden');
  } else {
    document.getElementById('booking-provider-id').value = '';
    if (directBanner) directBanner.classList.add('hidden');
    if (gpsContainer) gpsContainer.classList.remove('hidden');
  }

  if (state.currentUser.address) {
    document.getElementById('booking-address').value = state.currentUser.address;
  }

  // Pre-populate coordinates from profile or resolve in background
  const latInput = document.getElementById('booking-lat');
  const lngInput = document.getElementById('booking-lng');
  const badge = document.getElementById('booking-location-badge');
  const badgeText = document.getElementById('booking-location-text');

  if (latInput && lngInput) {
    const knownLat = state.currentProvider?.latitude || state.currentUser?.latitude;
    const knownLng = state.currentProvider?.longitude || state.currentUser?.longitude;
    if (knownLat && knownLng) {
      latInput.value = knownLat;
      lngInput.value = knownLng;
      if (badge && badgeText) {
        badgeText.textContent = `Location active (${Number(knownLat).toFixed(4)}, ${Number(knownLng).toFixed(4)}) • 5km Pro Alert`;
        badge.classList.remove('hidden');
      }
    } else {
      // Quietly resolve location without any blocking toasts
      getDeviceLiveLocation().then(loc => {
        if (loc.latitude && loc.longitude && !latInput.value) {
          latInput.value = loc.latitude;
          lngInput.value = loc.longitude;
          if (badge && badgeText) {
            badgeText.textContent = `Location active: ${loc.label} • 5km Pro Alert`;
            badge.classList.remove('hidden');
          }
        }
      }).catch(() => {});
    }
  }
}

function openBookingModalWithCategory(catId) {
  openBookingModal(catId, null, '');
}

function bookSpecificProvider(providerId, categoryId, providerName) {
  openBookingModal(categoryId, providerId, providerName);
  showToast(`Direct booking with: ${providerName}`, 'info');
}

function closeBookingModal() {
  document.getElementById('booking-modal').classList.add('hidden');
  document.getElementById('booking-form').reset();
  removePhotoPreview();
}

function handlePhotoUpload(e) {
  const file = e.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = (event) => {
    state.uploadedPhotoBase64 = event.target.result;
    const previewContainer = document.getElementById('photo-preview-container');
    const previewImg = document.getElementById('photo-preview-img');
    previewImg.src = state.uploadedPhotoBase64;
    previewContainer.classList.remove('hidden');
  };
  reader.readAsDataURL(file);
}

// Geolocation Detection Helpers
async function detectCustomerLocation() {
  showToast('Acquiring device location...', 'info');
  try {
    const loc = await getDeviceLiveLocation();
    const latInput = document.getElementById('booking-lat');
    const lngInput = document.getElementById('booking-lng');
    const badge = document.getElementById('booking-location-badge');
    const text = document.getElementById('booking-location-text');
    const addrInput = document.getElementById('booking-address');

    if (loc.latitude && loc.longitude) {
      if (latInput) latInput.value = loc.latitude;
      if (lngInput) lngInput.value = loc.longitude;
      if (badge && text) {
        text.textContent = `Location active: ${loc.label} • Alerts pros within 5km`;
        badge.classList.remove('hidden');
      }
      if (addrInput && !addrInput.value.trim()) {
        addrInput.value = loc.city ? loc.label : `Live Location (${loc.latitude.toFixed(4)}, ${loc.longitude.toFixed(4)})`;
      }
      showToast(`📍 Location acquired: ${loc.label}`, 'success');
    } else {
      const userLoc = state.currentUser?.district || state.currentUser?.address || '';
      if (badge && text) {
        text.textContent = userLoc ? `Service Area: ${userLoc}` : 'Location registered';
        badge.classList.remove('hidden');
      }
      if (addrInput && !addrInput.value.trim() && userLoc) {
        addrInput.value = userLoc;
      }
      showToast('Location acquired from your profile.', 'info');
    }
  } catch (err) {
    showToast('Could not acquire location. Please type your service address.', 'warning');
  }
}

async function detectProviderLocation() {
  showToast('Acquiring device location...', 'info');
  try {
    const loc = await getDeviceLiveLocation();
    if (loc.latitude && loc.longitude) {
      if (state.currentProvider) {
        state.currentProvider.latitude = loc.latitude;
        state.currentProvider.longitude = loc.longitude;
      }
      const coordsInput = document.getElementById('profile-coords');
      if (coordsInput) {
        coordsInput.value = `${loc.latitude.toFixed(4)}, ${loc.longitude.toFixed(4)}`;
      }
      const distInput = document.getElementById('profile-district');
      if (distInput && loc.city && !distInput.value.trim()) {
        distInput.value = loc.label;
      }
      showToast(`Base location updated: ${loc.label}`, 'success');
    } else {
      showToast('Could not detect GPS. You can enter your district/city manually.', 'info');
    }
  } catch (err) {
    showToast('Could not detect location. Please enter manually.', 'warning');
  }
}

function removePhotoPreview() {
  state.uploadedPhotoBase64 = null;
  const previewContainer = document.getElementById('photo-preview-container');
  if (previewContainer) previewContainer.classList.add('hidden');
  const fileInput = document.getElementById('booking-photo-input');
  if (fileInput) fileInput.value = '';
}

async function handleBookingSubmit(e) {
  e.preventDefault();

  if (state.currentUser?.role === 'provider' && state.userMode !== 'customer') {
    showToast('You are currently in Provider Mode. Please switch to Customer Mode to submit a service request.', 'warning');
    return;
  }

  const title = document.getElementById('booking-title').value.trim();
  const description = document.getElementById('booking-desc').value.trim();
  const category_id = Number(document.getElementById('booking-category').value);
  const preferred_date = document.getElementById('booking-date').value;
  const preferred_time = document.getElementById('booking-time').value;
  const address = document.getElementById('booking-address').value.trim();
  const latVal = document.getElementById('booking-lat')?.value;
  const lngVal = document.getElementById('booking-lng')?.value;
  const latitude = latVal ? Number(latVal) : null;
  const longitude = lngVal ? Number(lngVal) : null;
  const urgency = document.getElementById('booking-urgency').value;
  const provider_id = document.getElementById('booking-provider-id').value || null;

  const photos = state.uploadedPhotoBase64 ? [state.uploadedPhotoBase64] : [];

  try {
    const data = await api('/requests', {
      method: 'POST',
      body: JSON.stringify({
        title,
        description,
        category_id,
        photos,
        preferred_date,
        preferred_time,
        address,
        latitude,
        longitude,
        urgency,
        provider_id
      })
    });

    closeBookingModal();
    showToast(`Request created successfully! Ticket: ${data.request.ticket_number}`, 'success');
    navigate('customer-requests');
  } catch (err) {
    showToast('Failed to submit request: ' + err.message, 'error');
  }
}

// ---------------- COMPLETION NOTES MODAL (PROVIDER) ----------------
function openCompletionModal(requestId, estimatedCost) {
  document.getElementById('completion-request-id').value = requestId;
  document.getElementById('completion-cost').value = estimatedCost || 50;
  document.getElementById('completion-notes').value = '';
  document.getElementById('completion-modal').classList.remove('hidden');
}

function closeCompletionModal() {
  document.getElementById('completion-modal').classList.add('hidden');
}

async function handleCompletionSubmit(e) {
  e.preventDefault();
  const requestId = Number(document.getElementById('completion-request-id').value);
  const notes = document.getElementById('completion-notes').value.trim();
  const cost = Number(document.getElementById('completion-cost').value);

  try {
    await api(`/requests/${requestId}/status`, {
      method: 'PUT',
      body: JSON.stringify({
        status: 'Completed',
        completion_notes: notes,
        final_cost: cost
      })
    });

    closeCompletionModal();
    showToast('Repair marked as COMPLETED and invoiced to customer!', 'success');
    loadProviderDashboard();
  } catch (err) {
    showToast('Failed to complete job: ' + err.message, 'error');
  }
}

// ---------------- RATINGS & REVIEWS MODAL (CUSTOMER) ----------------
function openReviewModal(requestId) {
  document.getElementById('review-request-id').value = requestId;
  selectStar(5);
  document.getElementById('review-comment').value = '';
  document.getElementById('review-modal').classList.remove('hidden');
}

function closeReviewModal() {
  document.getElementById('review-modal').classList.add('hidden');
}

function selectStar(rating) {
  document.getElementById('review-rating-val').value = rating;
  const stars = document.querySelectorAll('.star-btn');
  const labels = {
    1: 'Poor (1 Star)',
    2: 'Fair (2 Stars)',
    3: 'Good (3 Stars)',
    4: 'Very Good (4 Stars)',
    5: 'Excellent (5 Stars)'
  };
  document.getElementById('star-rating-label').textContent = labels[rating] || '';

  stars.forEach(s => {
    const val = Number(s.dataset.val);
    if (val <= rating) {
      s.classList.add('text-amber-400');
      s.classList.remove('text-slate-300');
    } else {
      s.classList.remove('text-amber-400');
      s.classList.add('text-slate-300');
    }
  });
}

async function handleReviewSubmit(e) {
  e.preventDefault();
  const requestId = Number(document.getElementById('review-request-id').value);
  const rating = Number(document.getElementById('review-rating-val').value);
  const comment = document.getElementById('review-comment').value.trim();

  try {
    await api(`/requests/${requestId}/rate`, {
      method: 'POST',
      body: JSON.stringify({ rating, comment })
    });
    closeReviewModal();
    showToast('Thank you! Your rating and feedback were submitted.', 'success');
    loadCustomerRequests();
  } catch (err) {
    showToast('Failed to submit review: ' + err.message, 'error');
  }
}

// ---------------- PROVIDER PROFILE MODAL ----------------
function openProviderProfileModal() {
  if (!state.currentProvider) {
    showToast('Provider profile not found', 'warning');
    return;
  }
  document.getElementById('profile-rate').value = state.currentProvider.hourly_rate || 499;
  document.getElementById('profile-exp').value = state.currentProvider.experience_years || 3;
  document.getElementById('profile-bio').value = state.currentProvider.bio || '';
  document.getElementById('profile-phone').value = state.currentUser ? (state.currentUser.phone || '') : '';
  document.getElementById('profile-available').value = state.currentProvider.is_available ? '1' : '0';
  
  const distInput = document.getElementById('profile-district');
  if (distInput) {
    distInput.value = state.currentProvider.district || '';
  }

  let skills = [];
  try {
    skills = typeof state.currentProvider.skills === 'string' ? JSON.parse(state.currentProvider.skills) : (state.currentProvider.skills || []);
  } catch(e) {
    skills = [];
  }
  document.getElementById('profile-skills').value = Array.isArray(skills) ? skills.join(', ') : '';

  const radiusInput = document.getElementById('profile-radius');
  if (radiusInput) {
    radiusInput.value = state.currentProvider.service_radius_km || 5;
  }
  const coordsInput = document.getElementById('profile-coords');
  if (coordsInput) {
    const lat = state.currentProvider.latitude;
    const lng = state.currentProvider.longitude;
    coordsInput.value = (lat && lng) ? `${Number(lat).toFixed(4)}, ${Number(lng).toFixed(4)}` : '';
  }

  document.getElementById('provider-profile-modal').classList.remove('hidden');
}

function closeProviderProfileModal() {
  document.getElementById('provider-profile-modal').classList.add('hidden');
}

async function handleProviderProfileSubmit(e) {
  e.preventDefault();
  const hourly_rate = Number(document.getElementById('profile-rate').value);
  const experience_years = Number(document.getElementById('profile-exp').value);
  const bio = document.getElementById('profile-bio').value.trim();
  const phone = document.getElementById('profile-phone').value.trim();
  const district = document.getElementById('profile-district')?.value.trim() || state.currentProvider?.district || '';
  const is_available = document.getElementById('profile-available').value === '1';
  const service_radius_km = Number(document.getElementById('profile-radius')?.value) || 5.0;
  const skills = document.getElementById('profile-skills').value.split(',').map(s=>s.trim()).filter(Boolean);

  try {
    const data = await api('/providers/profile', {
      method: 'PUT',
      body: JSON.stringify({
        hourly_rate,
        experience_years,
        bio,
        phone,
        district,
        state: district.includes(',') ? district.split(',').pop().trim() : (state.currentProvider?.state || 'Maharashtra'),
        is_available,
        service_radius_km,
        latitude: state.currentProvider?.latitude || null,
        longitude: state.currentProvider?.longitude || null,
        skills
      })
    });
    if (data.provider) state.currentProvider = data.provider;
    closeProviderProfileModal();
    showToast('Profile and rates updated successfully!', 'success');
  } catch (err) {
    showToast('Failed to update profile: ' + err.message, 'error');
  }
}

// ---------------- ADMIN CATEGORY MODAL ----------------
function openAddCategoryModal() {
  document.getElementById('admin-category-modal').classList.remove('hidden');
}

function closeAddCategoryModal() {
  document.getElementById('admin-category-modal').classList.add('hidden');
  document.getElementById('admin-category-form').reset();
}

async function handleAddCategorySubmit(e) {
  e.preventDefault();
  const name = document.getElementById('cat-name').value.trim();
  const icon = document.getElementById('cat-icon').value.trim() || 'fa-tools';
  const base_price = Number(document.getElementById('cat-price').value);
  const description = document.getElementById('cat-desc').value.trim();

  try {
    await api('/categories', {
      method: 'POST',
      body: JSON.stringify({ name, icon, base_price, description })
    });
    closeAddCategoryModal();
    showToast(`Category "${name}" created!`, 'success');
    await loadCategories();
    loadAdminDashboard();
  } catch (err) {
    showToast('Failed to create category: ' + err.message, 'error');
  }
}

// ---------------- NOTIFICATIONS ----------------
async function loadNotifications(silent = false) {
  if (!state.currentUser) return;
  try {
    const data = await api('/notifications');
    state.notifications = data.notifications || [];
    state.unreadNotifications = data.unreadCount || 0;

    const badge = document.getElementById('unread-count-badge');
    if (badge) {
      if (state.unreadNotifications > 0) {
        badge.textContent = state.unreadNotifications;
        badge.classList.remove('hidden');
      } else {
        badge.classList.add('hidden');
      }
    }

    const list = document.getElementById('notification-list');
    if (list) {
      if (state.notifications.length === 0) {
        list.innerHTML = `<div class="p-4 text-center text-slate-400">No notifications</div>`;
      } else {
        list.innerHTML = state.notifications.map(n => `
          <div class="p-3 hover:bg-slate-50 transition flex items-start gap-2.5 ${n.is_read ? 'opacity-70' : 'bg-teal-50/40'}">
            <div class="mt-0.5 text-brand-600"><i class="fa-solid fa-bell text-xs"></i></div>
            <div class="flex-1">
              <div class="font-bold text-slate-900">${n.title}</div>
              <div class="text-slate-600 mt-0.5 leading-snug">${n.message}</div>
              <div class="text-[9px] text-slate-400 mt-1">${new Date(n.created_at || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</div>
            </div>
          </div>
        `).join('');
      }
    }
  } catch(e){}
}

function toggleNotificationDropdown() {
  const dropdown = document.getElementById('notification-dropdown');
  dropdown.classList.toggle('hidden');
  if (!dropdown.classList.contains('hidden') && state.unreadNotifications > 0) {
    markAllNotificationsRead();
  }
}

window.addEventListener('click', (e) => {
  const wrapper = document.getElementById('notification-wrapper');
  const dropdown = document.getElementById('notification-dropdown');
  if (wrapper && dropdown && !wrapper.contains(e.target)) {
    dropdown.classList.add('hidden');
  }
});

async function markAllNotificationsRead() {
  try {
    await api('/notifications/read', { method: 'POST' });
    state.unreadNotifications = 0;
    const badge = document.getElementById('unread-count-badge');
    if (badge) badge.classList.add('hidden');
    loadNotifications(true);
  } catch(e){}
}

function clearAuthForms() {
  const formLogin = document.getElementById('form-login');
  if (formLogin) {
    try { formLogin.reset(); } catch(e){}
  }
  const formReg = document.getElementById('form-register');
  if (formReg) {
    try { formReg.reset(); } catch(e){}
  }
  const loginEmail = document.getElementById('login-email');
  if (loginEmail) {
    loginEmail.value = '';
    loginEmail.defaultValue = '';
  }
  const loginPass = document.getElementById('login-password');
  if (loginPass) {
    loginPass.value = '';
    loginPass.defaultValue = '';
  }
}

// ---------------- AUTH MODAL (LOGIN & REGISTER) ----------------
function openAuthModal(tab = 'login') {
  clearAuthForms();
  setAuthTab(tab);
  document.getElementById('auth-modal').classList.remove('hidden');
}

function closeAuthModal() {
  clearAuthForms();
  document.getElementById('auth-modal').classList.add('hidden');
}

function setAuthTab(tab) {
  const tabLogin = document.getElementById('auth-tab-login');
  const tabReg = document.getElementById('auth-tab-register');
  const formLogin = document.getElementById('form-login');
  const formReg = document.getElementById('form-register');
  const title = document.getElementById('auth-modal-title');

  if (tab === 'login') {
    tabLogin.classList.add('text-brand-600', 'border-b-2', 'border-brand-600');
    tabLogin.classList.remove('text-slate-400');
    tabReg.classList.remove('text-brand-600', 'border-b-2', 'border-brand-600');
    tabReg.classList.add('text-slate-400');
    formLogin.classList.remove('hidden');
    formReg.classList.add('hidden');
    title.textContent = 'Sign In to Fixit';
  } else {
    tabReg.classList.add('text-brand-600', 'border-b-2', 'border-brand-600');
    tabReg.classList.remove('text-slate-400');
    tabLogin.classList.remove('text-brand-600', 'border-b-2', 'border-brand-600');
    tabLogin.classList.add('text-slate-400');
    formReg.classList.remove('hidden');
    formLogin.classList.add('hidden');
    title.textContent = 'Create New Account';
  }
}

function toggleRegisterProviderFields(isProvider) {
  const fields = document.getElementById('reg-provider-fields');
  if (isProvider) {
    fields.classList.remove('hidden');
    handleRegCategoryChange(document.getElementById('reg-category')?.value);
  } else {
    fields.classList.add('hidden');
  }
}

function handleRegCategoryChange(selectedVal) {
  const wrapper = document.getElementById('reg-custom-category-wrapper');
  const customInput = document.getElementById('reg-custom-trade');
  if (!wrapper) return;

  const cat = state.categories.find(c => String(c.id) === String(selectedVal));
  const isOthers = cat && (cat.slug === 'others' || cat.name.toLowerCase().includes('other'));

  if (isOthers) {
    wrapper.classList.remove('hidden');
    if (customInput) {
      customInput.required = true;
      customInput.focus();
    }
  } else {
    wrapper.classList.add('hidden');
    if (customInput) {
      customInput.required = false;
      customInput.value = '';
    }
  }
}

async function handleLoginSubmit(e) {
  e.preventDefault();
  const email = document.getElementById('login-email').value.trim();
  const password = document.getElementById('login-password').value;

  try {
    const data = await api('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password })
    });

    state.currentUser = data.user;
    state.currentProvider = data.provider;
    state.token = data.token;
    localStorage.setItem('fixit_token', data.token);
    localStorage.setItem('fixit_current_user', JSON.stringify(data.user));
    if (data.provider) localStorage.setItem('fixit_current_provider', JSON.stringify(data.provider));
    else localStorage.removeItem('fixit_current_provider');

    closeAuthModal();
    updateAuthUI();
    loadNotifications();
    showToast(`Welcome back, ${data.user.name}!`, 'success');

    if (data.user.role === 'customer') navigate('customer-requests');
    else if (data.user.role === 'provider') navigate('provider-dashboard');
    else if (data.user.role === 'admin') navigate('admin-dashboard');
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function handleRegisterSubmit(e) {
  e.preventDefault();
  const role = document.querySelector('input[name="reg-role"]:checked').value;
  const name = document.getElementById('reg-name').value.trim();
  const email = document.getElementById('reg-email').value.trim();
  const password = document.getElementById('reg-password').value;
  const phone = document.getElementById('reg-phone').value.trim();
  const district = document.getElementById('reg-district')?.value.trim();
  if (!district) {
    showToast('Please enter your District / City (e.g. Jalna, Maharashtra)', 'warning');
    return;
  }

  let body = { role, name, email, password, phone, district, address: district };

  if (role === 'provider') {
    const catId = Number(document.getElementById('reg-category').value);
    body.category_id = catId;
    body.hourly_rate = Number(document.getElementById('reg-rate').value);
    body.skills = document.getElementById('reg-skills').value;

    const cat = state.categories.find(c => Number(c.id) === Number(catId));
    const isOthers = cat && (cat.slug === 'others' || cat.name.toLowerCase().includes('other'));
    if (isOthers) {
      const customTrade = document.getElementById('reg-custom-trade')?.value.trim();
      if (!customTrade) {
        showToast('Please enter your primary trade / specialty', 'warning');
        document.getElementById('reg-custom-trade')?.focus();
        return;
      }
      body.custom_trade = customTrade;
    }
  }

  const submitBtn = e.target.querySelector('button[type="submit"]');
  const originalBtnText = submitBtn ? submitBtn.innerHTML : '';
  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin mr-1"></i> Checking email & sending OTP...';
  }

  try {
    const data = await api('/auth/register-request', {
      method: 'POST',
      body: JSON.stringify(body)
    });

    closeAuthModal();
    openOtpVerifyModal(data.email || email);
    showToast(data.message || 'Verification OTP sent to your email!', 'info');
  } catch (err) {
    showToast('Registration failed: ' + err.message, 'error');
  } finally {
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.innerHTML = originalBtnText;
    }
  }
}

// ---------------- CHAT & OFFLINE NEGOTIATION CONTROLLER ----------------
state.activeChatRequestId = null;
state.chatPollInterval = null;

async function openChatModal(requestId) {
  if (!state.currentUser) {
    showToast('Please sign in to access the job chat', 'warning');
    openAuthModal('login');
    return;
  }

  state.activeChatRequestId = requestId;
  const modal = document.getElementById('chat-modal');
  modal.classList.remove('hidden');

  await loadChatMessages(requestId);

  if (state.chatPollInterval) clearInterval(state.chatPollInterval);
  state.chatPollInterval = setInterval(() => {
    if (state.activeChatRequestId === requestId && !modal.classList.contains('hidden')) {
      loadChatMessages(requestId, true);
    }
  }, 2500);

  setTimeout(() => {
    document.getElementById('chat-message-input')?.focus();
  }, 100);
}

function closeChatModal() {
  state.activeChatRequestId = null;
  if (state.chatPollInterval) {
    clearInterval(state.chatPollInterval);
    state.chatPollInterval = null;
  }
  document.getElementById('chat-modal').classList.add('hidden');
}

async function loadChatMessages(requestId, silent = false) {
  try {
    const data = await api(`/requests/${requestId}/messages`);
    const reqInfo = data.request;
    const messages = data.messages || [];

    const isCustomer = state.currentUser.role === 'customer';
    const counterpartName = isCustomer ? (reqInfo.provider_name || 'Assigned Technician') : (reqInfo.customer_name || 'Customer');
    const counterpartAvatar = isCustomer ? (reqInfo.provider_avatar || 'https://api.dicebear.com/7.x/avataaars/svg?seed=Pro') : (reqInfo.customer_avatar || 'https://api.dicebear.com/7.x/avataaars/svg?seed=Client');

    document.getElementById('chat-counterpart-name').textContent = counterpartName;
    document.getElementById('chat-counterpart-avatar').src = counterpartAvatar;
    document.getElementById('chat-job-ticket').textContent = reqInfo.ticket_number;
    document.getElementById('chat-job-title').textContent = reqInfo.title;

    // Update active sender badge in chat footer & header toggle
    const currentUserName = state.currentUser ? state.currentUser.name : 'You';
    const currentUserRole = state.currentUser ? state.currentUser.role : 'customer';
    const senderNameEl = document.getElementById('chat-sender-name');
    const senderRoleEl = document.getElementById('chat-sender-role');
    const toggleRoleText = document.getElementById('chat-toggle-role-text');
    if (senderNameEl) senderNameEl.textContent = currentUserName;
    if (senderRoleEl) {
      senderRoleEl.textContent = currentUserRole;
      senderRoleEl.className = currentUserRole === 'provider' ? 'px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-800 font-bold text-[9px] uppercase' : 'px-1.5 py-0.5 rounded bg-brand-100 text-brand-800 font-bold text-[9px] uppercase';
    }

    const payBadge = document.getElementById('chat-payment-badge');
    const payStatus = document.getElementById('chat-payment-status');
    if (reqInfo.offline_payment_agreed) {
      payStatus.textContent = `Offline Deal: ₹${reqInfo.agreed_price || reqInfo.estimated_cost} (Cash Agreed)`;
      payBadge.classList.remove('hidden');
    } else {
      payStatus.textContent = `Est. Price: ₹${reqInfo.estimated_cost} (Negotiable)`;
      payBadge.classList.remove('hidden');
    }

    if (!document.getElementById('chat-offer-price').value && reqInfo.estimated_cost) {
      document.getElementById('chat-offer-price').placeholder = reqInfo.agreed_price || reqInfo.estimated_cost;
    }

    const container = document.getElementById('chat-messages-container');
    if (!container) return;

    if (messages.length === 0) {
      container.innerHTML = `
        <div class="py-12 text-center text-slate-400">
          <i class="fa-regular fa-comments text-3xl mb-2 text-slate-300"></i>
          <div class="font-bold text-sm text-slate-700">Chat & Negotiate</div>
          <p class="text-xs text-slate-400 mt-1 max-w-sm mx-auto">Discuss repair specifics, propose custom rates, and agree on cash or offline payment before the technician arrives.</p>
        </div>
      `;
      return;
    }

    const currentUserId = state.currentUser.id;
    container.innerHTML = messages.map(m => {
      const isMe = m.sender_id === currentUserId;

      if (m.message_type === 'payment_agreed') {
        return `
          <div class="flex items-center justify-center my-3">
            <div class="bg-emerald-50 border border-emerald-200 text-emerald-800 px-4 py-2 rounded-2xl text-xs font-bold shadow-sm flex items-center gap-2">
              <i class="fa-solid fa-handshake text-emerald-600 text-sm"></i>
              <span>${m.message}</span>
            </div>
          </div>
        `;
      }

      if (m.message_type === 'price_offer') {
        return `
          <div class="flex ${isMe ? 'justify-end' : 'justify-start'} my-2">
            <div class="max-w-xs sm:max-w-md p-3.5 rounded-2xl ${isMe ? 'bg-slate-900 text-white' : 'bg-white border border-slate-200 text-slate-800'} shadow-sm space-y-2">
              <div class="flex items-center justify-between gap-3 text-[10px] text-amber-400 font-bold uppercase">
                <span><i class="fa-solid fa-tag"></i> Price Offer Proposed</span>
                <span class="${isMe ? 'text-slate-400' : 'text-slate-400'}">${new Date(m.created_at || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
              </div>
              <div class="text-base font-black ${isMe ? 'text-white' : 'text-slate-900'}">₹${Number(m.proposed_price).toFixed(2)}</div>
              <p class="text-xs ${isMe ? 'text-slate-300' : 'text-slate-600'}">${m.message}</p>
              ${!isMe ? `
                <button onclick="acceptProposedPrice(${m.proposed_price})" class="w-full mt-2 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-xs rounded-xl transition flex items-center justify-center gap-1.5 shadow">
                  <i class="fa-solid fa-check"></i> Accept Offline Deal (₹${m.proposed_price})
                </button>
              ` : ''}
            </div>
          </div>
        `;
      }

      return `
        <div class="flex items-start gap-2.5 ${isMe ? 'flex-row-reverse' : ''}">
          <img src="${m.sender_avatar || 'https://api.dicebear.com/7.x/avataaars/svg?seed=' + m.sender_name}" class="w-7 h-7 rounded-full object-cover border border-slate-200 mt-1">
          <div class="max-w-[78%]">
            <div class="flex items-center gap-2 mb-1 ${isMe ? 'justify-end' : ''}">
              <span class="font-bold text-[11px] text-slate-700">${isMe ? 'You' : m.sender_name}</span>
              <span class="text-[9px] text-slate-400">${new Date(m.created_at || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
            </div>
            <div class="p-3 rounded-2xl ${isMe ? 'bg-brand-600 text-white rounded-tr-none' : 'bg-white border border-slate-200 text-slate-800 rounded-tl-none'} shadow-sm leading-relaxed">
              ${m.message}
            </div>
          </div>
        </div>
      `;
    }).join('');

    if (!silent) {
      container.scrollTop = container.scrollHeight;
    }
  } catch(err) {
    if (!silent) console.error('Failed to load chat messages:', err);
  }
}

async function handleSendChatMessage(e) {
  e.preventDefault();
  const input = document.getElementById('chat-message-input');
  const message = input?.value.trim();
  if (!message || !state.activeChatRequestId) return;

  input.value = '';

  try {
    await api(`/requests/${state.activeChatRequestId}/messages`, {
      method: 'POST',
      body: JSON.stringify({ message, message_type: 'text' })
    });
    loadChatMessages(state.activeChatRequestId);
  } catch (err) {
    showToast('Failed to send message: ' + err.message, 'error');
  }
}

async function sendPriceOffer() {
  const priceInput = document.getElementById('chat-offer-price');
  const price = Number(priceInput?.value);
  if (!price || price <= 0) {
    showToast('Please enter a valid offer price in INR (₹)', 'warning');
    priceInput?.focus();
    return;
  }
  if (!state.activeChatRequestId) return;

  try {
    await api(`/requests/${state.activeChatRequestId}/messages`, {
      method: 'POST',
      body: JSON.stringify({
        message: `I propose a negotiated service charge of ₹${price.toFixed(2)} to be paid in cash upon completion.`,
        message_type: 'price_offer',
        proposed_price: price
      })
    });
    priceInput.value = '';
    showToast(`Price offer of ₹${price} proposed!`, 'success');
    loadChatMessages(state.activeChatRequestId);
  } catch (err) {
    showToast('Failed to propose price: ' + err.message, 'error');
  }
}

async function acceptProposedPrice(price) {
  if (!state.activeChatRequestId) return;
  try {
    await api(`/requests/${state.activeChatRequestId}/negotiate-price`, {
      method: 'POST',
      body: JSON.stringify({ price })
    });
    showToast(`Offline payment deal accepted at ₹${price}!`, 'success');
    loadChatMessages(state.activeChatRequestId);
    loadCustomerRequests();
    loadProviderDashboard();
  } catch (err) {
    showToast('Failed to accept price: ' + err.message, 'error');
  }
}

async function confirmOfflinePaymentDeal() {
  if (!state.activeChatRequestId) return;
  const priceInput = document.getElementById('chat-offer-price');
  const enteredPrice = Number(priceInput?.value);
  const promptPrice = prompt('Enter the agreed offline cash amount (₹) to lock in the deal:', enteredPrice || '450');
  if (!promptPrice) return;

  const price = Number(promptPrice);
  if (isNaN(price) || price <= 0) {
    showToast('Please enter a valid price amount', 'warning');
    return;
  }

  await acceptProposedPrice(price);
}

function sendQuickReply(text) {
  const input = document.getElementById('chat-message-input');
  if (input) {
    input.value = text;
    document.getElementById('chat-input-form')?.dispatchEvent(new Event('submit', { cancelable: true }));
  }
}

function debounce(fn, ms) {
  let timer;
  return function(...args) {
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), ms);
  };
}

document.addEventListener('DOMContentLoaded', initApp);
