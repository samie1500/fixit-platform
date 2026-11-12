const { db } = require('./db.js');

const accounts = [
  { name: 'SamiePlayz', email: 'samieplayzofficial@gmail.com', role: 'customer', avatar: 'https://api.dicebear.com/7.x/initials/svg?seed=SamiePlayz&backgroundColor=0f5132' },
  { name: 'hustlewithavdhut', email: 'avdhutdevkate43@gmail.com', role: 'provider', avatar: 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?auto=format&fit=crop&w=256&h=256&q=80' },
  { name: 'optimus 5483', email: 'ubalemiss@gmail.com', role: 'customer', avatar: 'https://api.dicebear.com/7.x/initials/svg?seed=optimus5483&backgroundColor=5c2b97' }
];

accounts.forEach(a => {
  const existing = db.prepare('SELECT id FROM users WHERE LOWER(email) = LOWER(?)').get(a.email.toLowerCase());
  if (!existing) {
    const insert = db.prepare(`
      INSERT INTO users (name, email, password, role, phone, address, avatar, status)
      VALUES (?, ?, ?, ?, '+91 98765 00000', 'Pune, Maharashtra', ?, 'active')
    `).run(a.name, a.email.toLowerCase(), 'google_oauth_' + Date.now(), a.role, a.avatar);
    
    if (a.role === 'provider') {
      db.prepare(`
        INSERT INTO providers (user_id, category_id, skills, hourly_rate, bio, verification_status, is_available, district, state, latitude, longitude)
        VALUES (?, 8, ?, 499.0, ?, 'approved', 1, 'Pune, Maharashtra', 'Maharashtra', 18.5204, 73.8567)
      `).run(insert.lastInsertRowid, JSON.stringify(['Computer & Tech Repairs', 'General Services']), `${a.name} verified technician.`);
    }
    console.log('Seeded account:', a.name, a.email);
  } else {
    console.log('Already exists:', a.email);
  }
});

console.log('Google Accounts in DB:');
console.log(db.prepare(`
  SELECT id, name, email, role FROM users 
  WHERE email IN ('samieplayzofficial@gmail.com', 'avdhutdevkate43@gmail.com', 'ubalemiss@gmail.com', 'devkate.avdhut2003@gmail.com')
`).all());
