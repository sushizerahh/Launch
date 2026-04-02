'use strict';

/**
 * onchainScanner.js
 * -----------------
 * Monitors Solana blockchain in real-time for pre-launch signals:
 *  - New wallets receiving SOL
 *  - Wallets interacting with DEX programs
 *  - Repeated contract creation patterns
 *  - Suspicious fund movements
 */

const { Connection, PublicKey, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const { EventEmitter } = require('events');
const config = require('../config/config');
const { getDb } = require('../database/db');
const logger = require('../utils/logger');

class OnchainScanner extends EventEmitter {
  constructor() {
    super();
    this.connection = new Connection(config.solana.rpcUrl, {
      commitment: config.solana.commitment,
      wsEndpoint: config.solana.wsUrl,
    });
    this.subscriptions = new Map();
    this.walletCache = new Map();
    this.running = false;
    this.db = null;

    // Program IDs to watch
    this.watchedPrograms = [
      config.solana.programs.pumpFun,
      config.solana.programs.raydiumLiquidity,
      config.solana.programs.raydiumAmm,
      config.solana.programs.tokenProgram,
      config.solana.programs.orca,
      config.solana.programs.meteoraDlmm,
    ];
  }

  async start() {
    this.db = getDb();
    this.running = true;
    logger.info('[OnchainScanner] Starting on-chain monitoring...');

    await this._subscribeToPrograms();
    await this._startPollingFallback();

    logger.info('[OnchainScanner] Active and monitoring Solana mainnet');
  }

  stop() {
    this.running = false;
    for (const [id, sub] of this.subscriptions) {
      this.connection.removeAccountChangeListener(id).catch(() => {});
      logger.info(`[OnchainScanner] Removed subscription ${id}`);
    }
    this.subscriptions.clear();
    logger.info('[OnchainScanner] Stopped');
  }

  // -------------------------------------------------------
  // Subscribe to program logs via WebSocket
  // -------------------------------------------------------
  async _subscribeToPrograms() {
    for (const programId of this.watchedPrograms) {
      try {
        const pubkey = new PublicKey(programId);
        const subId = this.connection.onLogs(
          pubkey,
          (logs) => this._handleProgramLogs(programId, logs),
          'confirmed'
        );
        this.subscriptions.set(subId, programId);
        logger.info(`[OnchainScanner] Subscribed to program: ${programId.slice(0, 8)}...`);
      } catch (err) {
        logger.warn(`[OnchainScanner] Failed to subscribe to ${programId}: ${err.message}`);
      }
    }
  }

  // -------------------------------------------------------
  // Polling fallback for RPC providers without WS
  // -------------------------------------------------------
  async _startPollingFallback() {
    const poll = async () => {
      if (!this.running) return;
      try {
        await this._scanRecentTransactions();
      } catch (err) {
        logger.error(`[OnchainScanner] Polling error: ${err.message}`);
      }
      setTimeout(poll, config.scanning.intervalMs);
    };

    // Start after short delay to let WS connect
    setTimeout(poll, 3000);
  }

  // -------------------------------------------------------
  // Handle incoming program logs
  // -------------------------------------------------------
  _handleProgramLogs(programId, logs) {
    if (!logs || logs.err) return;

    const { signature, logs: logMessages } = logs;
    const now = Date.now();

    // Detect token mint creation
    const isMint = logMessages.some(
      (l) =>
        l.includes('InitializeMint') ||
        l.includes('MintTo') ||
        l.includes('create_associated_token_account')
    );

    // Detect liquidity addition
    const isLiquidity = logMessages.some(
      (l) =>
        l.includes('initialize2') ||
        l.includes('addLiquidity') ||
        l.includes('InitializePool') ||
        l.includes('createPool')
    );

    // Detect pump.fun launch
    const isPumpFun =
      programId === config.solana.programs.pumpFun &&
      logMessages.some((l) => l.includes('create') || l.includes('initialize'));

    if (isMint || isLiquidity || isPumpFun) {
      const event = {
        type: isPumpFun ? 'pump_fun_launch' : isLiquidity ? 'liquidity_add' : 'token_mint',
        programId,
        signature,
        timestamp: now,
        logs: logMessages,
      };

      this._recordEvent(event);
      this.emit('event', event);

      if (isLiquidity || isPumpFun) {
        logger.info(`[OnchainScanner] LAUNCH DETECTED - ${event.type} | sig: ${signature.slice(0, 12)}...`);
        this.emit('launch_detected', event);
      }
    }
  }

  // -------------------------------------------------------
  // Scan recent transactions for suspicious patterns
  // -------------------------------------------------------
  async _scanRecentTransactions() {
    for (const programId of this.watchedPrograms.slice(0, 2)) {
      try {
        const pubkey = new PublicKey(programId);
        const sigs = await this.connection.getSignaturesForAddress(pubkey, {
          limit: 20,
        });

        for (const sigInfo of sigs) {
          if (sigInfo.err) continue;
          await this._analyzeTransaction(sigInfo.signature, programId);
        }
      } catch (err) {
        // Rate limit or network error - skip silently
      }
    }
  }

  async _analyzeTransaction(signature, programId) {
    try {
      const tx = await this.connection.getParsedTransaction(signature, {
        maxSupportedTransactionVersion: 0,
      });

      if (!tx || !tx.meta) return;

      const accounts = tx.transaction.message.accountKeys || [];
      const preBalances = tx.meta.preBalances || [];
      const postBalances = tx.meta.postBalances || [];

      for (let i = 0; i < accounts.length; i++) {
        const address = accounts[i].pubkey?.toString();
        if (!address) continue;

        const pre = preBalances[i] / LAMPORTS_PER_SOL;
        const post = postBalances[i] / LAMPORTS_PER_SOL;
        const delta = post - pre;

        // New wallet receiving SOL
        if (pre === 0 && delta > 0) {
          await this._flagNewWallet(address, delta, signature, tx.blockTime);
        }

        // Wallet accumulating significant SOL
        if (
          delta >= config.scanning.suspiciousTransferMin &&
          delta <= config.scanning.suspiciousTransferMax
        ) {
          await this._updateWalletActivity(address, delta, programId, signature);
        }
      }
    } catch (err) {
      // Parsing errors are common for complex txs - ignore
    }
  }

  // -------------------------------------------------------
  // Wallet tracking
  // -------------------------------------------------------
  async _flagNewWallet(address, solReceived, signature, blockTime) {
    const now = blockTime ? blockTime * 1000 : Date.now();

    try {
      this.db
        .prepare(
          `INSERT OR IGNORE INTO wallets
           (address, first_seen, last_seen, sol_received)
           VALUES (?, ?, ?, ?)`
        )
        .run(address, now, now, solReceived);

      this._recordEvent({
        type: 'new_wallet',
        wallet: address,
        signature,
        amount: solReceived,
        timestamp: now,
      });

      this.emit('new_wallet', { address, solReceived, timestamp: now });
    } catch (err) {
      logger.error(`[OnchainScanner] _flagNewWallet error: ${err.message}`);
    }
  }

  async _updateWalletActivity(address, delta, programId, signature) {
    const now = Date.now();
    const cached = this.walletCache.get(address) || { interactions: 0 };
    cached.interactions += 1;
    cached.lastSeen = now;
    this.walletCache.set(address, cached);

    try {
      this.db
        .prepare(
          `INSERT INTO wallets (address, first_seen, last_seen, sol_received, dex_interactions)
           VALUES (?, ?, ?, ?, 1)
           ON CONFLICT(address) DO UPDATE SET
             last_seen = excluded.last_seen,
             sol_received = sol_received + excluded.sol_received,
             dex_interactions = dex_interactions + 1`
        )
        .run(address, now, now, Math.max(delta, 0));

      // Check if this wallet crossed the suspicious threshold
      const wallet = this.db
        .prepare('SELECT * FROM wallets WHERE address = ?')
        .get(address);

      if (wallet && wallet.dex_interactions >= config.scanning.minDexInteractions) {
        this.emit('suspicious_wallet', { wallet, programId, signature });
      }

      this._recordEvent({
        type: 'wallet_dex_interaction',
        wallet: address,
        programId,
        signature,
        amount: delta,
        timestamp: now,
      });
    } catch (err) {
      logger.error(`[OnchainScanner] _updateWalletActivity error: ${err.message}`);
    }
  }

  _recordEvent(event) {
    try {
      this.db
        .prepare(
          `INSERT OR IGNORE INTO onchain_events
           (timestamp, event_type, wallet, program_id, signature, amount, raw_data)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          event.timestamp || Date.now(),
          event.type,
          event.wallet || null,
          event.programId || null,
          event.signature || null,
          event.amount || null,
          JSON.stringify(event)
        );
    } catch (_) {}
  }

  // -------------------------------------------------------
  // Public helpers
  // -------------------------------------------------------
  async getWalletHistory(address) {
    try {
      const pubkey = new PublicKey(address);
      const sigs = await this.connection.getSignaturesForAddress(pubkey, {
        limit: config.scanning.walletHistoryDepth,
      });
      return sigs.filter((s) => !s.err);
    } catch (err) {
      logger.warn(`[OnchainScanner] getWalletHistory failed: ${err.message}`);
      return [];
    }
  }

  async getTokenInfo(mintAddress) {
    try {
      const pubkey = new PublicKey(mintAddress);
      const info = await this.connection.getParsedAccountInfo(pubkey);
      return info?.value?.data?.parsed?.info || null;
    } catch (err) {
      return null;
    }
  }

  getSuspiciousWallets(limit = 50) {
    return this.db
      .prepare(
        `SELECT * FROM wallets
         WHERE dex_interactions >= ? OR sol_received >= ?
         ORDER BY last_seen DESC LIMIT ?`
      )
      .all(config.scanning.minDexInteractions, config.scanning.suspiciousTransferMin, limit);
  }
}

module.exports = OnchainScanner;
