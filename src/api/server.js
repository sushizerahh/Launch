'use strict';

/**
 * server.js
 * ---------
 * Express + Socket.IO API server for the dashboard and external integrations.
 */

const express = require('express');
const http = require('http');
const { Server: SocketIO } = require('socket.io');
const rateLimit = require('express-rate-limit');
const path = require('path');
const config = require('../config/config');
const { getDb } = require('../database/db');
const logger = require('../utils/logger');

function createServer(engine) {
  const app = express();
  const httpServer = http.createServer(app);
  const io = new SocketIO(httpServer, {
    cors: { origin: '*' },
  });

  const db = getDb();

  // -------------------------------------------------------
  // Middleware
  // -------------------------------------------------------
  app.use(express.json());
  app.use(express.static(path.join(__dirname, '../dashboard')));

  const limiter = rateLimit({ windowMs: 60000, max: 120 });
  app.use('/api/', limiter);

  // -------------------------------------------------------
  // REST API routes
  // -------------------------------------------------------

  // System status
  app.get('/api/status', (req, res) => {
    const model = engine?.scoringEngine?.getModelInfo() || {};
    const perf = engine?.learningSystem?.getPerformanceReport() || {};
    res.json({
      status: 'running',
      uptime: process.uptime(),
      model,
      performance: perf,
      timestamp: Date.now(),
    });
  });

  // List potential launches
  app.get('/api/launches', (req, res) => {
    const status = req.query.status || 'pre_launch';
    const limit = Math.min(parseInt(req.query.limit || '50'), 200);
    const launches = db
      .prepare(
        `SELECT * FROM potential_launches
         WHERE status = ? OR ? = 'all'
         ORDER BY score DESC, detected_at DESC LIMIT ?`
      )
      .all(status, status, limit);
    res.json(launches);
  });

  // Get single launch details
  app.get('/api/launches/:id', (req, res) => {
    const launch = db
      .prepare('SELECT * FROM potential_launches WHERE id = ?')
      .get(req.params.id);
    if (!launch) return res.status(404).json({ error: 'Not found' });

    const events = db
      .prepare(
        `SELECT * FROM onchain_events WHERE launch_id = ? ORDER BY timestamp DESC LIMIT 50`
      )
      .all(req.params.id);

    const socialSignals = db
      .prepare(
        `SELECT * FROM social_signals WHERE launch_id = ? ORDER BY timestamp DESC LIMIT 20`
      )
      .all(req.params.id);

    res.json({ ...launch, events, socialSignals });
  });

  // Manual outcome recording (for testing/manual input)
  app.post('/api/launches/:id/outcome', (req, res) => {
    const { peakMultiplier, tokenAddress } = req.body;
    if (peakMultiplier === undefined) {
      return res.status(400).json({ error: 'peakMultiplier required' });
    }

    if (engine?.learningSystem) {
      engine.learningSystem
        .recordOutcome(req.params.id, { peakMultiplier, tokenAddress, launched: true })
        .then(() => res.json({ ok: true }))
        .catch((err) => res.status(500).json({ error: err.message }));
    } else {
      res.status(503).json({ error: 'Learning system not running' });
    }
  });

  // Top developers
  app.get('/api/devs', (req, res) => {
    const devs = db
      .prepare(
        `SELECT d.*, COUNT(w.address) as wallet_count_actual
         FROM dev_clusters d
         LEFT JOIN wallets w ON w.dev_cluster_id = d.id
         WHERE d.total_launches > 0
         GROUP BY d.id
         ORDER BY d.reliability_score DESC LIMIT 20`
      )
      .all();
    res.json(devs);
  });

  // Recent alerts
  app.get('/api/alerts', (req, res) => {
    const alerts = db
      .prepare(
        `SELECT a.*, p.token_name, p.token_symbol, p.dev_wallet, p.score
         FROM alerts a
         LEFT JOIN potential_launches p ON a.launch_id = p.id
         ORDER BY a.sent_at DESC LIMIT 50`
      )
      .all();
    res.json(alerts);
  });

  // Performance metrics
  app.get('/api/performance', (req, res) => {
    const report = engine?.learningSystem?.getPerformanceReport() || {};
    const recentMetrics = db
      .prepare(
        `SELECT * FROM system_metrics ORDER BY recorded_at DESC LIMIT 100`
      )
      .all();
    res.json({ ...report, recentMetrics });
  });

  // Force rescore a launch
  app.post('/api/launches/:id/rescore', (req, res) => {
    if (!engine) return res.status(503).json({ error: 'Engine not running' });

    const launch = db
      .prepare('SELECT * FROM potential_launches WHERE id = ?')
      .get(req.params.id);

    if (!launch) return res.status(404).json({ error: 'Not found' });

    const result = engine.scoringEngine.score(launch, {
      devCluster: engine.devCluster,
      socialAnalyzer: engine.socialAnalyzer,
    });

    res.json(result);
  });

  // Confirm trading execution
  app.post('/api/executions/:launchId/confirm', (req, res) => {
    if (!engine?.integrationModule) return res.status(503).json({ error: 'Not running' });
    engine.integrationModule.confirmExecution(req.params.launchId, req.body);
    res.json({ ok: true });
  });

  // ---- AutoTrader endpoints ----

  // Status e posições abertas
  app.get('/api/trader/status', (req, res) => {
    const at = engine?.autoTrader;
    if (!at) return res.status(503).json({ error: 'AutoTrader não inicializado' });
    res.json({
      enabled: at.enabled,
      openPositions: at.getOpenPositions(),
      watchlistSize: at.watchlist.size,
      pnl: at.getTradePnL(),
    });
  });

  // Histórico de trades
  app.get('/api/trader/trades', (req, res) => {
    const at = engine?.autoTrader;
    if (!at) return res.status(503).json({ error: 'Not running' });
    res.json(at.getTradeHistory(parseInt(req.query.limit || '50')));
  });

  // Venda manual de uma posição
  app.post('/api/trader/sell/:tokenAddress', async (req, res) => {
    const at = engine?.autoTrader;
    if (!at) return res.status(503).json({ error: 'Not running' });
    const result = await at.manualSell(req.params.tokenAddress);
    res.json(result);
  });

  // -------------------------------------------------------
  // WebSocket events
  // -------------------------------------------------------
  io.on('connection', (socket) => {
    logger.info(`[Server] Dashboard connected: ${socket.id}`);

    // Send current state on connect
    socket.emit('state', {
      launches: db
        .prepare(`SELECT * FROM potential_launches WHERE status != 'resolved' ORDER BY score DESC LIMIT 10`)
        .all(),
      alerts: db
        .prepare(`SELECT * FROM alerts ORDER BY sent_at DESC LIMIT 5`)
        .all(),
    });

    socket.on('disconnect', () => {
      logger.info(`[Server] Dashboard disconnected: ${socket.id}`);
    });
  });

  // -------------------------------------------------------
  // Start server
  // -------------------------------------------------------
  httpServer.listen(config.server.port, () => {
    logger.info(`[Server] Dashboard running at http://localhost:${config.server.port}`);
  });

  return { app, io, httpServer };
}

module.exports = { createServer };
