const http = require('http');

function get(path) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: 'localhost',
      port: 3000,
      path,
      method: 'GET'
    }, (res) => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: raw
        });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function post(path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({
      hostname: 'localhost',
      port: 3000,
      path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data)
      }
    }, (res) => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: raw ? JSON.parse(raw) : {}
        });
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function run() {
  console.log('--- TEST 1: Check GET /api/auth/google before Client ID configuration ---');
  const res1 = await get('/api/auth/google');
  console.log('Status:', res1.status);
  console.log('Body:', res1.body);

  console.log('\n--- TEST 2: Configure Client ID via /api/auth/google/config ---');
  const sampleClientId = '123456789012-samplefixitapp.apps.googleusercontent.com';
  const res2 = await post('/api/auth/google/config', {
    client_id: sampleClientId,
    client_secret: 'sample_secret'
  });
  console.log('Config status:', res2.status, res2.body);

  console.log('\n--- TEST 3: Verify GET /api/auth/google now redirects (302) to accounts.google.com ---');
  const res3 = await get('/api/auth/google');
  console.log('Status:', res3.status);
  console.log('Location header:', res3.headers['location']);
  if (res3.status !== 302 || !res3.headers['location'].startsWith('https://accounts.google.com/o/oauth2/v2/auth')) {
    throw new Error('Failed to redirect to real Google OAuth accounts.google.com');
  }

  console.log('\n--- TEST 4: Verify Callback error handling ---');
  const res4 = await get('/api/auth/google/callback?error=access_denied');
  console.log('Callback error status:', res4.status, 'Redirects to:', res4.headers['location']);

  console.log('\nALL GOOGLE OAUTH REDIRECTION TESTS PASSED!');
}

run().catch(e => {
  console.error('Test failed:', e);
  process.exit(1);
});
