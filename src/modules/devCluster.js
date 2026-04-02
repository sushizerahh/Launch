'use strict';

/**
 * devCluster.js
 * -------------
 * Groups wallets by suspected developer identity using behavioral patterns:
 *  - Transaction timing similarity
 *  - Common funding sources
 *  - Repeated interaction patterns
 *  - Historical launch performance
 */

const { EventEmitter } = require('events');
const { v4: uuidv4 } = require('uuid');
const config = require('../config/config');
const { getDb } = require('../database/db');
const logger = require('../utils/logger');

class DevCluster extends EventEmitter {
  constructor() {
    super();
    this.db = null;
    // In-memory graph: walletAddress -> Set of related wallets
    this.graph = new Map();
  }

  init() {
    this.db = getDb();
    logger.info('[DevCluster] Initialized');
  }

  // -------------------------------------------------------
  // Core clustering logic
  // -------------------------------------------------------

  /**
   * Analyze a wallet and attempt to cluster it with known devs.
   * Returns the cluster ID (existing or newly created).
   */
  async analyzeWallet(address, onchainScanner) {
    try {
      const history = await onchainScanner.getWalletHistory(address);
      if (history.length === 0) return null;

      const features = this._extractWalletFeatures(address, history);
      const clusterId = this._findOrCreateCluster(address, features);

      this.db
        .prepare(
          `UPDATE wallets SET dev_cluster_id = ?, suspected_dev = 1 WHERE address = ?`
        )
        .run(clusterId, address);

      logger.info(`[DevCluster] Wallet ${address.slice(0, 8)}... -> cluster ${clusterId.slice(0, 8)}`);
      this.emit('cluster_updated', { address, clusterId, features });

      return clusterId;
    } catch (err) {
      logger.error(`[DevCluster] analyzeWallet error: ${err.message}`);
      return null;
    }
  }

  _extractWalletFeatures(address, history) {
    const timestamps = history.map((s) => s.blockTime || 0).filter(Boolean);
    const hourDistribution = new Array(24).fill(0);

    for (const ts of timestamps) {
      const hour = new Date(ts * 1000).getUTCHours();
      hourDistribution[hour]++;
    }

    // Preferred trading hours (top 3)
    const preferredHours = hourDistribution
      .map((count, hour) => ({ hour, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 3)
      .map((h) => h.hour);

    // Activity burst pattern (std dev of intervals)
    const intervals = [];
    for (let i = 1; i < timestamps.length; i++) {
      intervals.push(Math.abs(timestamps[i] - timestamps[i - 1]));
    }
    const avgInterval = intervals.length
      ? intervals.reduce((a, b) => a + b, 0) / intervals.length
      : 0;

    return {
      address,
      txCount: history.length,
      preferredHours,
      avgInterval,
      hourDistribution,
      firstSeen: timestamps.length ? Math.min(...timestamps) : 0,
      lastSeen: timestamps.length ? Math.max(...timestamps) : 0,
    };
  }

  _findOrCreateCluster(address, features) {
    // Check existing clusters for similarity
    const existingWallet = this.db
      .prepare('SELECT dev_cluster_id FROM wallets WHERE address = ?')
      .get(address);

    if (existingWallet?.dev_cluster_id) {
      return existingWallet.dev_cluster_id;
    }

    // Look for similar wallets in the graph
    const candidates = this._findSimilarWallets(features);
    if (candidates.length > 0) {
      const clusterId = candidates[0].clusterId;
      this._addToCluster(clusterId);
      return clusterId;
    }

    // Create new cluster
    const clusterId = uuidv4();
    this.db
      .prepare(
        `INSERT OR IGNORE INTO dev_clusters
         (id, created_at, wallet_count)
         VALUES (?, ?, 1)`
      )
      .run(clusterId, Date.now());

    this.graph.set(address, { clusterId, features });
    return clusterId;
  }

  _findSimilarWallets(features) {
    const results = [];
    for (const [addr, data] of this.graph) {
      const similarity = this._computeSimilarity(features, data.features);
      if (similarity > 0.65) {
        results.push({ address: addr, clusterId: data.clusterId, similarity });
      }
    }
    return results.sort((a, b) => b.similarity - a.similarity);
  }

  _computeSimilarity(f1, f2) {
    if (!f1 || !f2) return 0;

    // Hour overlap similarity
    const hourOverlap = f1.preferredHours.filter((h) =>
      f2.preferredHours.includes(h)
    ).length;
    const hourSim = hourOverlap / 3;

    // Interval similarity (closer = more similar)
    const intervalDiff = Math.abs(f1.avgInterval - f2.avgInterval);
    const intervalSim = Math.max(0, 1 - intervalDiff / 86400);

    // Hour distribution cosine similarity
    const distSim = this._cosineSimilarity(f1.hourDistribution, f2.hourDistribution);

    return hourSim * 0.35 + intervalSim * 0.25 + distSim * 0.40;
  }

  _cosineSimilarity(a, b) {
    if (!a || !b || a.length !== b.length) return 0;
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    if (normA === 0 || normB === 0) return 0;
    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
  }

  _addToCluster(clusterId) {
    this.db
      .prepare(
        `UPDATE dev_clusters SET wallet_count = wallet_count + 1 WHERE id = ?`
      )
      .run(clusterId);
  }

  // -------------------------------------------------------
  // Performance tracking
  // -------------------------------------------------------

  recordLaunchOutcome(clusterId, { success, peakMultiplier }) {
    try {
      const cluster = this.db
        .prepare('SELECT * FROM dev_clusters WHERE id = ?')
        .get(clusterId);

      if (!cluster) return;

      const newTotal = cluster.total_launches + 1;
      const newSuccessful = cluster.successful_launches + (success ? 1 : 0);
      const newAvgMultiplier =
        (cluster.avg_pump_multiplier * cluster.total_launches + (peakMultiplier || 0)) /
        newTotal;

      const reliabilityScore = newSuccessful / newTotal;

      this.db
        .prepare(
          `UPDATE dev_clusters SET
             total_launches = ?,
             successful_launches = ?,
             avg_pump_multiplier = ?,
             reliability_score = ?,
             last_launch_at = ?
           WHERE id = ?`
        )
        .run(newTotal, newSuccessful, newAvgMultiplier, reliabilityScore, Date.now(), clusterId);

      logger.info(
        `[DevCluster] Updated cluster ${clusterId.slice(0, 8)}: ` +
        `${newSuccessful}/${newTotal} wins, ${newAvgMultiplier.toFixed(2)}x avg`
      );
    } catch (err) {
      logger.error(`[DevCluster] recordLaunchOutcome error: ${err.message}`);
    }
  }

  // -------------------------------------------------------
  // Scoring
  // -------------------------------------------------------

  getDevScore(clusterId) {
    if (!clusterId) return 0.1;

    const cluster = this.db
      .prepare('SELECT * FROM dev_clusters WHERE id = ?')
      .get(clusterId);

    if (!cluster) return 0.1;
    if (cluster.total_launches === 0) return 0.2;

    const winRate = cluster.successful_launches / cluster.total_launches;
    const experienceBonus = Math.min(cluster.total_launches / 10, 0.2);
    const multiplierBonus = Math.min((cluster.avg_pump_multiplier - 1) / 50, 0.2);
    const recencyBonus = cluster.last_launch_at
      ? Math.max(0, 0.1 * (1 - (Date.now() - cluster.last_launch_at) / (30 * 86400000)))
      : 0;

    const score = Math.min(
      winRate * 0.5 + experienceBonus + multiplierBonus + recencyBonus,
      1.0
    );

    return Math.max(score, 0.05);
  }

  getClusterInfo(clusterId) {
    if (!clusterId) return null;
    return this.db
      .prepare('SELECT * FROM dev_clusters WHERE id = ?')
      .get(clusterId);
  }

  getTopDevs(limit = 10) {
    return this.db
      .prepare(
        `SELECT * FROM dev_clusters
         WHERE total_launches > 0
         ORDER BY reliability_score DESC, avg_pump_multiplier DESC
         LIMIT ?`
      )
      .all(limit);
  }
}

module.exports = DevCluster;
