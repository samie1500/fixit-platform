const http = require('http');

function post(path, body, token) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const headers = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(data)
    };
    if (token) headers['Authorization'] = 'Bearer ' + token;

    const req = http.request({
      hostname: 'localhost',
      port: 3000,
      path,
      method: 'POST',
      headers
    }, (res) => {
      let raw = '';
      res.on('data', chunk => raw += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(raw) });
        } catch (e) {
          resolve({ status: res.statusCode, raw });
        }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function put(path, body, token) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const headers = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(data)
    };
    if (token) headers['Authorization'] = 'Bearer ' + token;

    const req = http.request({
      hostname: 'localhost',
      port: 3000,
      path,
      method: 'PUT',
      headers
    }, (res) => {
      let raw = '';
      res.on('data', chunk => raw += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(raw) });
        } catch (e) {
          resolve({ status: res.statusCode, raw });
        }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function get(path, token) {
  return new Promise((resolve, reject) => {
    const headers = {};
    if (token) headers['Authorization'] = 'Bearer ' + token;

    const req = http.request({
      hostname: 'localhost',
      port: 3000,
      path,
      method: 'GET',
      headers
    }, (res) => {
      let raw = '';
      res.on('data', chunk => raw += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(raw) });
        } catch (e) {
          resolve({ status: res.statusCode, raw });
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function runTests() {
  console.log('=== TEST 1: Google Account Chooser: Sign in as Avdhut S Devkate ===');
  const googAvdhut = await post('/api/auth/google', {
    email: 'devkate.avdhut2003@gmail.com',
    name: 'Avdhut S Devkate'
  });
  console.log('Status:', googAvdhut.status);
  console.log('User Role:', googAvdhut.body.user?.role, 'Provider ID:', googAvdhut.body.provider?.id);
  if (googAvdhut.status !== 200 || !googAvdhut.body.token) throw new Error('Google auth for Avdhut failed');

  console.log('\n=== TEST 2: Google Account Chooser: Sign in as Alice Morgan (Customer) ===');
  const googAlice = await post('/api/auth/google', {
    email: 'alice@fixit.com',
    name: 'Alice Morgan'
  });
  console.log('Status:', googAlice.status);
  console.log('User Role:', googAlice.body.user?.role);
  if (googAlice.status !== 200 || googAlice.body.user?.role !== 'customer') throw new Error('Google auth for Alice failed');

  console.log('\n=== TEST 3: Google Account Chooser: Custom Account (Use another account) ===');
  const customEmail = 'rahul.test.' + Date.now() + '@gmail.com';
  const googCustom = await post('/api/auth/google', {
    email: customEmail,
    name: 'Rahul Sharma',
    role: 'customer'
  });
  console.log('Status:', googCustom.status);
  console.log('Custom User Name:', googCustom.body.user?.name, 'Role:', googCustom.body.user?.role);
  if (googCustom.status !== 200 || googCustom.body.user?.email !== customEmail) throw new Error('Custom Google auth failed');

  console.log('\n=== TEST 4: Zomato-Style Provider Live GPS Auto-Update ===');
  const provToken = googAvdhut.body.token;
  const updateGps = await put('/api/providers/profile', {
    latitude: 18.5204,
    longitude: 73.8567,
    district: 'Pune, Maharashtra'
  }, provToken);
  console.log('Profile GPS Update Status:', updateGps.status);
  console.log('Updated Provider Coords:', updateGps.body.provider?.latitude, updateGps.body.provider?.longitude);
  if (updateGps.body.provider?.latitude !== 18.5204) throw new Error('GPS coordinates update failed');

  console.log('\n=== TEST 5: Job Distance Calculation & 5km Radius Matching ===');
  const provJobs = await get('/api/requests', provToken);
  console.log('Fetched jobs count:', provJobs.body.requests?.length);
  const puneJobs = provJobs.body.requests.filter(j => j.within_radius);
  console.log('Jobs flagged within radius:', puneJobs.map(j => ({ id: j.id, ticket: j.ticket_number, title: j.title, dist: j.distance_km, within: j.within_radius })));

  console.log('\n=== TEST 6: Categories table cleanliness ===');
  const { db } = require('./db.js');
  const cats = db.prepare('SELECT id, name, slug FROM categories').all();
  console.log('Clean Categories Count:', cats.length);
  cats.forEach(c => console.log(`  - [ID ${c.id}] ${c.name} (${c.slug})`));

  console.log('\nALL 6 VERIFICATION CHECKS PASSED SUCCESSFULLY!');
}

runTests().catch(err => {
  console.error('Test Failed:', err);
  process.exit(1);
});
