'use strict';

/**
 * integrationModule.js
 * --------------------
 * Connects the prediction engine to external trading bots and execution systems.
 *
 * SECURITY NOTE:
 *   - This module NEVER stores private keys
 *   - All execution is delegated to external bots via signed webhooks
 *   - Entry conditions are validated before signal dispatch
 */

const crypto = require('crypto');
const config = require('../config/config');
const { getDb } = require('../database/db');
const logger = require('../utils/logger');

let fetch;
try {
  fetch = require('node-fetch');
} catch (_) {
  fetch = global.fetch;
}

class IntegrationModule {
  constructor() {
    this.db = null;
    this.pendingExecutions = new Map();
  }

  init() {
    this.db = getDb();
    logger.info('[IntegrationModule] Initialized (execution delegation mode)');
  }

  // -------------------------------------------------------
  // Send trade signal to connected bot
  // -------------------------------------------------------

  async sendTradeSignal(launch, scoring) {
    if (!config.trading.webhookUrl) {
      logger.warn('[IntegrationModule] No trading webhook configured');
      return { sent: false, reason: 'no_webhook' };
    }

    // Validate entry conditions
    const validation = this._validateEntryConditions(launch, scoring);
    if (!validation.valid) {
      logger.info(`[IntegrationModule] Entry blocked: ${validation.reason}`);
      return { sent: false, reason: validation.reason };
    }

    const signal = this._buildSignal(launch, scoring);
    const signature = this._signPayload(signal);

    try {
      const resp = await fetch(config.trading.webhookUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Signature': signature,
          'X-Timestamp': String(Date.now()),
        },
        body: JSON.stringify(signal),
        timeout: 15000,
      });

      const result = { sent: resp.ok, status: resp.status };

      if (resp.ok) {
        const body = await resp.json().catch(() => ({}));
        result.botResponse = body;
        this.pendingExecutions.set(launch.id, {
          signal,
          sentAt: Date.now(),
          status: 'sent',
        });
        logger.info(`[IntegrationModule] Signal sent for ${launch.id.slice(0, 8)}`);
      } else {
        const errText = await resp.text().catch(() => '');
        result.error = errText.slice(0, 200);
        logger.warn(`[IntegrationModule] Signal rejected: ${result.status} - ${result.error}`);
      }

      return result;
    } catch (err) {
      logger.error(`[IntegrationModule] Send signal error: ${err.message}`);
      return { sent: false, reason: err.message };
    }
  }

  // -------------------------------------------------------
  // Entry condition validation
  // -------------------------------------------------------

  _validateEntryConditions(launch, scoring) {
    // Must meet minimum pump probability
    if (scoring.pumpProbability < config.scoring.alertThreshold) {
      return { valid: false, reason: `score_too_low (${scoring.pumpProbability})` };
    }

    // Risk must not be too high for auto-execution
    if (scoring.riskScore > 0.80) {
      return { valid: false, reason: `risk_too_high (${scoring.riskScore})` };
    }

    // Must have on-chain evidence
    if ((launch.onchain_score || 0) < 0.20) {
      return { valid: false, reason: 'insufficient_onchain_evidence' };
    }

    // No duplicate executions within 30 minutes
    const pending = this.pendingExecutions.get(launch.id);
    if (pending && Date.now() - pending.sentAt < 1800000) {
      return { valid: false, reason: 'duplicate_execution_blocked' };
    }

    return { valid: true };
  }

  // -------------------------------------------------------
  // Signal builder
  // -------------------------------------------------------

  _buildSignal(launch, scoring) {
    return {
      type: 'PRE_LAUNCH_ENTRY',
      version: '1.0',
      launchId: launch.id,
      devWallet: launch.dev_wallet,
      tokenAddress: launch.token_address || null,
      prediction: {
        pumpProbability: scoring.pumpProbability,
        riskScore: scoring.riskScore,
        priority: scoring.entryPriority,
        reasoning: scoring.reasoning,
      },
      scores: {
        dev: launch.dev_score,
        onchain: launch.onchain_score,
        social: launch.social_score,
        capital: launch.capital_score,
        similarity: launch.similarity_score,
      },
      suggestedAction: {
        // These are SUGGESTIONS only - the bot decides whether to execute
        action: 'WATCH_AND_BUY_ON_LAUNCH',
        note: 'Buy immediately when liquidity is detected',
        maxSlippagePct: scoring.riskScore > 0.6 ? 5 : 3,
        // Position sizing left to the bot based on its own risk management
      },
      timestamp: Date.now(),
    };
  }

  _signPayload(payload) {
    if (!config.trading.webhookSecret) return 'unsigned';
    const str = JSON.stringify(payload) + config.trading.webhookSecret;
    return crypto.createHash('sha256').update(str).digest('hex');
  }

  // -------------------------------------------------------
  // Status & monitoring
  // -------------------------------------------------------

  getPendingExecutions() {
    return Array.from(this.pendingExecutions.entries()).map(([id, data]) => ({
      launchId: id,
      ...data,
    }));
  }

  confirmExecution(launchId, result) {
    const pending = this.pendingExecutions.get(launchId);
    if (pending) {
      pending.status = 'confirmed';
      pending.result = result;
      pending.confirmedAt = Date.now();
      logger.info(`[IntegrationModule] Execution confirmed for ${launchId.slice(0, 8)}`);
    }
  }
}

module.exports = IntegrationModule;
