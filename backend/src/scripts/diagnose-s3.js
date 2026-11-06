#!/usr/bin/env node
/**
 * S3 Network Diagnostics for NetForChoice 10PB
 * Tests connectivity, authentication, and upload performance
 */

const { S3Client, PutObjectCommand, HeadBucketCommand, ListObjectsV2Command } = require('@aws-sdk/client-s3');
const { NodeHttpHandler } = require('@aws-sdk/node-http-handler');
const https = require('https');
const dns = require('dns').promises;
const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);
const config = require('../config/env');

const COLORS = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
};

const log = {
  info: (msg) => console.log(`${COLORS.blue}ℹ${COLORS.reset} ${msg}`),
  success: (msg) => console.log(`${COLORS.green}✓${COLORS.reset} ${msg}`),
  error: (msg) => console.log(`${COLORS.red}✗${COLORS.reset} ${msg}`),
  warn: (msg) => console.log(`${COLORS.yellow}⚠${COLORS.reset} ${msg}`),
  header: (msg) => console.log(`\n${COLORS.cyan}━━━ ${msg} ━━━${COLORS.reset}`),
};

async function testDNS() {
  log.header('DNS Resolution Test');

  try {
    const hostname = new URL(config.s3.endpoint).hostname;
    log.info(`Resolving ${hostname}...`);

    const addresses = await dns.resolve4(hostname);
    log.success(`DNS resolved: ${addresses.join(', ')}`);

    // Reverse lookup
    for (const addr of addresses) {
      try {
        const hostnames = await dns.reverse(addr);
        log.info(`  ${addr} → ${hostnames.join(', ')}`);
      } catch (e) {
        log.warn(`  ${addr} → No reverse DNS`);
      }
    }

    return true;
  } catch (err) {
    log.error(`DNS resolution failed: ${err.message}`);
    return false;
  }
}

async function testNetworkConnectivity() {
  log.header('Network Connectivity Test');

  try {
    const hostname = new URL(config.s3.endpoint).hostname;

    // Test ping (ICMP)
    log.info(`Pinging ${hostname}...`);
    try {
      const { stdout } = await execPromise(`ping -c 4 ${hostname}`);
      const lines = stdout.split('\n');
      const statsLine = lines.find(l => l.includes('min/avg/max'));
      if (statsLine) {
        log.success(`Ping: ${statsLine.trim()}`);
      }
    } catch (e) {
      log.warn('Ping failed (ICMP might be blocked)');
    }

    // Test TCP connection
    log.info('Testing TCP connection on port 443...');
    const startTime = Date.now();

    await new Promise((resolve, reject) => {
      const socket = https.request({
        hostname,
        port: 443,
        method: 'HEAD',
        path: '/',
        timeout: 10000,
      });

      socket.on('response', (res) => {
        const latency = Date.now() - startTime;
        log.success(`TCP connection established (${latency}ms)`);
        log.info(`  Server: ${res.headers.server || 'Unknown'}`);
        socket.destroy();
        resolve();
      });

      socket.on('error', reject);
      socket.on('timeout', () => reject(new Error('Connection timeout')));
      socket.end();
    });

    return true;
  } catch (err) {
    log.error(`Network connectivity failed: ${err.message}`);
    return false;
  }
}

async function testS3Authentication() {
  log.header('S3 Authentication Test');

  try {
    log.info(`Testing credentials for bucket: ${config.s3.bucket}`);

    const httpsAgent = new https.Agent({
      keepAlive: true,
      timeout: 30000,
    });

    const client = new S3Client({
      endpoint: config.s3.endpoint,
      region: config.s3.region,
      credentials: {
        accessKeyId: config.s3.accessKey,
        secretAccessKey: config.s3.secretKey,
      },
      forcePathStyle: true,
      requestHandler: new NodeHttpHandler({
        httpsAgent,
        connectionTimeout: 15000,
        requestTimeout: 30000,
      }),
    });

    // Test bucket access
    await client.send(new HeadBucketCommand({ Bucket: config.s3.bucket }));
    log.success('Authentication successful');

    // List objects (first 10)
    const list = await client.send(new ListObjectsV2Command({
      Bucket: config.s3.bucket,
      MaxKeys: 10,
    }));

    log.info(`Bucket contains ${list.KeyCount || 0} objects (showing max 10)`);
    if (list.Contents && list.Contents.length > 0) {
      list.Contents.forEach(obj => {
        log.info(`  - ${obj.Key} (${(obj.Size / 1024 / 1024).toFixed(2)} MB)`);
      });
    }

    return true;
  } catch (err) {
    log.error(`Authentication failed: ${err.message}`);
    if (err.code === 'InvalidAccessKeyId') {
      log.error('  Check S3_ACCESS_KEY in .env');
    } else if (err.code === 'SignatureDoesNotMatch') {
      log.error('  Check S3_SECRET_KEY in .env');
    } else if (err.code === 'NoSuchBucket') {
      log.error(`  Bucket "${config.s3.bucket}" does not exist`);
    }
    return false;
  }
}

async function testSmallUpload() {
  log.header('Small Upload Test (1KB)');

  try {
    const httpsAgent = new https.Agent({
      keepAlive: true,
      keepAliveMsecs: 30000,
      maxSockets: 50,
      maxFreeSockets: 10,
      timeout: 300000,
    });

    const client = new S3Client({
      endpoint: config.s3.endpoint,
      region: config.s3.region,
      credentials: {
        accessKeyId: config.s3.accessKey,
        secretAccessKey: config.s3.secretKey,
      },
      forcePathStyle: true,
      requestHandler: new NodeHttpHandler({
        httpsAgent,
        connectionTimeout: 15000,
        requestTimeout: 60000,
      }),
      maxAttempts: 1, // No retries for diagnostic
    });

    const testData = Buffer.from('x'.repeat(1024)); // 1KB
    const key = `diagnostics/test-small-${Date.now()}.txt`;

    log.info('Uploading 1KB test file...');
    const startTime = Date.now();

    await client.send(new PutObjectCommand({
      Bucket: config.s3.bucket,
      Key: key,
      Body: testData,
      ContentType: 'text/plain',
    }));

    const elapsed = Date.now() - startTime;
    log.success(`Upload completed in ${elapsed}ms`);
    log.info(`  Key: ${key}`);

    return true;
  } catch (err) {
    log.error(`Small upload failed: ${err.message}`);
    log.error(`  Code: ${err.code}`);
    return false;
  }
}

async function testLargeUpload() {
  log.header('Large Upload Test (10MB)');

  try {
    const httpsAgent = new https.Agent({
      keepAlive: true,
      keepAliveMsecs: 30000,
      maxSockets: 50,
      maxFreeSockets: 10,
      timeout: 300000,
    });

    const client = new S3Client({
      endpoint: config.s3.endpoint,
      region: config.s3.region,
      credentials: {
        accessKeyId: config.s3.accessKey,
        secretAccessKey: config.s3.secretKey,
      },
      forcePathStyle: true,
      requestHandler: new NodeHttpHandler({
        httpsAgent,
        connectionTimeout: 15000,
        requestTimeout: 300000,
        socketTimeout: 300000,
      }),
      maxAttempts: 1, // No retries for diagnostic
    });

    const testData = Buffer.alloc(10 * 1024 * 1024); // 10MB
    const key = `diagnostics/test-large-${Date.now()}.bin`;

    log.info('Uploading 10MB test file...');
    const startTime = Date.now();

    await client.send(new PutObjectCommand({
      Bucket: config.s3.bucket,
      Key: key,
      Body: testData,
      ContentType: 'application/octet-stream',
    }));

    const elapsed = Date.now() - startTime;
    const throughput = (10 / (elapsed / 1000)).toFixed(2);

    log.success(`Upload completed in ${(elapsed / 1000).toFixed(2)}s`);
    log.info(`  Throughput: ${throughput} MB/s`);
    log.info(`  Key: ${key}`);

    return true;
  } catch (err) {
    log.error(`Large upload failed: ${err.message}`);
    log.error(`  Code: ${err.code}`);

    if (err.code === 'ECONNRESET') {
      log.warn('  → Connection reset during upload');
      log.warn('  → Possible causes:');
      log.warn('    - Network instability');
      log.warn('    - Firewall/proxy timeout');
      log.warn('    - S3 server overload');
    }

    return false;
  }
}

async function runDiagnostics() {
  console.log(`
${COLORS.cyan}╔════════════════════════════════════════════════════════════╗
║         NetForChoice 10PB S3 Network Diagnostics           ║
╚════════════════════════════════════════════════════════════╝${COLORS.reset}
`);

  log.info(`Endpoint: ${config.s3.endpoint}`);
  log.info(`Bucket:   ${config.s3.bucket}`);
  log.info(`Region:   ${config.s3.region}`);

  const results = {
    dns: await testDNS(),
    network: await testNetworkConnectivity(),
    auth: await testS3Authentication(),
    smallUpload: false,
    largeUpload: false,
  };

  // Only test uploads if auth works
  if (results.auth) {
    results.smallUpload = await testSmallUpload();
    if (results.smallUpload) {
      results.largeUpload = await testLargeUpload();
    }
  }

  // Summary
  log.header('Diagnostic Summary');

  const tests = [
    ['DNS Resolution', results.dns],
    ['Network Connectivity', results.network],
    ['S3 Authentication', results.auth],
    ['Small Upload (1KB)', results.smallUpload],
    ['Large Upload (10MB)', results.largeUpload],
  ];

  tests.forEach(([name, passed]) => {
    if (passed) {
      log.success(name);
    } else {
      log.error(name);
    }
  });

  const allPassed = Object.values(results).every(r => r === true);

  console.log('');
  if (allPassed) {
    log.success('All diagnostics passed! S3 connectivity is working correctly.');
  } else {
    log.error('Some diagnostics failed. Check the errors above.');
    console.log('\n💡 Troubleshooting tips:');
    console.log('   1. Verify credentials in .env file');
    console.log('   2. Check network/firewall rules');
    console.log('   3. Test from a different network');
    console.log('   4. Contact NetForChoice support if issues persist\n');
  }

  process.exit(allPassed ? 0 : 1);
}

// Run diagnostics
runDiagnostics().catch((err) => {
  log.error(`Fatal error: ${err.message}`);
  console.error(err.stack);
  process.exit(1);
});
