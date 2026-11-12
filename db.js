const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const fs = require('node:fs');

const dbPath = path.join(__dirname, 'fixit.db');
const db = new DatabaseSync(dbPath);

// Enable foreign keys and WAL mode with busy timeout for multi-client concurrency
db.exec('PRAGMA foreign_keys = ON;');
try { db.exec('PRAGMA journal_mode = WAL;'); } catch(e){}
try { db.exec('PRAGMA busy_timeout = 5000;'); } catch(e){}

function initDatabase() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('customer', 'provider', 'admin')),
      phone TEXT,
      address TEXT,
      avatar TEXT,
      status TEXT DEFAULT 'active' CHECK(status IN ('active', 'suspended')),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      slug TEXT UNIQUE NOT NULL,
      description TEXT,
      icon TEXT,
      base_price REAL DEFAULT 35.0,
      is_active INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS providers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      category_id INTEGER REFERENCES categories(id),
      skills TEXT,
      hourly_rate REAL DEFAULT 40.0,
      experience_years INTEGER DEFAULT 3,
      bio TEXT,
      rating REAL DEFAULT 5.0,
      reviews_count INTEGER DEFAULT 0,
      verification_status TEXT DEFAULT 'approved' CHECK(verification_status IN ('pending', 'approved', 'rejected')),
      is_available INTEGER DEFAULT 1,
      latitude REAL DEFAULT 18.5204,
      longitude REAL DEFAULT 73.8567,
      service_radius_km REAL DEFAULT 5.0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticket_number TEXT UNIQUE NOT NULL,
      user_id INTEGER NOT NULL REFERENCES users(id),
      provider_id INTEGER REFERENCES providers(id),
      category_id INTEGER NOT NULL REFERENCES categories(id),
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      photos TEXT,
      preferred_date TEXT NOT NULL,
      preferred_time TEXT NOT NULL,
      address TEXT NOT NULL,
      latitude REAL,
      longitude REAL,
      urgency TEXT DEFAULT 'normal' CHECK(urgency IN ('low', 'normal', 'urgent')),
      status TEXT DEFAULT 'Pending' CHECK(status IN ('Pending', 'Accepted', 'In Progress', 'Completed', 'Rejected')),
      rejection_reason TEXT,
      completion_notes TEXT,
      estimated_cost REAL,
      final_cost REAL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS reviews (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      request_id INTEGER NOT NULL REFERENCES requests(id),
      user_id INTEGER NOT NULL REFERENCES users(id),
      provider_id INTEGER NOT NULL REFERENCES providers(id),
      rating INTEGER NOT NULL CHECK(rating BETWEEN 1 AND 5),
      comment TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id),
      title TEXT NOT NULL,
      message TEXT NOT NULL,
      type TEXT DEFAULT 'info',
      is_read INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      request_id INTEGER NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
      sender_id INTEGER NOT NULL REFERENCES users(id),
      message TEXT NOT NULL,
      message_type TEXT DEFAULT 'text' CHECK(message_type IN ('text', 'price_offer', 'payment_agreed', 'system')),
      proposed_price REAL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Safe column migrations for location & radius & offline negotiation
  try { db.exec('ALTER TABLE providers ADD COLUMN latitude REAL DEFAULT 18.5204;'); } catch(e){}
  try { db.exec('ALTER TABLE providers ADD COLUMN longitude REAL DEFAULT 73.8567;'); } catch(e){}
  try { db.exec('ALTER TABLE providers ADD COLUMN service_radius_km REAL DEFAULT 5.0;'); } catch(e){}
  try { db.exec('ALTER TABLE providers ADD COLUMN district TEXT DEFAULT "Pune, Maharashtra";'); } catch(e){}
  try { db.exec('ALTER TABLE providers ADD COLUMN state TEXT DEFAULT "Maharashtra";'); } catch(e){}
  try { db.exec('ALTER TABLE requests ADD COLUMN latitude REAL;'); } catch(e){}
  try { db.exec('ALTER TABLE requests ADD COLUMN longitude REAL;'); } catch(e){}
  try { db.exec('ALTER TABLE requests ADD COLUMN offline_payment_agreed INTEGER DEFAULT 0;'); } catch(e){}
  try { db.exec('ALTER TABLE requests ADD COLUMN agreed_price REAL;'); } catch(e){}

  // Update existing providers with Indian districts & realistic INR rates if still on legacy USD
  try {
    db.prepare('UPDATE providers SET district = "Pune, Maharashtra", state = "Maharashtra", hourly_rate = 499 WHERE id = 9 OR user_id = 13').run();
    db.prepare('UPDATE providers SET district = "Mumbai Suburban, Maharashtra", state = "Maharashtra", hourly_rate = 499 WHERE id = 1').run();
    db.prepare('UPDATE providers SET district = "Bengaluru Urban, Karnataka", state = "Karnataka", hourly_rate = 599 WHERE id = 2').run();
    db.prepare('UPDATE providers SET district = "South Delhi, Delhi", state = "Delhi", hourly_rate = 449 WHERE id = 3').run();
    db.prepare('UPDATE providers SET district = "Hyderabad, Telangana", state = "Telangana", hourly_rate = 699 WHERE id = 4').run();
    db.prepare('UPDATE providers SET district = "Ahmedabad, Gujarat", state = "Gujarat", hourly_rate = 399 WHERE id = 5').run();
    db.prepare('UPDATE categories SET base_price = 399 WHERE slug = "plumbing"').run();
    db.prepare('UPDATE categories SET base_price = 449 WHERE slug = "electrical"').run();
    db.prepare('UPDATE categories SET base_price = 349 WHERE slug = "carpentry"').run();
    db.prepare('UPDATE categories SET base_price = 599 WHERE slug = "ac-repair"').run();
    db.prepare('UPDATE categories SET base_price = 399 WHERE slug = "appliances"').run();
    db.prepare('UPDATE categories SET base_price = 699 WHERE slug = "painting"').run();
    db.prepare('UPDATE categories SET base_price = 399 WHERE slug = "others"').run();
  } catch(e){}

  // Seed default data if users table is empty
  const count = db.prepare('SELECT count(*) as total FROM users').get().total;
  if (count === 0) {
    seedDatabase();
  } else {
    // Ensure 'Others' category exists in existing DB
    const othersCat = db.prepare("SELECT id FROM categories WHERE slug = 'others'").get();
    if (!othersCat) {
      db.prepare(`
        INSERT INTO categories (name, slug, icon, base_price, description)
        VALUES (?, ?, ?, ?, ?)
      `).run('Others', 'others', 'fa-ellipsis', 399.0, 'General handyman, custom trades, and specialized home repairs.');
    }
  }
}

function seedDatabase() {
  console.log('Seeding initial data for Fixit...');

  // 1. Categories
  const categories = [
    { name: 'Plumbing Services', slug: 'plumbing', icon: 'fa-wrench', base_price: 45.0, description: 'Leak repairs, pipe installations, drain clearing, tap & fixture repairs.' },
    { name: 'Electrical Works', slug: 'electrical', icon: 'fa-bolt', base_price: 50.0, description: 'Wiring, circuit breakers, light fixtures, switchboard installations.' },
    { name: 'Carpentry & Woodwork', slug: 'carpentry', icon: 'fa-hammer', base_price: 40.0, description: 'Furniture repair, door locks, custom cabinets, hinge alignment.' },
    { name: 'AC Repair & HVAC', slug: 'ac-repair', icon: 'fa-snowflake', base_price: 55.0, description: 'AC servicing, gas charging, filter cleaning, cooling diagnostics.' },
    { name: 'Appliance Repair', slug: 'appliances', icon: 'fa-tv', base_price: 45.0, description: 'Washing machines, refrigerators, microwaves, dishwashers, TVs.' },
    { name: 'Painting & Waterproofing', slug: 'painting', icon: 'fa-paint-roller', base_price: 60.0, description: 'Wall touch-ups, full room painting, dampness sealing, plastering.' },
    { name: 'Others', slug: 'others', icon: 'fa-ellipsis', base_price: 40.0, description: 'General handyman, custom trades, and specialized home repairs.' }
  ];

  const insertCategory = db.prepare(`
    INSERT INTO categories (name, slug, icon, base_price, description)
    VALUES (?, ?, ?, ?, ?)
  `);

  for (const cat of categories) {
    insertCategory.run(cat.name, cat.slug, cat.icon, cat.base_price, cat.description);
  }

  // 2. Users
  const users = [
    {
      name: 'Super Admin',
      email: 'admin@fixit.com',
      password: 'password123',
      role: 'admin',
      phone: '+91 98765 00001',
      address: 'Fixit HQ, Tech Hub, India',
      avatar: 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?auto=format&fit=crop&w=256&h=256&q=80'
    }
  ];

  const insertUser = db.prepare(`
    INSERT INTO users (name, email, password, role, phone, address, avatar)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  for (const u of users) {
    insertUser.run(u.name, u.email, u.password, u.role, u.phone, u.address, u.avatar);
  }

  // 3. Clean database initialized
  console.log('Database initialized with categories and Super Admin successfully!');
}



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

module.exports = {
  db,
  initDatabase,
  calculateDistanceKm
};
