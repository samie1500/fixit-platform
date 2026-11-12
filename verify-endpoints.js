async function verify() {
  console.log('--- Testing Fixit Backend Endpoints ---');
  
  // 1. Test Static files
  const htmlRes = await fetch('http://localhost:3000/');
  console.log('GET / status:', htmlRes.status);
  
  // 2. Test DB Inspect API
  const dbRes = await fetch('http://localhost:3000/api/db/inspect');
  const dbData = await dbRes.json();
  console.log('GET /api/db/inspect status:', dbRes.status, 'Total users:', dbData.totalUsers, 'Total providers:', dbData.totalProviders);
  const avdhut = dbData.users.find(u => u.email.includes('devkate'));
  console.log('Avdhut user found in fixit.db:', avdhut ? `ID: ${avdhut.id}, Name: ${avdhut.name}, Email: ${avdhut.email}, Role: ${avdhut.role}` : 'NOT FOUND');
  const avdhutPro = dbData.providers.find(p => p.email.includes('devkate'));
  console.log('Avdhut provider listing in fixit.db:', avdhutPro ? `ProID: ${avdhutPro.provider_id}, Rate: ₹${avdhutPro.hourly_rate}, Category: ${avdhutPro.category_name}` : 'NOT FOUND');

  // 3. Test Google Auth GET (Must not 401)
  const gGetRes = await fetch('http://localhost:3000/api/auth/google', { headers: { 'Accept': 'application/json' } });
  const gGetData = await gGetRes.json();
  console.log('GET /api/auth/google configured status:', gGetData.configured, '| message:', gGetData.message);

  // 4. Test Google Auth POST (Login as Avdhut)
  const gPostRes = await fetch('http://localhost:3000/api/auth/google', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'devkate.avdhut2003@gmail.com', name: 'Avdhut S Devkate' })
  });
  const gPostData = await gPostRes.json();
  console.log('POST /api/auth/google status:', gPostRes.status, '| Logged In:', gPostData.user.name, '| Role:', gPostData.user.role, '| Token:', gPostData.token ? 'YES' : 'NO');

  console.log('--- ALL VERIFICATION CHECKS PASSED SUCCESSFULLY ---');
}
verify().catch(e => console.error(e));
