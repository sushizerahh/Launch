'use strict';

require('dotenv').config();

const config = {
  solana: {
    rpcUrl: process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com',
    wsUrl: process.env.SOLANA_WS_URL || 'wss://api.mainnet-beta.solana.com',
    commitment: 'confirmed',
    // Known DEX program IDs on Solana
    programs: {
      pumpFun: process.env.PUMP_FUN_PROGRAM_ID || '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
      raydiumLiquidity: process.env.RAYDIUM_LIQUIDITY_PROGRAM_ID || '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',
      raydiumAmm: process.env.RAYDIUM_AMM_PROGRAM_ID || '5quBtoiQqxF9Jv6KYKctB59NT3gtJD2Y65kdnB1Uev3h',
      tokenProgram: process.env.TOKEN_PROGRAM_ID || 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
      orca: 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc',
      meteoraDlmm: 'LBUZKhRxPF3XUpBCjp4YzTKgLLjoogf3sMeN3dpKCNn',
    },
  },

  apis: {
    helius: {
      key: process.env.HELIUS_API_KEY || '',
      baseUrl: 'https://api.helius.xyz/v0',
    },
    birdeye: {
      key: process.env.BIRDEYE_API_KEY || '',
      baseUrl: 'https://public-api.birdeye.so',
    },
    twitter: {
      bearerToken: process.env.TWITTER_BEARER_TOKEN || '',
      apiKey: process.env.TWITTER_API_KEY || '',
      apiSecret: process.env.TWITTER_API_SECRET || '',
      accessToken: process.env.TWITTER_ACCESS_TOKEN || '',
      accessSecret: process.env.TWITTER_ACCESS_SECRET || '',
    },
    telegram: {
      botToken: process.env.TELEGRAM_BOT_TOKEN || '',
      alertChatId: process.env.TELEGRAM_ALERT_CHAT_ID || '',
    },
  },

  database: {
    path: process.env.DB_PATH || './data/launch_engine.db',
  },

  server: {
    port: parseInt(process.env.PORT || '3000', 10),
    secret: process.env.DASHBOARD_SECRET || 'change-me',
  },

  scoring: {
    alertThreshold: parseFloat(process.env.ALERT_SCORE_THRESHOLD || '0.70'),
    highPriorityThreshold: parseFloat(process.env.HIGH_PRIORITY_THRESHOLD || '0.85'),
    weights: {
      devScore: 0.30,
      onchainActivity: 0.25,
      socialSignals: 0.20,
      capitalPattern: 0.15,
      launchSimilarity: 0.10,
    },
  },

  scanning: {
    intervalMs: parseInt(process.env.SCAN_INTERVAL_MS || '5000', 10),
    walletHistoryDepth: 50,
    // SOL amounts that trigger detection
    suspiciousTransferMin: 0.5,
    suspiciousTransferMax: 50,
    // Min interactions before flagging a wallet
    minDexInteractions: 2,
  },

  social: {
    // How far back to look for mentions (hours)
    lookbackHours: 24,
    // Minimum mentions to be significant
    minMentions: 5,
    // Growth rate threshold (x times in interval)
    growthRateThreshold: 3.0,
  },

  trading: {
    webhookUrl: process.env.TRADING_BOT_WEBHOOK_URL || '',
    webhookSecret: process.env.TRADING_BOT_SECRET || '',
  },

  autoTrader: {
    // Habilita/desabilita — só funciona se WALLET_PRIVATE_KEY estiver no .env
    enabled: process.env.AUTO_TRADER_ENABLED === 'true',
    // Score mínimo para entrar em uma trade (0-1)
    minScoreToBuy: parseFloat(process.env.AUTO_TRADE_MIN_SCORE || '0.80'),
    // Risco máximo permitido (0-1)
    maxRiskScore: parseFloat(process.env.AUTO_TRADE_MAX_RISK || '0.65'),
    // SOL por trade (ex: 0.1 = 0.1 SOL)
    solPerTrade: parseFloat(process.env.AUTO_TRADE_SOL_AMOUNT || '0.1'),
    // Multiplicador para Take Profit (ex: 2 = vende quando dobrar)
    takeProfitMultiplier: parseFloat(process.env.AUTO_TRADE_TAKE_PROFIT || '2.0'),
    // Percentual de Stop Loss (ex: 30 = vende se cair 30%)
    stopLossPct: parseFloat(process.env.AUTO_TRADE_STOP_LOSS_PCT || '30'),
    // Máximo de posições abertas ao mesmo tempo
    maxPositions: parseInt(process.env.AUTO_TRADE_MAX_POSITIONS || '3', 10),
    // Slippage em bps (500 = 5%)
    slippageBps: parseInt(process.env.AUTO_TRADE_SLIPPAGE_BPS || '500', 10),
    // Priority fee para a transação (lamports)
    priorityFeeLamports: parseInt(process.env.AUTO_TRADE_PRIORITY_FEE || '100000', 10),
    // Intervalo de checagem de preço (ms)
    priceCheckIntervalMs: parseInt(process.env.AUTO_TRADE_PRICE_INTERVAL_MS || '10000', 10),
    // Tempo máximo segurando um token antes de forçar venda (ms) — padrão 30min
    maxHoldingMs: parseInt(process.env.AUTO_TRADE_MAX_HOLD_MS || '1800000', 10),
  },

  model: {
    path: './models/scoring_model.json',
    minTrainingSamples: 50,
    retrainIntervalHours: 24,
  },
};

module.exports = config;
