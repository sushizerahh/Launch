'use strict';

/**
 * setup.js
 * --------
 * Initial setup script. Run with: npm run setup
 *  - Creates .env from .env.example if missing
 *  - Initializes database
 *  - Runs initial model training
 *  - Validates API connections
 */

require('dotenv').config();

const fs = require('fs');
const path = require('path');

async function main() {
  console.log('\n=== Predictive Launch Engine - Setup ===\n');

  // 1. Create .env if missing
  const envPath = path.resolve('.env');
  const envExample = path.resolve('.env.example');
  if (!fs.existsSync(envPath) && fs.existsSync(envExample)) {
    fs.copyFileSync(envExample, envPath);
    console.log('[1/5] Created .env from .env.example');
    console.log('      -> Edit .env to add your API keys before starting!\n');
  } else {
    console.log('[1/5] .env already exists');
  }

  // 2. Create data directories
  const dirs = ['./data', './data/logs', './models'];
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
      console.log(`[2/5] Created directory: ${dir}`);
    }
  }
  console.log('[2/5] Data directories ready');

  // 3. Initialize database
  try {
    const { getDb } = require('../src/database/db');
    getDb();
    console.log('[3/5] Database initialized');
  } catch (err) {
    console.error(`[3/5] Database error: ${err.message}`);
  }

  // 4. Run initial model training with synthetic data
  try {
    console.log('[4/5] Training initial model with synthetic data...');
    const { execSync } = require('child_process');
    execSync('node scripts/train_model.js', { stdio: 'pipe' });
    console.log('[4/5] Model trained successfully');
  } catch (err) {
    console.warn(`[4/5] Model training: ${err.message}`);
  }

  // 5. Validate configuration
  console.log('[5/5] Configuration check:');
  const config = require('../src/config/config');

  const checks = [
    { name: 'Solana RPC', value: config.solana.rpcUrl, required: true },
    { name: 'Helius API', value: config.apis.helius.key, required: false },
    { name: 'Birdeye API', value: config.apis.birdeye.key, required: false },
    { name: 'Twitter Bearer', value: config.apis.twitter.bearerToken, required: false },
    { name: 'Telegram Bot', value: config.apis.telegram.botToken, required: false },
    { name: 'Trading Webhook', value: config.trading.webhookUrl, required: false },
  ];

  for (const check of checks) {
    const status = check.value && !check.value.includes('your_') ? '✓' : check.required ? '✗ MISSING' : '○ optional';
    const color = status.startsWith('✓') ? '\x1b[32m' : status.startsWith('✗') ? '\x1b[31m' : '\x1b[33m';
    console.log(`      ${color}${status}\x1b[0m  ${check.name}`);
  }

  console.log('\n=== Setup Complete ===');
  console.log('\nNext steps:');
  console.log('  1. Edit .env with your API keys');
  console.log('  2. Run: npm start');
  console.log(`  3. Open dashboard: http://localhost:${config.server.port}`);
  console.log('\nFor docs: see README.md\n');
}

main().catch((err) => {
  console.error('Setup failed:', err.message);
  process.exit(1);
});
