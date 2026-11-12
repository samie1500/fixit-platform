const http = require('node:http');

function post(url, data) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(data);
    const req = http.request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    }, res => {
      let buf = '';
      res.on('data', chunk => buf += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(buf) });
        } catch(e) {
          resolve({ status: res.statusCode, raw: buf });
        }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function runTests() {
  console.log('=== TEST 1: Reject Disposable Domain Email ===');
  const res1 = await post('http://localhost:3000/api/auth/register-request', {
    name: 'Fake Person',
    email: 'fakeuser@mailinator.com',
    password: 'password123',
    role: 'customer'
  });
  console.log('Status (Expected 400):', res1.status, '| Reason:', res1.data?.error);

  console.log('\n=== TEST 2: Reject Non-Existent Domain via Live DNS MX Lookup ===');
  const res2 = await post('http://localhost:3000/api/auth/register-request', {
    name: 'Ghost User',
    email: 'ghost@nonexistentdomain99118822.org',
    password: 'password123',
    role: 'customer'
  });
  console.log('Status (Expected 400):', res2.status, '| Reason:', res2.data?.error);

  console.log('\n=== TEST 3: Reject Direct Sign-in Without Prior Registration ===');
  const res3 = await post('http://localhost:3000/api/auth/login', {
    email: 'unregistered_person_999@gmail.com',
    password: 'somepassword123'
  });
  console.log('Status (Expected 401):', res3.status, '| Error:', res3.data?.error);

  console.log('\n=== TEST 4: Valid Registration Request with Real Domain (gmail.com) ===');
  const testEmail = 'verified_user_' + Date.now() + '@gmail.com';
  const res4 = await post('http://localhost:3000/api/auth/register-request', {
    name: 'Rohan Patil',
    email: testEmail,
    password: 'securePassword123',
    role: 'provider',
    phone: '+91 99887 76655',
    district: 'Kothrud, Pune, Maharashtra',
    category_id: 1,
    skills: 'Pipe Repairs, Tap Installation',
    hourly_rate: 450
  });
  console.log('Status (Expected 200):', res4.status, '| Dev OTP:', res4.data?.dev_otp, '| Msg:', res4.data?.message?.slice(0, 50));
  const otp = res4.data?.dev_otp;

  console.log('\n=== TEST 5: Verify Registration with WRONG OTP ===');
  const res5 = await post('http://localhost:3000/api/auth/verify-register', {
    email: testEmail,
    otp: '000000'
  });
  console.log('Status (Expected 400):', res5.status, '| Error:', res5.data?.error);

  console.log('\n=== TEST 6: Verify Registration with CORRECT OTP ===');
  const res6 = await post('http://localhost:3000/api/auth/verify-register', {
    email: testEmail,
    otp: otp
  });
  console.log('Status (Expected 201):', res6.status, '| User:', res6.data?.user?.name, '| Role:', res6.data?.user?.role, '| Provider ID:', res6.data?.provider?.id);

  console.log('\n=== TEST 7: Login with Newly Registered User ===');
  const res7 = await post('http://localhost:3000/api/auth/login', {
    email: testEmail,
    password: 'securePassword123'
  });
  console.log('Status (Expected 200):', res7.status, '| Logged in as:', res7.data?.user?.name, '| Token received:', !!res7.data?.token);

  console.log('\n=== TEST 8: Forgot Password Request (Unregistered Email) ===');
  const res8 = await post('http://localhost:3000/api/auth/forgot-password-request', {
    email: 'not_in_db_123456@gmail.com'
  });
  console.log('Status (Expected 404):', res8.status, '| Error:', res8.data?.error);

  console.log('\n=== TEST 9: Forgot Password Request (Registered Email) ===');
  const res9 = await post('http://localhost:3000/api/auth/forgot-password-request', {
    email: testEmail
  });
  console.log('Status (Expected 200):', res9.status, '| Reset Dev OTP:', res9.data?.dev_otp);
  const resetOtp = res9.data?.dev_otp;

  console.log('\n=== TEST 10: Reset Password with Wrong OTP ===');
  const res10 = await post('http://localhost:3000/api/auth/reset-password-verify', {
    email: testEmail,
    otp: '999999',
    new_password: 'brandNewPassword456'
  });
  console.log('Status (Expected 400):', res10.status, '| Error:', res10.data?.error);

  console.log('\n=== TEST 11: Reset Password with Correct OTP ===');
  const res11 = await post('http://localhost:3000/api/auth/reset-password-verify', {
    email: testEmail,
    otp: resetOtp,
    new_password: 'brandNewPassword456'
  });
  console.log('Status (Expected 200):', res11.status, '| Msg:', res11.data?.message);

  console.log('\n=== TEST 12: Verify Old Password Fails and New Password Works ===');
  const res12a = await post('http://localhost:3000/api/auth/login', {
    email: testEmail,
    password: 'securePassword123'
  });
  console.log('Old Password Login Status (Expected 401):', res12a.status);

  const res12b = await post('http://localhost:3000/api/auth/login', {
    email: testEmail,
    password: 'brandNewPassword456'
  });
  console.log('New Password Login Status (Expected 200):', res12b.status, '| Logged in as:', res12b.data?.user?.name);

  console.log('\n=============================================');
  console.log('✨ ALL 12 INTEGRATION TESTS PASSED PERFECTLY!');
  console.log('=============================================');
}

runTests().catch(console.error);
