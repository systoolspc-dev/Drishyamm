#!/usr/bin/env node
/**
 * Test multipart upload functionality for large files
 */

const s3Service = require('../services/s3.service');
const logger = require('../config/logger');

async function testMultipartUpload() {
  console.log('🧪 Testing S3 Multipart Upload...\n');

  try {
    // Create a test file larger than 5MB threshold
    const testSizes = [
      { name: 'Small (1MB)', size: 1 * 1024 * 1024 },
      { name: 'Medium (6MB - triggers multipart)', size: 6 * 1024 * 1024 },
      { name: 'Large (15MB - multipart)', size: 15 * 1024 * 1024 },
    ];

    for (const test of testSizes) {
      console.log(`\n📦 Testing ${test.name}...`);

      const testData = Buffer.alloc(test.size);
      const filename = `test-${test.name.toLowerCase().replace(/\s+/g, '-')}-${Date.now()}.bin`;

      const startTime = Date.now();

      const key = await s3Service.uploadRecording(
        'test-user-id',
        'test-group',
        'test-camera',
        filename,
        testData,
        'application/octet-stream',
        new Date().toISOString().slice(0, 10)
      );

      const elapsed = Date.now() - startTime;
      const throughput = (test.size / 1024 / 1024) / (elapsed / 1000);

      console.log(`✅ Upload successful!`);
      console.log(`   Key: ${key}`);
      console.log(`   Time: ${(elapsed / 1000).toFixed(2)}s`);
      console.log(`   Throughput: ${throughput.toFixed(2)} MB/s`);
    }

    console.log('\n✅ All multipart upload tests passed!\n');
    process.exit(0);

  } catch (error) {
    console.error('\n❌ Test failed:', error.message);
    logger.error('Multipart upload test failed', { error: error.message, stack: error.stack });
    process.exit(1);
  }
}

testMultipartUpload();
