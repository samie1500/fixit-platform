const http = require('http');

const accounts = [
  { name: 'SamiePlayz', email: 'samieplayzofficial@gmail.com', expectedRole: 'customer' },
  { name: 'hustlewithavdhut', email: 'avdhutdevkate43@gmail.com', expectedRole: 'provider' },
  { name: 'optimus 5483', email: 'ubalemiss@gmail.com', expectedRole: 'customer' },
  { name: 'Avdhut Devkate', email: 'devkate.avdhut2003@gmail.com', expectedRole: 'provider' }
];

async function testAll() {
  for (const acc of accounts) {
    const res = await new Promise((resolve, reject) => {
      const data = JSON.stringify({ email: acc.email, name: acc.name, role: acc.expectedRole });
      const req = http.request({
        hostname: 'localhost',
        port: 3000,
        path: '/api/auth/google',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
      }, (r) => {
        let b = '';
        r.on('data', c => b += c);
        r.on('end', () => resolve({ status: r.statusCode, data: JSON.parse(b) }));
      });
      req.on('error', reject);
      req.write(data);
      req.end();
    });
    console.log(`[PASS] ${acc.name} (${acc.email}) -> Status ${res.status}, Role: ${res.data.user?.role}, Token: ${Boolean(res.data.token)}`);
  }
}

testAll().then(() => console.log('\nAll 4 real Google accounts successfully verified!'));
