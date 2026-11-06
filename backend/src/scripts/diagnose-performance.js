#!/usr/bin/env node
/**
 * Performance diagnostics - find bottlenecks in API responses
 */

const axios = require('axios');

const API_BASE = process.env.API_URL || 'http://localhost:5000/api';
const AUTH_TOKEN = process.env.AUTH_TOKEN;

if (!AUTH_TOKEN) {
  console.error('❌ Set AUTH_TOKEN environment variable');
  console.error('Example: AUTH_TOKEN=your_jwt_token node diagnose-performance.js');
  process.exit(1);
}

async function timeRequest(name, url, headers = {}) {
  console.log(`\n📊 Testing: ${name}`);
  console.log(`   URL: ${url}`);

  const start = Date.now();

  try {
    const response = await axios.get(url, {
      headers: {
        Authorization: `Bearer ${AUTH_TOKEN}`,
        ...headers,
      },
      timeout: 30000,
    });

    const elapsed = Date.now() - start;
    const dataSize = JSON.stringify(response.data).length;

    console.log(`   ✅ Success: ${elapsed}ms`);
    console.log(`   📦 Response size: ${(dataSize / 1024).toFixed(2)} KB`);

    if (Array.isArray(response.data?.data)) {
      console.log(`   📋 Items returned: ${response.data.data.length}`);
    }

    if (response.data?.cached !== undefined) {
      console.log(`   💾 Cached: ${response.data.cached ? 'YES' : 'NO'}`);
    }

    return { success: true, elapsed, dataSize, data: response.data };

  } catch (error) {
    const elapsed = Date.now() - start;
    console.log(`   ❌ Failed: ${elapsed}ms`);
    console.log(`   Error: ${error.message}`);
    return { success: false, elapsed, error: error.message };
  }
}

async function runDiagnostics() {
  console.log('🔍 API Performance Diagnostics\n');
  console.log('━'.repeat(60));

  const results = [];

  // Test 1: List groups (includes camera status sync)
  const r1 = await timeRequest(
    'List Groups (with Shinobi status sync)',
    `${API_BASE}/groups`
  );
  results.push({ name: 'List Groups', ...r1 });

  // Get first group ID for subsequent tests
  const groupId = r1.data?.data?.[0]?.id;

  if (!groupId) {
    console.error('\n❌ No groups found - cannot continue');
    process.exit(1);
  }

  // Test 2: Get recordings (with cache)
  const r2 = await timeRequest(
    'Get Group Recordings (first call - may miss cache)',
    `${API_BASE}/groups/${groupId}/recordings?limit=50`
  );
  results.push({ name: 'Recordings (cold)', ...r2 });

  // Test 3: Get recordings (should hit cache)
  const r3 = await timeRequest(
    'Get Group Recordings (second call - should hit cache)',
    `${API_BASE}/groups/${groupId}/recordings?limit=50`
  );
  results.push({ name: 'Recordings (warm)', ...r3 });

  // Test 4: Get first thumbnail
  const firstRecording = r2.data?.data?.[0];
  if (firstRecording) {
    const r4 = await timeRequest(
      'Get Thumbnail (may spawn FFmpeg)',
      `${API_BASE}/groups/${groupId}/recordings/thumbnail?key=${firstRecording.key}`
    );
    results.push({ name: 'Thumbnail (cold)', ...r4 });

    // Test 5: Same thumbnail (should hit cache)
    const r5 = await timeRequest(
      'Get Thumbnail (should hit Redis cache)',
      `${API_BASE}/groups/${groupId}/recordings/thumbnail?key=${firstRecording.key}`
    );
    results.push({ name: 'Thumbnail (warm)', ...r5 });
  }

  // Summary
  console.log('\n\n' + '━'.repeat(60));
  console.log('📈 Performance Summary\n');

  results.forEach(r => {
    const status = r.success ? '✅' : '❌';
    const time = r.elapsed + 'ms';
    const cache = r.data?.cached ? '💾' : '';
    console.log(`${status} ${r.name.padEnd(30)} ${time.padStart(8)} ${cache}`);
  });

  console.log('\n💡 Performance Analysis:\n');

  // Identify slow requests (>1s)
  const slow = results.filter(r => r.elapsed > 1000);
  if (slow.length > 0) {
    console.log('⚠️  Slow Requests (>1s):');
    slow.forEach(r => {
      console.log(`   - ${r.name}: ${r.elapsed}ms`);
    });
    console.log('');
  }

  // Check if caching is working
  const recordings = results.filter(r => r.name.includes('Recordings'));
  if (recordings.length >= 2) {
    const speedup = recordings[0].elapsed / recordings[1].elapsed;
    if (speedup > 2) {
      console.log(`✅ Redis cache working well (${speedup.toFixed(1)}x faster on cache hit)\n`);
    } else {
      console.log(`⚠️  Cache not helping much (only ${speedup.toFixed(1)}x faster)\n`);
    }
  }

  const thumbnails = results.filter(r => r.name.includes('Thumbnail'));
  if (thumbnails.length >= 2) {
    const speedup = thumbnails[0].elapsed / thumbnails[1].elapsed;
    if (speedup > 5) {
      console.log(`✅ Thumbnail cache working well (${speedup.toFixed(1)}x faster on cache hit)\n`);
    } else if (speedup > 1.5) {
      console.log(`⚠️  Thumbnail cache helping but could be better (${speedup.toFixed(1)}x faster)\n`);
    } else {
      console.log(`❌ Thumbnail cache not working (${speedup.toFixed(1)}x faster)\n`);
    }
  }

  console.log('Recommendations:');
  if (slow.some(r => r.name.includes('Groups'))) {
    console.log('   - Shinobi status sync is slow - consider caching it');
  }
  if (slow.some(r => r.name.includes('Recordings') && !r.data?.cached)) {
    console.log('   - S3 listing is slow - ensure Redis cache is being used');
  }
  if (slow.some(r => r.name.includes('Thumbnail'))) {
    console.log('   - Thumbnail generation is slow - ensure Redis is caching JPEGs');
  }
  console.log('');
}

runDiagnostics().catch(console.error);
