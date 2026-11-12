const http = require('node:http');

// Set port to 3001 for test suite
process.env.PORT = '3001';

console.log('--- Starting Fixit Test Suite ---');
require('./server.js');

function req(path, method = 'GET', body = null, token = null) {
  return new Promise((resolve, reject) => {
    const postData = body ? JSON.stringify(body) : null;
    const options = {
      hostname: '127.0.0.1',
      port: 3001,
      path,
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
        ...(postData ? { 'Content-Length': Buffer.byteLength(postData) } : {})
      }
    };

    const request = http.request(options, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(data), raw: data });
        } catch(e) {
          resolve({ status: res.statusCode, raw: data });
        }
      });
    });

    request.on('error', reject);
    if (postData) request.write(postData);
    request.end();
  });
}

async function runTests() {
  // Give server 500ms to listen
  await new Promise(r => setTimeout(r, 600));

  let passed = 0;
  let total = 0;

  function assert(condition, message) {
    total++;
    if (condition) {
      console.log(`  ✅ PASS: ${message}`);
      passed++;
    } else {
      console.error(`  ❌ FAIL: ${message}`);
      process.exitCode = 1;
    }
  }

  try {
    console.log('\n1. Testing Static Assets:');
    const indexRes = await req('/');
    assert(indexRes.status === 200 && indexRes.raw.includes('Fixit'), 'GET / serves index.html with brand');

    const appJsRes = await req('/app.js');
    assert(appJsRes.status === 200 && appJsRes.raw.includes('state'), 'GET /app.js serves application bundle');

    console.log('\n2. Testing Public APIs:');
    const catRes = await req('/api/categories');
    assert(catRes.status === 200 && catRes.data.categories.length >= 6, `Categories loaded: ${catRes.data.categories?.length}`);

    const provRes = await req('/api/providers');
    assert(provRes.status === 200 && provRes.data.providers.length >= 3, `Approved providers count: ${provRes.data.providers?.length}`);

    console.log('\n3. Testing Demo Switcher & Auth:');
    const custAuth = await req('/api/auth/demo', 'POST', { role: 'customer' });
    assert(custAuth.status === 200 && custAuth.data.user.role === 'customer', `Customer Alice logged in (Token: ${custAuth.data.token.substring(0, 10)}...)`);

    const provAuth = await req('/api/auth/demo', 'POST', { role: 'provider' });
    assert(provAuth.status === 200 && provAuth.data.user.role === 'provider', `Provider Mike logged in (Hourly: $${provAuth.data.provider.hourly_rate})`);

    const adminAuth = await req('/api/auth/demo', 'POST', { role: 'admin' });
    assert(adminAuth.status === 200 && adminAuth.data.user.role === 'admin', 'Admin Superuser logged in');

    console.log('\n4. Testing Full Service Request Lifecycle:');
    // Customer submits a complaint
    const newReqRes = await req('/api/requests', 'POST', {
      title: 'Water heater making loud rumbling noise',
      description: 'The tank rattles whenever water is heated. Might be mineral sediment.',
      category_id: 1, // Plumbing
      preferred_date: '2026-11-20',
      preferred_time: 'Morning (09:00 AM - 12:00 PM)',
      address: '742 Evergreen Terrace, Basement',
      urgency: 'urgent',
      photos: ['https://images.unsplash.com/photo-1584622650111-993a426fbf0a?auto=format&fit=crop&w=600&q=80']
    }, custAuth.data.token);
    assert(newReqRes.status === 201 && newReqRes.data.request.status === 'Pending', `New request created: ${newReqRes.data.request.ticket_number}`);

    const ticketId = newReqRes.data.request.id;

    // Provider Mike accepts the job
    const acceptRes = await req(`/api/requests/${ticketId}/status`, 'PUT', { status: 'Accepted' }, provAuth.data.token);
    assert(acceptRes.status === 200 && acceptRes.data.request.status === 'Accepted', 'Provider successfully accepted request');

    // Provider starts work (In Progress)
    const progRes = await req(`/api/requests/${ticketId}/status`, 'PUT', { status: 'In Progress' }, provAuth.data.token);
    assert(progRes.status === 200 && progRes.data.request.status === 'In Progress', 'Status transitioned to In Progress');

    // Provider completes work with completion notes and final bill
    const compRes = await req(`/api/requests/${ticketId}/status`, 'PUT', {
      status: 'Completed',
      completion_notes: 'Flushed 5 gallons of mineral scale, inspected anode rod, and tested pressure relief valve.',
      final_cost: 90.0
    }, provAuth.data.token);
    assert(compRes.status === 200 && compRes.data.request.status === 'Completed' && compRes.data.request.final_cost === 90, 'Job marked as Completed with $90 final bill');

    // Customer rates & reviews provider
    const rateRes = await req(`/api/requests/${ticketId}/rate`, 'POST', {
      rating: 5,
      comment: 'Mike was extremely knowledgeable and solved the noisy heater quickly!'
    }, custAuth.data.token);
    assert(rateRes.status === 201, 'Customer successfully submitted 5-star rating & review');

    console.log('\n5. Testing Admin Capabilities:');
    // Admin checks stats
    const statsRes = await req('/api/admin/stats', 'GET', null, adminAuth.data.token);
    assert(statsRes.status === 200 && statsRes.data.stats.totalRequests > 0, `Admin stats verified (Total volume: $${statsRes.data.stats.totalRevenue})`);

    // Admin creates new category
    const catName = 'Smart Automation ' + Date.now().toString(36);
    const addCatRes = await req('/api/categories', 'POST', {
      name: catName,
      icon: 'fa-shield-halved',
      base_price: 65,
      description: 'Smart locks, doorbell cameras, and home automation sensors.'
    }, adminAuth.data.token);
    assert(addCatRes.status === 201 && addCatRes.data.category.id > 0, 'Admin successfully added new service category');

    // Admin verifies pending provider
    const pendingProvs = await req('/api/providers?status=pending', 'GET', null, adminAuth.data.token);
    if (pendingProvs.data.providers && pendingProvs.data.providers.length > 0) {
      const pId = pendingProvs.data.providers[0].id;
      const verifyRes = await req(`/api/providers/${pId}/verify`, 'PUT', { status: 'approved' }, adminAuth.data.token);
      assert(verifyRes.status === 200 && verifyRes.data.provider.verification_status === 'approved', 'Admin approved pending provider');
    }

    console.log('\n6. Testing Notifications:');
    const notifRes = await req('/api/notifications', 'GET', null, custAuth.data.token);
    assert(notifRes.status === 200 && notifRes.data.notifications.length > 0, `Customer received notifications: ${notifRes.data.notifications.length} alerts`);

    console.log('\n7. Testing Provider Registration with "Others" Category & Custom Trade:');
    const customRegRes = await req('/api/auth/register', 'POST', {
      name: 'Tom Reynolds (Roofer)',
      email: `tom_${Date.now()}@fixit.com`,
      password: 'password123',
      role: 'provider',
      phone: '+1 (555) 777-8899',
      category_id: 8, // Others
      custom_trade: 'Roofing & Gutter Specialist',
      hourly_rate: 65,
      skills: 'Shingle repair, Rain gutters'
    });
    assert(customRegRes.status === 201 && customRegRes.data.user.role === 'provider', 'Provider registered with Others category');
    const skillsParsed = JSON.parse(customRegRes.data.provider.skills);
    assert(skillsParsed.includes('Roofing & Gutter Specialist'), 'Custom trade recorded at head of provider skills');

    console.log('\n8. Testing Location & 5km Radius Notification Matching:');
    // Customer submits a request with coordinates (37.7749, -122.4194)
    const geoReqRes = await req('/api/requests', 'POST', {
      title: 'Emergency Pipe Burst in Basement',
      description: 'Water spraying from main shutoff valve.',
      category_id: 1, // Plumbing
      preferred_date: '2026-11-22',
      preferred_time: 'Emergency / As Soon As Possible',
      address: '742 Market St, San Francisco',
      latitude: 37.7749,
      longitude: -122.4194,
      urgency: 'urgent'
    }, custAuth.data.token);
    assert(geoReqRes.status === 201 && geoReqRes.data.request.latitude === 37.7749, 'Request created with GPS coordinates');

    // Provider Mike Vance is at (37.7833, -122.4167), distance is ~1.0 km <= 5km
    const provJobs = await req('/api/requests', 'GET', null, provAuth.data.token);
    const matchedJob = provJobs.data.requests.find(j => j.id === geoReqRes.data.request.id);
    assert(matchedJob && matchedJob.distance_km !== null, `Provider calculates distance to job: ${matchedJob?.distance_km} km`);
    assert(matchedJob && matchedJob.within_radius === true, 'Job correctly flagged as within provider 5km radius');

    // Verify Provider Mike received the nearby job notification
    const provNotifs = await req('/api/notifications', 'GET', null, provAuth.data.token);
    const nearbyNotif = provNotifs.data.notifications.find(n => n.title === 'Nearby Job Alert');
    assert(nearbyNotif && nearbyNotif.message.includes('km away'), 'Provider received 5km radius job alert notification');

    console.log('\n9. Testing Independent Chat & Offline Payment Negotiation:');
    // Customer sends a message on ticketId
    const chatMsgRes = await req(`/api/requests/${ticketId}/messages`, 'POST', {
      message: 'Hi Mike, can we pay cash in person upon completion?',
      message_type: 'text'
    }, custAuth.data.token);
    assert(chatMsgRes.status === 201 && chatMsgRes.data.message.id > 0, 'Customer sent chat message');

    // Provider sends price proposal
    const offerRes = await req(`/api/requests/${ticketId}/messages`, 'POST', {
      message: 'I can do $75 cash upon completion.',
      message_type: 'price_offer',
      proposed_price: 75
    }, provAuth.data.token);
    assert(offerRes.status === 201 && offerRes.data.message.proposed_price === 75, 'Provider proposed offline price deal ($75)');

    // Customer accepts the offline negotiated price deal
    const dealRes = await req(`/api/requests/${ticketId}/negotiate-price`, 'POST', {
      price: 75
    }, custAuth.data.token);
    assert(dealRes.status === 200 && dealRes.data.agreed_price === 75, 'Offline cash deal confirmed & locked at $75');

    // Verify messages feed
    const allMsgsRes = await req(`/api/requests/${ticketId}/messages`, 'GET', null, custAuth.data.token);
    assert(allMsgsRes.status === 200 && allMsgsRes.data.messages.length >= 3, `Chat stream verified (${allMsgsRes.data.messages.length} messages)`);
    assert(allMsgsRes.data.request.offline_payment_agreed === 1, 'Request offline_payment_agreed flag is active');

    console.log(`\n========================================`);
    console.log(`TEST RESULTS: ${passed} / ${total} tests passed successfully!`);
    console.log(`========================================\n`);

  } catch (err) {
    console.error('Test execution error:', err);
    process.exitCode = 1;
  } finally {
    process.exit(process.exitCode || 0);
  }
}

runTests();
