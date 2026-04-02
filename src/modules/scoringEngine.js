'use strict';

/**
 * scoringEngine.js
 * ----------------
 * AI/ML scoring engine that predicts pump probability for potential launches.
 *
 * Uses a trained ensemble model combining:
 *   - Logistic regression (fast baseline)
 *   - Feature-weighted heuristic scoring
 *   - Historical similarity matching
 *
 * Outputs:
 *   - pumpProbability (0-1)
 *   - riskScore (0-1, higher = riskier)
 *   - entryPriority ('HIGH' | 'MEDIUM' | 'LOW')
 *   - reasoning (array of explanation strings)
 */

const fs = require('fs');
const path = require('path');
const ss = require('simple-statistics');
const config = require('../config/config');
const { getDb } = require('../database/db');
const logger = require('../utils/logger');

class ScoringEngine {
  constructor() {
    this.db = null;
    this.model = null;
    this.featureHistory = [];
    this.modelPath = path.resolve(config.model.path);
  }

  init() {
    this.db = getDb();
    this._loadModel();
    logger.info('[ScoringEngine] Initialized');
  }

  // -------------------------------------------------------
  // Main scoring method
  // -------------------------------------------------------

  /**
   * Score a potential launch.
   * @param {object} launch - Row from potential_launches table
   * @param {object} extra - { socialAnalyzer, devCluster }
   * @returns {object} scoring result
   */
  score(launch, extra = {}) {
    const features = this._extractFeatures(launch, extra);
    const pumpProbability = this._predict(features);
    const riskScore = this._computeRisk(features);
    const reasoning = this._generateReasoning(features, pumpProbability);
    const entryPriority = this._determineEntryPriority(pumpProbability, riskScore);

    const result = {
      launchId: launch.id,
      pumpProbability,
      riskScore,
      entryPriority,
      reasoning,
      features,
      scoredAt: Date.now(),
    };

    // Persist updated score
    try {
      this.db
        .prepare(
          `UPDATE potential_launches SET
             score = ?, dev_score = ?, onchain_score = ?,
             social_score = ?, capital_score = ?, similarity_score = ?
           WHERE id = ?`
        )
        .run(
          pumpProbability,
          features.devScore,
          features.onchainScore,
          features.socialScore,
          features.capitalScore,
          features.similarityScore,
          launch.id
        );
    } catch (err) {
      logger.error(`[ScoringEngine] DB update error: ${err.message}`);
    }

    logger.info(
      `[ScoringEngine] Scored ${launch.id.slice(0, 8)}: ` +
      `pump=${pumpProbability.toFixed(3)} risk=${riskScore.toFixed(3)} priority=${entryPriority}`
    );

    return result;
  }

  // -------------------------------------------------------
  // Feature extraction
  // -------------------------------------------------------

  _extractFeatures(launch, { devCluster, socialAnalyzer } = {}) {
    const devScore = launch.dev_score || (devCluster?.getDevScore(launch.dev_cluster_id) ?? 0.1);
    const onchainScore = launch.onchain_score || 0;
    const socialScore = launch.social_score || 0;
    const capitalScore = launch.capital_score || 0;
    const similarityScore = this._computeSimilarityScore(launch);

    // Cluster quality
    let clusterSuccessRate = 0;
    let clusterLaunches = 0;
    let clusterAvgMultiplier = 0;

    if (devCluster && launch.dev_cluster_id) {
      const cluster = devCluster.getClusterInfo(launch.dev_cluster_id);
      if (cluster && cluster.total_launches > 0) {
        clusterSuccessRate = cluster.successful_launches / cluster.total_launches;
        clusterLaunches = cluster.total_launches;
        clusterAvgMultiplier = cluster.avg_pump_multiplier || 0;
      }
    }

    // Time-based features
    const hourOfDay = new Date(launch.detected_at).getUTCHours();
    const dayOfWeek = new Date(launch.detected_at).getUTCDay();
    // Market hours bonus (UTC 13-21 = US market hours)
    const marketHoursBonus = hourOfDay >= 13 && hourOfDay <= 21 ? 0.1 : 0;
    // Weekend bonus (crypto more active weekends)
    const weekendBonus = dayOfWeek === 0 || dayOfWeek === 6 ? 0.05 : 0;

    return {
      devScore,
      onchainScore,
      socialScore,
      capitalScore,
      similarityScore,
      clusterSuccessRate,
      clusterLaunches: Math.min(clusterLaunches / 20, 1),
      clusterAvgMultiplier: Math.min(clusterAvgMultiplier / 50, 1),
      marketHoursBonus,
      weekendBonus,
      // Combined weighted score
      weightedScore:
        devScore * config.scoring.weights.devScore +
        onchainScore * config.scoring.weights.onchainActivity +
        socialScore * config.scoring.weights.socialSignals +
        capitalScore * config.scoring.weights.capitalPattern +
        similarityScore * config.scoring.weights.launchSimilarity,
    };
  }

  // -------------------------------------------------------
  // Prediction models
  // -------------------------------------------------------

  _predict(features) {
    const w = this.model?.weights || this._defaultWeights();

    // Weighted logistic regression
    const z =
      w.bias +
      w.devScore * features.devScore +
      w.onchainScore * features.onchainScore +
      w.socialScore * features.socialScore +
      w.capitalScore * features.capitalScore +
      w.similarityScore * features.similarityScore +
      w.clusterSuccessRate * features.clusterSuccessRate +
      w.clusterLaunches * features.clusterLaunches +
      w.clusterAvgMultiplier * features.clusterAvgMultiplier +
      w.marketHoursBonus * features.marketHoursBonus +
      w.weekendBonus * features.weekendBonus;

    const sigmoid = 1 / (1 + Math.exp(-z));
    return Math.round(sigmoid * 1000) / 1000;
  }

  _defaultWeights() {
    return {
      bias: -1.5,
      devScore: 2.8,
      onchainScore: 2.2,
      socialScore: 1.8,
      capitalScore: 1.5,
      similarityScore: 1.2,
      clusterSuccessRate: 2.0,
      clusterLaunches: 0.8,
      clusterAvgMultiplier: 1.0,
      marketHoursBonus: 0.5,
      weekendBonus: 0.3,
    };
  }

  _computeRisk(features) {
    let risk = 0.5; // Base risk is always moderate for memecoins

    // Lower dev score = higher risk
    risk += (1 - features.devScore) * 0.20;
    // No social signal = higher risk
    risk += (1 - features.socialScore) * 0.15;
    // No on-chain preparation = higher risk
    risk += (1 - features.onchainScore) * 0.15;

    // New dev (no history) = higher risk
    if (features.clusterLaunches < 0.05) risk += 0.15;

    return Math.min(Math.max(risk, 0), 1.0);
  }

  _computeSimilarityScore(launch) {
    // Compare against known successful launches
    try {
      const successfulLaunches = this.db
        .prepare(
          `SELECT * FROM potential_launches
           WHERE outcome = 'pumped' AND peak_multiplier >= 2
           ORDER BY launched_at DESC LIMIT 50`
        )
        .all();

      if (successfulLaunches.length === 0) return 0.2;

      const currentScore = launch.onchain_score * 0.4 + launch.social_score * 0.3 + launch.capital_score * 0.3;
      const similarities = successfulLaunches.map((l) => {
        const refScore = (l.onchain_score || 0) * 0.4 + (l.social_score || 0) * 0.3 + (l.capital_score || 0) * 0.3;
        return 1 - Math.abs(currentScore - refScore);
      });

      return ss.mean(similarities.slice(0, 10));
    } catch (_) {
      return 0.2;
    }
  }

  _generateReasoning(features, probability) {
    const reasons = [];

    if (features.devScore >= 0.7) reasons.push('Dev has strong track record of successful launches');
    else if (features.devScore >= 0.4) reasons.push('Dev has moderate experience with some successful launches');
    else reasons.push('Dev is unknown or has limited history');

    if (features.onchainScore >= 0.6) reasons.push('Strong on-chain preparation signals detected');
    else if (features.onchainScore >= 0.3) reasons.push('Moderate on-chain activity observed');
    else reasons.push('Limited on-chain signals');

    if (features.socialScore >= 0.6) reasons.push('High social media interest and positive sentiment');
    else if (features.socialScore >= 0.3) reasons.push('Growing social mentions detected');
    else reasons.push('Low social media presence');

    if (features.capitalScore >= 0.6) reasons.push('Significant capital accumulation pattern detected');
    else reasons.push('Capital accumulation is below typical launch patterns');

    if (features.clusterSuccessRate >= 0.6) {
      reasons.push(`Cluster win rate: ${(features.clusterSuccessRate * 100).toFixed(0)}%`);
    }

    if (features.marketHoursBonus > 0) reasons.push('Launch timing aligns with peak trading hours');
    if (features.weekendBonus > 0) reasons.push('Weekend launch - historically higher retail interest');

    if (probability >= config.scoring.highPriorityThreshold) {
      reasons.push('HIGH CONFIDENCE: Multiple strong signals converging');
    }

    return reasons;
  }

  _determineEntryPriority(probability, risk) {
    if (probability >= config.scoring.highPriorityThreshold && risk <= 0.6) return 'HIGH';
    if (probability >= config.scoring.alertThreshold && risk <= 0.75) return 'MEDIUM';
    return 'LOW';
  }

  // -------------------------------------------------------
  // Model persistence
  // -------------------------------------------------------

  _loadModel() {
    try {
      if (fs.existsSync(this.modelPath)) {
        const raw = fs.readFileSync(this.modelPath, 'utf-8');
        this.model = JSON.parse(raw);
        logger.info(`[ScoringEngine] Model loaded (trained on ${this.model.trainingSamples} samples)`);
      } else {
        logger.info('[ScoringEngine] No model found, using default weights');
        this.model = { weights: this._defaultWeights(), trainingSamples: 0 };
      }
    } catch (err) {
      logger.warn(`[ScoringEngine] Model load error: ${err.message}, using defaults`);
      this.model = { weights: this._defaultWeights(), trainingSamples: 0 };
    }
  }

  saveModel() {
    try {
      const dir = path.dirname(this.modelPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this.modelPath, JSON.stringify(this.model, null, 2));
      logger.info('[ScoringEngine] Model saved');
    } catch (err) {
      logger.error(`[ScoringEngine] Save model error: ${err.message}`);
    }
  }

  updateWeights(newWeights) {
    this.model.weights = { ...this._defaultWeights(), ...newWeights };
    this.saveModel();
    logger.info('[ScoringEngine] Weights updated');
  }

  getModelInfo() {
    return {
      trainingSamples: this.model?.trainingSamples || 0,
      weights: this.model?.weights || this._defaultWeights(),
      lastTrained: this.model?.lastTrained || null,
      accuracy: this.model?.accuracy || null,
    };
  }
}

module.exports = ScoringEngine;
