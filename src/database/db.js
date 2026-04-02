'use strict';

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const config = require('../config/config');
const logger = require('../utils/logger');

let db = null;

function getDb() {
  if (db) return db;

  const dbPath = path.resolve(config.database.path);
  const dbDir = path.dirname(dbPath);

  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  initSchema(db);
  logger.info(`Database initialized at ${dbPath}`);
  return db;
}

function initSchema(db) {
  db.exec(`
    -- Tracked wallets suspected of pre-launch activity
    CREATE TABLE IF NOT EXISTS wallets (
      address TEXT PRIMARY KEY,
      first_seen INTEGER NOT NULL,
      last_seen INTEGER NOT NULL,
      sol_received REAL DEFAULT 0,
      dex_interactions INTEGER DEFAULT 0,
      suspected_dev INTEGER DEFAULT 0,
      dev_cluster_id TEXT,
      risk_score REAL DEFAULT 0,
      notes TEXT
    );

    -- Developer clusters (grouped wallets)
    CREATE TABLE IF NOT EXISTS dev_clusters (
      id TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL,
      wallet_count INTEGER DEFAULT 1,
      successful_launches INTEGER DEFAULT 0,
      total_launches INTEGER DEFAULT 0,
      avg_pump_multiplier REAL DEFAULT 0,
      reliability_score REAL DEFAULT 0,
      last_launch_at INTEGER,
      tags TEXT
    );

    -- Detected potential launches
    CREATE TABLE IF NOT EXISTS potential_launches (
      id TEXT PRIMARY KEY,
      detected_at INTEGER NOT NULL,
      token_address TEXT,
      token_name TEXT,
      token_symbol TEXT,
      dev_wallet TEXT,
      dev_cluster_id TEXT,
      score REAL DEFAULT 0,
      dev_score REAL DEFAULT 0,
      onchain_score REAL DEFAULT 0,
      social_score REAL DEFAULT 0,
      capital_score REAL DEFAULT 0,
      similarity_score REAL DEFAULT 0,
      status TEXT DEFAULT 'pending',
      alert_sent INTEGER DEFAULT 0,
      launched_at INTEGER,
      peak_multiplier REAL,
      outcome TEXT,
      raw_signals TEXT
    );

    -- On-chain events
    CREATE TABLE IF NOT EXISTS onchain_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      wallet TEXT,
      program_id TEXT,
      signature TEXT UNIQUE,
      amount REAL,
      token_address TEXT,
      launch_id TEXT,
      raw_data TEXT,
      FOREIGN KEY (launch_id) REFERENCES potential_launches(id)
    );

    -- Social signals
    CREATE TABLE IF NOT EXISTS social_signals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp INTEGER NOT NULL,
      platform TEXT NOT NULL,
      signal_type TEXT NOT NULL,
      content TEXT,
      author TEXT,
      mentions INTEGER DEFAULT 0,
      sentiment REAL DEFAULT 0,
      launch_id TEXT,
      FOREIGN KEY (launch_id) REFERENCES potential_launches(id)
    );

    -- Alerts sent
    CREATE TABLE IF NOT EXISTS alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sent_at INTEGER NOT NULL,
      launch_id TEXT NOT NULL,
      channel TEXT NOT NULL,
      score REAL,
      message TEXT,
      FOREIGN KEY (launch_id) REFERENCES potential_launches(id)
    );

    -- Model training data (prediction vs reality)
    CREATE TABLE IF NOT EXISTS training_data (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      launch_id TEXT UNIQUE NOT NULL,
      features TEXT NOT NULL,
      score_predicted REAL,
      outcome_label INTEGER,
      peak_multiplier REAL,
      recorded_at INTEGER NOT NULL,
      FOREIGN KEY (launch_id) REFERENCES potential_launches(id)
    );

    -- Model versions / performance history
    CREATE TABLE IF NOT EXISTS model_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      trained_at INTEGER NOT NULL,
      training_samples INTEGER,
      accuracy REAL,
      precision_val REAL,
      recall_val REAL,
      weights TEXT
    );

    -- System metrics
    CREATE TABLE IF NOT EXISTS system_metrics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      recorded_at INTEGER NOT NULL,
      metric_name TEXT NOT NULL,
      metric_value REAL,
      metadata TEXT
    );

    -- Trades executados pelo autoTrader
    CREATE TABLE IF NOT EXISTS trades (
      id TEXT PRIMARY KEY,
      launch_id TEXT,
      token_address TEXT NOT NULL,
      status TEXT DEFAULT 'pending',
      buy_signature TEXT,
      sell_signature TEXT,
      sol_in REAL,
      tokens_out REAL,
      buy_price_usd REAL,
      sell_price_usd REAL,
      buy_at INTEGER,
      sell_at INTEGER,
      take_profit_target REAL,
      stop_loss_target REAL,
      pnl_sol REAL,
      pnl_pct REAL,
      close_reason TEXT,
      FOREIGN KEY (launch_id) REFERENCES potential_launches(id)
    );

    CREATE INDEX IF NOT EXISTS idx_trades_status ON trades(status);
    CREATE INDEX IF NOT EXISTS idx_trades_token ON trades(token_address);
    CREATE INDEX IF NOT EXISTS idx_wallets_cluster ON wallets(dev_cluster_id);
    CREATE INDEX IF NOT EXISTS idx_launches_score ON potential_launches(score DESC);
    CREATE INDEX IF NOT EXISTS idx_launches_status ON potential_launches(status);
    CREATE INDEX IF NOT EXISTS idx_onchain_wallet ON onchain_events(wallet);
    CREATE INDEX IF NOT EXISTS idx_onchain_type ON onchain_events(event_type);
    CREATE INDEX IF NOT EXISTS idx_social_platform ON social_signals(platform);
  `);
}

module.exports = { getDb };
