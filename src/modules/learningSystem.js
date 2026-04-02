'use strict';

/**
 * learningSystem.js
 * -----------------
 * Continuous learning system that:
 *  - Tracks all predictions vs actual outcomes
 *  - Retrains the scoring model periodically
 *  - Adjusts weights to improve accuracy over time
 *  - Reports performance metrics
 */

const ss = require('simple-statistics');
const config = require('../config/config');
const { getDb } = require('../database/db');
const logger = require('../utils/logger');

class LearningSystem {
  constructor(scoringEngine, devCluster) {
    this.scoringEngine = scoringEngine;
    this.devCluster = devCluster;
    this.db = null;
    this.retrainTimer = null;
  }

  init() {
    this.db = getDb();
    this._scheduleRetraining();
    logger.info('[LearningSystem] Initialized');
  }

  stop() {
    if (this.retrainTimer) {
      clearInterval(this.retrainTimer);
    }
  }

  // -------------------------------------------------------
  // Record outcome for a launch
  // -------------------------------------------------------

  async recordOutcome(launchId, { tokenAddress, peakMultiplier, launched }) {
    try {
      const launch = this.db
        .prepare('SELECT * FROM potential_launches WHERE id = ?')
        .get(launchId);

      if (!launch) {
        logger.warn(`[LearningSystem] Launch ${launchId} not found`);
        return;
      }

      // Outcome: pumped if peak >= 2x, failed otherwise
      const success = peakMultiplier >= 2.0;
      const outcome = success ? 'pumped' : peakMultiplier >= 1.0 ? 'neutral' : 'failed';

      this.db
        .prepare(
          `UPDATE potential_launches SET
             token_address = COALESCE(token_address, ?),
             launched_at = ?,
             peak_multiplier = ?,
             outcome = ?,
             status = 'resolved'
           WHERE id = ?`
        )
        .run(tokenAddress || null, Date.now(), peakMultiplier, outcome, launchId);

      // Update dev cluster performance
      if (launch.dev_cluster_id) {
        this.devCluster.recordLaunchOutcome(launch.dev_cluster_id, {
          success,
          peakMultiplier,
        });
      }

      // Store training sample
      const features = {
        devScore: launch.dev_score || 0,
        onchainScore: launch.onchain_score || 0,
        socialScore: launch.social_score || 0,
        capitalScore: launch.capital_score || 0,
        similarityScore: launch.similarity_score || 0,
      };

      this.db
        .prepare(
          `INSERT OR REPLACE INTO training_data
           (launch_id, features, score_predicted, outcome_label, peak_multiplier, recorded_at)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(
          launchId,
          JSON.stringify(features),
          launch.score,
          success ? 1 : 0,
          peakMultiplier,
          Date.now()
        );

      logger.info(
        `[LearningSystem] Outcome recorded: ${launchId.slice(0, 8)} -> ` +
        `${outcome} (${peakMultiplier.toFixed(2)}x)`
      );

      // Record system metric
      this.db
        .prepare(`INSERT INTO system_metrics (recorded_at, metric_name, metric_value) VALUES (?, ?, ?)`)
        .run(Date.now(), 'launch_outcome', success ? 1 : 0);

    } catch (err) {
      logger.error(`[LearningSystem] recordOutcome error: ${err.message}`);
    }
  }

  // -------------------------------------------------------
  // Model retraining
  // -------------------------------------------------------

  _scheduleRetraining() {
    const intervalMs = config.model.retrainIntervalHours * 3600000;
    this.retrainTimer = setInterval(() => this.retrain(), intervalMs);
    logger.info(`[LearningSystem] Retraining scheduled every ${config.model.retrainIntervalHours}h`);
  }

  async retrain() {
    logger.info('[LearningSystem] Starting model retraining...');

    try {
      const samples = this.db
        .prepare(
          `SELECT * FROM training_data
           WHERE outcome_label IS NOT NULL
           ORDER BY recorded_at DESC LIMIT 500`
        )
        .all();

      if (samples.length < config.model.minTrainingSamples) {
        logger.info(
          `[LearningSystem] Not enough samples (${samples.length}/${config.model.minTrainingSamples}), skipping`
        );
        return;
      }

      const { weights, metrics } = this._trainLogisticRegression(samples);

      this.scoringEngine.updateWeights(weights);
      this.scoringEngine.model.trainingSamples = samples.length;
      this.scoringEngine.model.lastTrained = Date.now();
      this.scoringEngine.model.accuracy = metrics.accuracy;
      this.scoringEngine.saveModel();

      // Record model history
      this.db
        .prepare(
          `INSERT INTO model_history
           (trained_at, training_samples, accuracy, precision_val, recall_val, weights)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(
          Date.now(),
          samples.length,
          metrics.accuracy,
          metrics.precision,
          metrics.recall,
          JSON.stringify(weights)
        );

      logger.info(
        `[LearningSystem] Model retrained: acc=${(metrics.accuracy * 100).toFixed(1)}% ` +
        `prec=${(metrics.precision * 100).toFixed(1)}% ` +
        `recall=${(metrics.recall * 100).toFixed(1)}%`
      );
    } catch (err) {
      logger.error(`[LearningSystem] Retrain error: ${err.message}`);
    }
  }

  _trainLogisticRegression(samples) {
    // Prepare feature matrix and labels
    const X = samples.map((s) => {
      const f = JSON.parse(s.features);
      return [
        f.devScore || 0,
        f.onchainScore || 0,
        f.socialScore || 0,
        f.capitalScore || 0,
        f.similarityScore || 0,
        s.score_predicted || 0,
      ];
    });
    const y = samples.map((s) => s.outcome_label);

    // Gradient descent for logistic regression
    const learningRate = 0.1;
    const epochs = 1000;
    const n = X.length;
    const m = X[0].length;

    let w = new Array(m).fill(0);
    let b = -1.5;

    const sigmoid = (z) => 1 / (1 + Math.exp(-Math.max(-500, Math.min(500, z))));

    for (let epoch = 0; epoch < epochs; epoch++) {
      let dw = new Array(m).fill(0);
      let db = 0;

      for (let i = 0; i < n; i++) {
        const z = X[i].reduce((sum, xi, j) => sum + xi * w[j], 0) + b;
        const pred = sigmoid(z);
        const err = pred - y[i];

        for (let j = 0; j < m; j++) {
          dw[j] += err * X[i][j];
        }
        db += err;
      }

      for (let j = 0; j < m; j++) {
        w[j] -= (learningRate / n) * dw[j];
      }
      b -= (learningRate / n) * db;
    }

    // Map to named weights
    const featureNames = ['devScore', 'onchainScore', 'socialScore', 'capitalScore', 'similarityScore', 'baseScore'];
    const namedWeights = { bias: b };
    featureNames.forEach((name, i) => {
      namedWeights[name] = w[i];
    });

    // Keep other weights at defaults
    const defaultW = {
      clusterSuccessRate: 2.0,
      clusterLaunches: 0.8,
      clusterAvgMultiplier: 1.0,
      marketHoursBonus: 0.5,
      weekendBonus: 0.3,
    };
    Object.assign(namedWeights, defaultW);

    // Evaluate on training set
    let tp = 0, fp = 0, fn = 0, tn = 0;
    for (let i = 0; i < n; i++) {
      const z = X[i].reduce((sum, xi, j) => sum + xi * w[j], 0) + b;
      const pred = 1 / (1 + Math.exp(-z)) >= 0.5 ? 1 : 0;
      if (pred === 1 && y[i] === 1) tp++;
      else if (pred === 1 && y[i] === 0) fp++;
      else if (pred === 0 && y[i] === 1) fn++;
      else tn++;
    }

    const accuracy = (tp + tn) / n;
    const precision = tp + fp > 0 ? tp / (tp + fp) : 0;
    const recall = tp + fn > 0 ? tp / (tp + fn) : 0;

    return { weights: namedWeights, metrics: { accuracy, precision, recall } };
  }

  // -------------------------------------------------------
  // Performance reporting
  // -------------------------------------------------------

  getPerformanceReport() {
    const totalPredictions = this.db
      .prepare(`SELECT COUNT(*) as cnt FROM potential_launches WHERE score > 0`)
      .get().cnt;

    const resolved = this.db
      .prepare(`SELECT COUNT(*) as cnt FROM potential_launches WHERE status = 'resolved'`)
      .get().cnt;

    const correct = this.db
      .prepare(
        `SELECT COUNT(*) as cnt FROM potential_launches
         WHERE status = 'resolved'
         AND ((score >= ? AND outcome = 'pumped') OR (score < ? AND outcome != 'pumped'))`
      )
      .get(config.scoring.alertThreshold, config.scoring.alertThreshold).cnt;

    const avgMultiplier = this.db
      .prepare(
        `SELECT AVG(peak_multiplier) as avg FROM potential_launches
         WHERE outcome = 'pumped' AND peak_multiplier IS NOT NULL`
      )
      .get().avg;

    const modelHistory = this.db
      .prepare(`SELECT * FROM model_history ORDER BY trained_at DESC LIMIT 5`)
      .all();

    return {
      totalPredictions,
      resolved,
      accuracy: resolved > 0 ? (correct / resolved) : 0,
      avgPumpMultiplier: avgMultiplier || 0,
      modelHistory,
      lastRetrained: modelHistory[0]?.trained_at || null,
    };
  }
}

module.exports = LearningSystem;
