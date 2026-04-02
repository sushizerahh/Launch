'use strict';

/**
 * alertSystem.js
 * --------------
 * Sends alerts for high-score pre-launch detections via:
 *  - Telegram bot
 *  - In-app WebSocket (dashboard)
 *  - Trading bot webhook
 */

const config = require('../config/config');
const { getDb } = require('../database/db');
const logger = require('../utils/logger');

let fetch;
try {
  fetch = require('node-fetch');
} catch (_) {
  fetch = global.fetch;
}

class AlertSystem {
  constructor() {
    this.db = null;
    this.io = null; // Socket.IO instance (set by server)
    this.cooldowns = new Map(); // launchId -> lastAlertTime
  }

  init(io = null) {
    this.db = getDb();
    this.io = io;
    logger.info('[AlertSystem] Initialized');
  }

  setSocketIO(io) {
    this.io = io;
  }

  // -------------------------------------------------------
  // Main alert dispatcher
  // -------------------------------------------------------

  async sendAlert(launch, scoringResult) {
    const { launchId, pumpProbability, riskScore, entryPriority, reasoning } = scoringResult;

    // Check threshold
    if (pumpProbability < config.scoring.alertThreshold) return;

    // Cooldown: don't re-alert the same launch within 15 minutes
    const lastAlert = this.cooldowns.get(launchId);
    if (lastAlert && Date.now() - lastAlert < 900000) return;
    this.cooldowns.set(launchId, Date.now());

    const message = this._buildMessage(launch, scoringResult);

    logger.info(`[AlertSystem] Sending alert for ${launchId.slice(0, 8)} - priority=${entryPriority}`);

    const tasks = [];

    // Telegram
    if (config.apis.telegram.botToken && config.apis.telegram.alertChatId) {
      tasks.push(this._sendTelegram(message));
    }

    // WebSocket (dashboard)
    if (this.io) {
      tasks.push(this._sendWebSocket(launch, scoringResult, message));
    }

    // Trading bot webhook
    if (config.trading.webhookUrl) {
      tasks.push(this._sendTradingWebhook(launch, scoringResult));
    }

    await Promise.allSettled(tasks);

    // Record alert
    try {
      this.db
        .prepare(
          `INSERT INTO alerts (sent_at, launch_id, channel, score, message)
           VALUES (?, ?, 'multi', ?, ?)`
        )
        .run(Date.now(), launchId, pumpProbability, message);

      this.db
        .prepare(`UPDATE potential_launches SET alert_sent = 1 WHERE id = ?`)
        .run(launchId);
    } catch (err) {
      logger.error(`[AlertSystem] DB record error: ${err.message}`);
    }
  }

  // -------------------------------------------------------
  // Message builder
  // -------------------------------------------------------

  _buildMessage(launch, scoring) {
    const { pumpProbability, riskScore, entryPriority, reasoning } = scoring;
    const pct = (pumpProbability * 100).toFixed(1);
    const riskPct = (riskScore * 100).toFixed(1);
    const emoji = entryPriority === 'HIGH' ? '🚀' : entryPriority === 'MEDIUM' ? '⚡' : '👀';
    const riskEmoji = riskScore <= 0.5 ? '🟢' : riskScore <= 0.7 ? '🟡' : '🔴';

    const lines = [
      `${emoji} PRE-LAUNCH DETECTED [${entryPriority} PRIORITY]`,
      ``,
      `Pump Probability: ${pct}%`,
      `Risk: ${riskEmoji} ${riskPct}%`,
      `Dev Wallet: ${launch.dev_wallet ? launch.dev_wallet.slice(0, 12) + '...' : 'Unknown'}`,
      launch.token_name ? `Token: ${launch.token_name} (${launch.token_symbol})` : '',
      ``,
      `📊 Scores:`,
      `  Dev:      ${((launch.dev_score || 0) * 100).toFixed(0)}%`,
      `  On-chain: ${((launch.onchain_score || 0) * 100).toFixed(0)}%`,
      `  Social:   ${((launch.social_score || 0) * 100).toFixed(0)}%`,
      `  Capital:  ${((launch.capital_score || 0) * 100).toFixed(0)}%`,
      ``,
      `📝 Analysis:`,
      ...reasoning.slice(0, 4).map((r) => `  • ${r}`),
      ``,
      `⏰ Detected: ${new Date(launch.detected_at).toUTCString()}`,
      `🆔 ID: ${launch.id.slice(0, 8)}`,
    ].filter((l) => l !== null);

    return lines.join('\n');
  }

  // -------------------------------------------------------
  // Channels
  // -------------------------------------------------------

  async _sendTelegram(message) {
    try {
      const url = `https://api.telegram.org/bot${config.apis.telegram.botToken}/sendMessage`;
      const body = {
        chat_id: config.apis.telegram.alertChatId,
        text: message,
        parse_mode: 'Markdown',
      };

      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        timeout: 10000,
      });

      if (resp.ok) {
        logger.info('[AlertSystem] Telegram alert sent');
      } else {
        const err = await resp.text();
        logger.warn(`[AlertSystem] Telegram error: ${err.slice(0, 200)}`);
      }
    } catch (err) {
      logger.error(`[AlertSystem] Telegram send error: ${err.message}`);
    }
  }

  async _sendWebSocket(launch, scoring, message) {
    try {
      if (!this.io) return;
      this.io.emit('alert', {
        launch,
        scoring,
        message,
        timestamp: Date.now(),
      });
      logger.info('[AlertSystem] WebSocket alert emitted');
    } catch (err) {
      logger.error(`[AlertSystem] WebSocket error: ${err.message}`);
    }
  }

  async _sendTradingWebhook(launch, scoring) {
    try {
      const payload = {
        type: 'PRE_LAUNCH_ALERT',
        launchId: launch.id,
        devWallet: launch.dev_wallet,
        tokenAddress: launch.token_address,
        pumpProbability: scoring.pumpProbability,
        riskScore: scoring.riskScore,
        priority: scoring.entryPriority,
        scores: {
          dev: launch.dev_score,
          onchain: launch.onchain_score,
          social: launch.social_score,
          capital: launch.capital_score,
        },
        timestamp: Date.now(),
      };

      const resp = await fetch(config.trading.webhookUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Secret': config.trading.webhookSecret,
        },
        body: JSON.stringify(payload),
        timeout: 10000,
      });

      if (resp.ok) {
        logger.info('[AlertSystem] Trading webhook sent');
      } else {
        logger.warn(`[AlertSystem] Webhook response: ${resp.status}`);
      }
    } catch (err) {
      logger.error(`[AlertSystem] Webhook error: ${err.message}`);
    }
  }

  // -------------------------------------------------------
  // History
  // -------------------------------------------------------

  getRecentAlerts(limit = 20) {
    return this.db
      .prepare(
        `SELECT a.*, p.token_name, p.token_symbol, p.dev_wallet
         FROM alerts a
         JOIN potential_launches p ON a.launch_id = p.id
         ORDER BY a.sent_at DESC LIMIT ?`
      )
      .all(limit);
  }
}

module.exports = AlertSystem;
