'use strict';

/**
 * Predictive Launch Engine - Main Entry Point
 * -------------------------------------------
 * Orchestrates all modules and starts the system.
 */

require('dotenv').config();

const config = require('./config/config');
const logger = require('./utils/logger');
const { getDb } = require('./database/db');

const OnchainScanner = require('./modules/onchainScanner');
const DevCluster = require('./modules/devCluster');
const SocialAnalyzer = require('./modules/socialAnalyzer');
const PreLaunchDetector = require('./modules/preLaunchDetector');
const ScoringEngine = require('./modules/scoringEngine');
const AlertSystem = require('./modules/alertSystem');
const LearningSystem = require('./modules/learningSystem');
const IntegrationModule = require('./modules/integrationModule');
const { createServer } = require('./api/server');

async function main() {
  logger.info('========================================');
  logger.info(' PREDICTIVE LAUNCH ENGINE - SOLANA');
  logger.info('========================================');
  logger.info(`Alert threshold: ${config.scoring.alertThreshold}`);
  logger.info(`High priority threshold: ${config.scoring.highPriorityThreshold}`);

  // Initialize database
  getDb();

  // -------------------------------------------------------
  // Instantiate all modules
  // -------------------------------------------------------
  const onchainScanner = new OnchainScanner();
  const devCluster = new DevCluster();
  const socialAnalyzer = new SocialAnalyzer();
  const scoringEngine = new ScoringEngine();
  const alertSystem = new AlertSystem();
  const integrationModule = new IntegrationModule();

  const preLaunchDetector = new PreLaunchDetector(
    onchainScanner,
    devCluster,
    socialAnalyzer
  );

  const learningSystem = new LearningSystem(scoringEngine, devCluster);

  // -------------------------------------------------------
  // Initialize (order matters)
  // -------------------------------------------------------
  devCluster.init();
  socialAnalyzer.init();
  scoringEngine.init();
  preLaunchDetector.init();
  learningSystem.init();
  integrationModule.init();

  // -------------------------------------------------------
  // Start API server + get Socket.IO instance
  // -------------------------------------------------------
  const engine = {
    onchainScanner,
    devCluster,
    socialAnalyzer,
    scoringEngine,
    alertSystem,
    learningSystem,
    integrationModule,
    preLaunchDetector,
  };

  const { io } = createServer(engine);
  alertSystem.init(io);

  // -------------------------------------------------------
  // Wire up the main event pipeline
  // -------------------------------------------------------

  // When a pre-launch is detected: score it + alert
  preLaunchDetector.on('pre_launch_detected', async (launch) => {
    logger.info(`[Main] Pre-launch detected: ${launch.id.slice(0, 8)}`);

    const db = getDb();
    const launchRow = db
      .prepare('SELECT * FROM potential_launches WHERE id = ?')
      .get(launch.id);

    if (!launchRow) return;

    // Full scoring
    const scoring = scoringEngine.score(launchRow, { devCluster, socialAnalyzer });

    // Alert
    await alertSystem.sendAlert(launchRow, scoring);

    // Emit to dashboard
    io.emit('pre_launch', { launch: launchRow, scoring });

    // Send to trading bot if high priority
    if (scoring.entryPriority === 'HIGH') {
      await integrationModule.sendTradeSignal(launchRow, scoring);
    }
  });

  // Confirmed on-chain launch
  preLaunchDetector.on('launch_confirmed', ({ id, data }) => {
    logger.info(`[Main] Launch confirmed on-chain: ${id.slice(0, 8)}`);
    io.emit('launch_confirmed', { id, data });
  });

  // -------------------------------------------------------
  // Start scanners
  // -------------------------------------------------------
  socialAnalyzer.start();
  await onchainScanner.start();

  // -------------------------------------------------------
  // Graceful shutdown
  // -------------------------------------------------------
  const shutdown = (signal) => {
    logger.info(`[Main] Received ${signal}, shutting down...`);
    onchainScanner.stop();
    socialAnalyzer.stop();
    learningSystem.stop();
    scoringEngine.saveModel();
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  process.on('uncaughtException', (err) => {
    logger.error(`[Main] Uncaught exception: ${err.message}`);
    logger.error(err.stack);
  });

  process.on('unhandledRejection', (reason) => {
    logger.warn(`[Main] Unhandled rejection: ${reason}`);
  });

  logger.info('[Main] System fully operational');
  logger.info(`[Main] Dashboard: http://localhost:${config.server.port}`);
}

main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
