'use strict';

/**
 * train_model.js
 * --------------
 * Standalone script to train/retrain the scoring model.
 * Run with: npm run train
 *
 * Can also seed with synthetic data for initial training.
 */

require('dotenv').config();

const { getDb } = require('../src/database/db');
const ScoringEngine = require('../src/modules/scoringEngine');
const DevCluster = require('../src/modules/devCluster');
const LearningSystem = require('../src/modules/learningSystem');
const logger = require('../src/utils/logger');

async function main() {
  const db = getDb();
  const scoringEngine = new ScoringEngine();
  scoringEngine.init();

  const devCluster = new DevCluster();
  devCluster.init();

  const learningSystem = new LearningSystem(scoringEngine, devCluster);
  learningSystem.init();

  const existingSamples = db
    .prepare('SELECT COUNT(*) as cnt FROM training_data WHERE outcome_label IS NOT NULL')
    .get().cnt;

  logger.info(`Existing training samples: ${existingSamples}`);

  if (existingSamples < 50) {
    logger.info('Seeding synthetic training data for initial model...');
    seedSyntheticData(db);
  }

  logger.info('Starting model training...');
  await learningSystem.retrain();

  const info = scoringEngine.getModelInfo();
  logger.info('Training complete!');
  logger.info(`Model info: ${JSON.stringify(info, null, 2)}`);
}

function seedSyntheticData(db) {
  // Generate synthetic training samples based on domain knowledge
  const samples = [];

  // High-quality launches (pumped)
  for (let i = 0; i < 80; i++) {
    samples.push({
      features: {
        devScore: 0.7 + Math.random() * 0.3,
        onchainScore: 0.6 + Math.random() * 0.4,
        socialScore: 0.5 + Math.random() * 0.5,
        capitalScore: 0.6 + Math.random() * 0.4,
        similarityScore: 0.5 + Math.random() * 0.5,
      },
      outcome: 1,
      peakMultiplier: 2 + Math.random() * 48,
    });
  }

  // Low-quality launches (failed)
  for (let i = 0; i < 80; i++) {
    samples.push({
      features: {
        devScore: Math.random() * 0.4,
        onchainScore: Math.random() * 0.4,
        socialScore: Math.random() * 0.3,
        capitalScore: Math.random() * 0.3,
        similarityScore: Math.random() * 0.3,
      },
      outcome: 0,
      peakMultiplier: Math.random() * 0.9,
    });
  }

  // Mixed signals (neutral)
  for (let i = 0; i < 40; i++) {
    const score = 0.3 + Math.random() * 0.4;
    samples.push({
      features: {
        devScore: score + (Math.random() - 0.5) * 0.2,
        onchainScore: score + (Math.random() - 0.5) * 0.2,
        socialScore: score + (Math.random() - 0.5) * 0.2,
        capitalScore: score + (Math.random() - 0.5) * 0.2,
        similarityScore: score + (Math.random() - 0.5) * 0.2,
      },
      outcome: Math.random() > 0.5 ? 1 : 0,
      peakMultiplier: 0.8 + Math.random() * 1.5,
    });
  }

  const { v4: uuidv4 } = require('uuid');
  const insertLaunch = db.prepare(
    `INSERT OR IGNORE INTO potential_launches
     (id, detected_at, score, dev_score, onchain_score, social_score, capital_score,
      similarity_score, status, outcome, peak_multiplier)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'resolved', ?, ?)`
  );

  const insertTraining = db.prepare(
    `INSERT OR IGNORE INTO training_data
     (launch_id, features, score_predicted, outcome_label, peak_multiplier, recorded_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  );

  const insertMany = db.transaction((samples) => {
    for (const s of samples) {
      const id = uuidv4();
      const f = s.features;
      const score =
        f.devScore * 0.30 +
        f.onchainScore * 0.25 +
        f.socialScore * 0.20 +
        f.capitalScore * 0.15 +
        f.similarityScore * 0.10;

      insertLaunch.run(
        id, Date.now() - Math.random() * 30 * 86400000,
        score, f.devScore, f.onchainScore, f.socialScore, f.capitalScore,
        f.similarityScore,
        s.outcome === 1 ? 'pumped' : 'failed',
        s.peakMultiplier
      );

      insertTraining.run(id, JSON.stringify(f), score, s.outcome, s.peakMultiplier, Date.now());
    }
  });

  insertMany(samples);
  logger.info(`Seeded ${samples.length} synthetic training samples`);
}

main().catch((err) => {
  logger.error(`Training failed: ${err.message}`);
  process.exit(1);
});
