'use strict';

/**
 * preLaunchDetector.js
 * --------------------
 * Aggregates signals from on-chain scanner, dev cluster, and social analyzer
 * to identify imminent token launches before they happen.
 *
 * Emits 'pre_launch_detected' when a potential launch is identified.
 */

const { EventEmitter } = require('events');
const { v4: uuidv4 } = require('uuid');
const config = require('../config/config');
const { getDb } = require('../database/db');
const logger = require('../utils/logger');

// Time window to group related events (ms)
const GROUPING_WINDOW = 10 * 60 * 1000; // 10 minutes

class PreLaunchDetector extends EventEmitter {
  constructor(onchainScanner, devCluster, socialAnalyzer) {
    super();
    this.onchainScanner = onchainScanner;
    this.devCluster = devCluster;
    this.socialAnalyzer = socialAnalyzer;
    this.db = null;

    // Active detection windows: walletAddress -> { events[], firstSeen }
    this.detectionWindows = new Map();

    // Cooldown: wallets we've already alerted about recently
    this.alerted = new Set();
  }

  init() {
    this.db = getDb();
    this._bindEvents();
    this._startCleanupTimer();
    logger.info('[PreLaunchDetector] Initialized');
  }

  _bindEvents() {
    this.onchainScanner.on('suspicious_wallet', (data) => {
      this._processWalletEvent('suspicious_wallet', data.wallet.address, data);
    });

    this.onchainScanner.on('launch_detected', (data) => {
      this._processLaunchEvent(data);
    });

    this.onchainScanner.on('new_wallet', (data) => {
      this._processWalletEvent('new_wallet', data.address, data);
    });

    this.devCluster.on('cluster_updated', (data) => {
      this._processClusterEvent(data);
    });

    this.socialAnalyzer.on('hype_detected', (data) => {
      this._processSocialHype(data);
    });
  }

  // -------------------------------------------------------
  // Event processors
  // -------------------------------------------------------

  _processWalletEvent(type, address, data) {
    const win = this._getOrCreateWindow(address);
    win.events.push({ type, data, timestamp: Date.now() });
    win.onchainScore = this._computeOnchainScore(win);

    this._evaluateWindow(address, win);
  }

  async _processLaunchEvent(data) {
    // A launch event is a confirmed on-chain event - record immediately
    logger.info('[PreLaunchDetector] Real launch event detected on-chain');

    const id = uuidv4();
    const now = Date.now();

    try {
      this.db
        .prepare(
          `INSERT OR IGNORE INTO potential_launches
           (id, detected_at, status, onchain_score, raw_signals)
           VALUES (?, ?, 'launched', 0.95, ?)`
        )
        .run(id, now, JSON.stringify(data));

      this.emit('launch_confirmed', { id, data, timestamp: now });
    } catch (err) {
      logger.error(`[PreLaunchDetector] _processLaunchEvent error: ${err.message}`);
    }
  }

  _processClusterEvent(data) {
    const { address, clusterId } = data;
    const win = this._getOrCreateWindow(address);
    win.clusterId = clusterId;
    win.events.push({ type: 'cluster_linked', data, timestamp: Date.now() });
    win.devScore = this.devCluster.getDevScore(clusterId);

    this._evaluateWindow(address, win);
  }

  _processSocialHype(data) {
    // Link social hype to any open detection windows
    for (const [address, win] of this.detectionWindows) {
      win.socialScore = Math.max(win.socialScore || 0, this._socialHypeToScore(data));
      win.events.push({ type: 'social_hype', data, timestamp: Date.now() });
      this._evaluateWindow(address, win);
    }
  }

  _socialHypeToScore(hype) {
    const growthComponent = Math.min(hype.growthRate / 10, 0.4);
    const sentimentComponent = Math.max(0, (hype.avgSentiment + 5) / 10) * 0.3;
    const newAccountComponent = Math.min(hype.newAccountRatio * 2, 0.3);
    return growthComponent + sentimentComponent + newAccountComponent;
  }

  // -------------------------------------------------------
  // Window management
  // -------------------------------------------------------

  _getOrCreateWindow(address) {
    if (!this.detectionWindows.has(address)) {
      this.detectionWindows.set(address, {
        address,
        firstSeen: Date.now(),
        events: [],
        onchainScore: 0,
        devScore: 0,
        socialScore: 0,
        capitalScore: 0,
        clusterId: null,
        evaluated: false,
      });
    }
    return this.detectionWindows.get(address);
  }

  async _evaluateWindow(address, win) {
    // Don't re-evaluate too quickly
    if (win.evaluated && Date.now() - win.lastEval < 30000) return;
    win.lastEval = Date.now();

    const wallet = this.db
      .prepare('SELECT * FROM wallets WHERE address = ?')
      .get(address);

    if (!wallet) return;

    // Compute capital score based on wallet SOL balance history
    win.capitalScore = this._computeCapitalScore(wallet);

    // Run dev clustering if not yet done
    if (!win.clusterId && wallet.dex_interactions >= 2) {
      win.clusterId = await this.devCluster.analyzeWallet(address, this.onchainScanner);
      if (win.clusterId) {
        win.devScore = this.devCluster.getDevScore(win.clusterId);
      }
    }

    // Combined early score estimate (final scoring is in scoringEngine)
    const earlyScore =
      win.onchainScore * 0.35 +
      win.devScore * 0.30 +
      win.socialScore * 0.20 +
      win.capitalScore * 0.15;

    if (earlyScore >= 0.40 && !this.alerted.has(address)) {
      await this._createPotentialLaunch(address, win, earlyScore);
    }
  }

  async _createPotentialLaunch(address, win, earlyScore) {
    if (this.alerted.has(address)) return;
    this.alerted.add(address);

    const id = uuidv4();
    const now = Date.now();

    try {
      this.db
        .prepare(
          `INSERT OR IGNORE INTO potential_launches
           (id, detected_at, dev_wallet, dev_cluster_id,
            score, dev_score, onchain_score, social_score, capital_score,
            status, raw_signals)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pre_launch', ?)`
        )
        .run(
          id, now, address, win.clusterId,
          earlyScore,
          win.devScore, win.onchainScore, win.socialScore, win.capitalScore,
          JSON.stringify({ events: win.events.slice(-20) })
        );

      const launch = {
        id,
        devWallet: address,
        clusterId: win.clusterId,
        earlyScore,
        scores: {
          dev: win.devScore,
          onchain: win.onchainScore,
          social: win.socialScore,
          capital: win.capitalScore,
        },
        timestamp: now,
        events: win.events.length,
      };

      logger.info(
        `[PreLaunchDetector] PRE-LAUNCH DETECTED: wallet ${address.slice(0, 8)}... ` +
        `score=${earlyScore.toFixed(3)}`
      );

      this.emit('pre_launch_detected', launch);
      win.evaluated = true;
    } catch (err) {
      logger.error(`[PreLaunchDetector] _createPotentialLaunch error: ${err.message}`);
    }
  }

  // -------------------------------------------------------
  // Score computations
  // -------------------------------------------------------

  _computeOnchainScore(win) {
    const eventTypes = win.events.map((e) => e.type);
    let score = 0;

    if (eventTypes.includes('new_wallet')) score += 0.15;
    if (eventTypes.includes('suspicious_wallet')) score += 0.35;
    if (eventTypes.includes('cluster_linked')) score += 0.25;

    const txCount = win.events.filter((e) =>
      e.type === 'suspicious_wallet' || e.type === 'new_wallet'
    ).length;
    score += Math.min(txCount / 20, 0.25);

    return Math.min(score, 1.0);
  }

  _computeCapitalScore(wallet) {
    const solReceived = wallet.sol_received || 0;
    const dexInteractions = wallet.dex_interactions || 0;

    // More SOL accumulated = higher capital score
    const capitalAmount = Math.min(solReceived / 10, 0.5);
    // More DEX interactions = more prepared
    const interactionScore = Math.min(dexInteractions / 10, 0.5);

    return capitalAmount + interactionScore;
  }

  // -------------------------------------------------------
  // Cleanup old windows
  // -------------------------------------------------------

  _startCleanupTimer() {
    setInterval(() => {
      const now = Date.now();
      let removed = 0;
      for (const [address, win] of this.detectionWindows) {
        if (now - win.firstSeen > GROUPING_WINDOW * 6) {
          this.detectionWindows.delete(address);
          removed++;
        }
      }
      // Clear alerted set periodically
      if (this.alerted.size > 1000) {
        this.alerted.clear();
      }
      if (removed > 0) {
        logger.info(`[PreLaunchDetector] Cleaned ${removed} stale windows`);
      }
    }, GROUPING_WINDOW);
  }

  getPendingLaunches(limit = 20) {
    return this.db
      .prepare(
        `SELECT * FROM potential_launches
         WHERE status = 'pre_launch'
         ORDER BY score DESC LIMIT ?`
      )
      .all(limit);
  }
}

module.exports = PreLaunchDetector;
