'use strict';

/**
 * autoTrader.js
 * -------------
 * Módulo de execução automática de trades.
 *
 * Fluxo:
 *   1. Score alto detectado → adiciona token à watchlist
 *   2. Liquidez confirmada on-chain → compra via Jupiter
 *   3. Monitora preço a cada X segundos
 *   4. Vende automaticamente no Take Profit ou Stop Loss
 *
 * SEGURANÇA:
 *   - Chave privada lida APENAS do .env, nunca gravada no banco
 *   - Máximo de posições simultâneas configurável
 *   - Validações antes de cada trade
 */

const {
  Connection,
  Keypair,
  PublicKey,
  VersionedTransaction,
  LAMPORTS_PER_SOL,
} = require('@solana/web3.js');
const bs58 = require('bs58');
const { EventEmitter } = require('events');
const { v4: uuidv4 } = require('uuid');
const config = require('../config/config');
const { getDb } = require('../database/db');
const logger = require('../utils/logger');

let fetch;
try { fetch = require('node-fetch'); } catch (_) { fetch = global.fetch; }

const JUPITER_QUOTE_URL  = 'https://quote-api.jup.ag/v6/quote';
const JUPITER_SWAP_URL   = 'https://quote-api.jup.ag/v6/swap';
const JUPITER_PRICE_URL  = 'https://api.jup.ag/price/v2';
const SOL_MINT           = 'So11111111111111111111111111111111111111112';

class AutoTrader extends EventEmitter {
  constructor() {
    super();
    this.db         = null;
    this.keypair    = null;
    this.connection = null;
    this.enabled    = false;

    // Mapa de posições abertas: tokenAddress → positionData
    this.positions  = new Map();

    // Watchlist: launchId → { tokenAddress | null, score }
    this.watchlist  = new Map();

    this.priceTimers = new Map();
  }

  // -------------------------------------------------------
  // Inicialização
  // -------------------------------------------------------
  init() {
    this.db = getDb();

    const privateKey = process.env.WALLET_PRIVATE_KEY;
    if (!privateKey) {
      logger.warn('[AutoTrader] WALLET_PRIVATE_KEY não configurada — autotrader DESABILITADO');
      return;
    }

    try {
      this.keypair    = Keypair.fromSecretKey(bs58.decode(privateKey));
      this.connection = new Connection(config.solana.rpcUrl, { commitment: 'confirmed' });
      this.enabled    = true;
      logger.info(`[AutoTrader] Carteira: ${this.keypair.publicKey.toString()}`);
      logger.info(`[AutoTrader] Config: TP=${config.autoTrader.takeProfitMultiplier}x | SL=${config.autoTrader.stopLossPct}% | SOL/trade=${config.autoTrader.solPerTrade}`);
    } catch (err) {
      logger.error(`[AutoTrader] Chave privada inválida: ${err.message}`);
      return;
    }

    this._loadOpenPositions();
    logger.info('[AutoTrader] Inicializado e pronto');
  }

  // -------------------------------------------------------
  // Chamado quando um novo pre-launch é detectado
  // -------------------------------------------------------
  onPreLaunchDetected(launch, scoring) {
    if (!this.enabled) return;
    if (scoring.pumpProbability < config.autoTrader.minScoreToBuy) return;
    if (scoring.riskScore > config.autoTrader.maxRiskScore) {
      logger.info(`[AutoTrader] Score alto mas risco alto (${scoring.riskScore.toFixed(2)}) — ignorando ${launch.id.slice(0,8)}`);
      return;
    }
    if (this.positions.size >= config.autoTrader.maxPositions) {
      logger.warn(`[AutoTrader] Máximo de ${config.autoTrader.maxPositions} posições atingido — ignorando`);
      return;
    }

    logger.info(`[AutoTrader] Adicionando à watchlist: ${launch.id.slice(0,8)} (score=${(scoring.pumpProbability*100).toFixed(1)}%)`);
    this.watchlist.set(launch.id, {
      launchId: launch.id,
      tokenAddress: launch.token_address || null,
      score: scoring.pumpProbability,
      detectedAt: Date.now(),
    });

    // Se o token já tiver endereço (raro mas possível), compra imediatamente
    if (launch.token_address) {
      this._executeBuy(launch.id, launch.token_address, scoring.pumpProbability);
    }
  }

  // -------------------------------------------------------
  // Chamado quando liquidez é confirmada on-chain
  // -------------------------------------------------------
  onLaunchConfirmed(launchId, tokenAddress) {
    if (!this.enabled || !tokenAddress) return;

    const entry = this.watchlist.get(launchId);
    if (!entry) return;

    logger.info(`[AutoTrader] Liquidez detectada para ${tokenAddress.slice(0,8)}... — executando compra`);
    this.watchlist.delete(launchId);

    this._executeBuy(launchId, tokenAddress, entry.score);
  }

  // -------------------------------------------------------
  // Compra: SOL → Token via Jupiter
  // -------------------------------------------------------
  async _executeBuy(launchId, tokenAddress, score) {
    if (this.positions.has(tokenAddress)) return; // já comprou

    const tradeId  = uuidv4();
    const solIn    = config.autoTrader.solPerTrade;
    const lamports = Math.floor(solIn * LAMPORTS_PER_SOL);

    // Registra trade como pending
    this._saveTrade({
      id: tradeId, launchId, tokenAddress,
      status: 'buying', solIn,
      takeProfitTarget: config.autoTrader.takeProfitMultiplier,
      stopLossTarget: config.autoTrader.stopLossPct,
      buyAt: Date.now(),
    });

    logger.info(`[AutoTrader] Comprando ${solIn} SOL de ${tokenAddress.slice(0,8)}...`);

    try {
      // 1. Pega cotação Jupiter
      const quote = await this._getQuote(SOL_MINT, tokenAddress, lamports);
      if (!quote) throw new Error('Sem cotação disponível no Jupiter');

      // 2. Monta transação de swap
      const swapTx = await this._buildSwapTx(quote);
      if (!swapTx) throw new Error('Falha ao montar transação de swap');

      // 3. Assina e envia
      const signature = await this._signAndSend(swapTx);

      // 4. Calcula preço de entrada
      const tokensOut   = parseInt(quote.outAmount) / 1e6; // ajuste para decimais do token
      const buyPriceUsd = solIn / tokensOut;

      this._updateTrade(tradeId, {
        status: 'holding',
        buySignature: signature,
        tokensOut,
        buyPriceUsd,
      });

      const position = {
        tradeId, launchId, tokenAddress,
        solIn, tokensOut,
        buyPriceUsd,
        entryTime: Date.now(),
        highestPrice: buyPriceUsd,
      };
      this.positions.set(tokenAddress, position);

      logger.info(`[AutoTrader] COMPRA OK ✓ | ${solIn} SOL → ${tokensOut.toFixed(2)} tokens | sig: ${signature.slice(0,12)}...`);
      this.emit('bought', { tradeId, tokenAddress, solIn, tokensOut, signature });

      this._sendTelegramTrade('COMPRA', tokenAddress, solIn, tokensOut, signature, score);

      // Inicia monitoramento de preço
      this._startPriceMonitor(tokenAddress);

    } catch (err) {
      logger.error(`[AutoTrader] Erro na compra: ${err.message}`);
      this._updateTrade(tradeId, { status: 'failed', closeReason: err.message });
      this.positions.delete(tokenAddress);
    }
  }

  // -------------------------------------------------------
  // Venda: Token → SOL via Jupiter
  // -------------------------------------------------------
  async _executeSell(tokenAddress, reason) {
    const position = this.positions.get(tokenAddress);
    if (!position) return;

    this._stopPriceMonitor(tokenAddress);
    this.positions.delete(tokenAddress);

    logger.info(`[AutoTrader] Vendendo ${tokenAddress.slice(0,8)}... | motivo: ${reason}`);

    try {
      const tokenLamports = Math.floor(position.tokensOut * 1e6);

      const quote = await this._getQuote(tokenAddress, SOL_MINT, tokenLamports);
      if (!quote) throw new Error('Sem cotação para venda');

      const swapTx   = await this._buildSwapTx(quote);
      const signature = await this._signAndSend(swapTx);

      const solOut  = parseInt(quote.outAmount) / LAMPORTS_PER_SOL;
      const pnlSol  = solOut - position.solIn;
      const pnlPct  = ((solOut / position.solIn) - 1) * 100;

      this._updateTrade(position.tradeId, {
        status: 'closed',
        sellSignature: signature,
        sellPriceUsd: solOut / position.tokensOut,
        pnlSol, pnlPct,
        sellAt: Date.now(),
        closeReason: reason,
      });

      const emoji = pnlSol >= 0 ? '✅' : '❌';
      logger.info(`[AutoTrader] VENDA OK ${emoji} | motivo=${reason} | PnL: ${pnlSol >= 0 ? '+' : ''}${pnlSol.toFixed(4)} SOL (${pnlPct.toFixed(1)}%)`);
      this.emit('sold', { tradeId: position.tradeId, tokenAddress, pnlSol, pnlPct, reason, signature });

      this._sendTelegramTrade('VENDA', tokenAddress, position.solIn, solOut, signature, null, pnlSol, pnlPct, reason);

    } catch (err) {
      logger.error(`[AutoTrader] Erro na venda: ${err.message}`);
      this._updateTrade(position.tradeId, { status: 'sell_failed', closeReason: err.message });
    }
  }

  // -------------------------------------------------------
  // Monitoramento de preço
  // -------------------------------------------------------
  _startPriceMonitor(tokenAddress) {
    const interval = setInterval(async () => {
      await this._checkPrice(tokenAddress);
    }, config.autoTrader.priceCheckIntervalMs);

    this.priceTimers.set(tokenAddress, interval);
  }

  _stopPriceMonitor(tokenAddress) {
    const timer = this.priceTimers.get(tokenAddress);
    if (timer) {
      clearInterval(timer);
      this.priceTimers.delete(tokenAddress);
    }
  }

  async _checkPrice(tokenAddress) {
    const position = this.positions.get(tokenAddress);
    if (!position) { this._stopPriceMonitor(tokenAddress); return; }

    try {
      const price = await this._getTokenPrice(tokenAddress);
      if (!price || price <= 0) return;

      const multiplier = price / position.buyPriceUsd;
      const pnlPct     = (multiplier - 1) * 100;

      // Atualiza high water mark (para trailing stop futuro)
      if (price > position.highestPrice) {
        position.highestPrice = price;
      }

      logger.info(
        `[AutoTrader] ${tokenAddress.slice(0,8)}... | ${multiplier.toFixed(2)}x | PnL: ${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}%`
      );

      // Take Profit
      if (multiplier >= config.autoTrader.takeProfitMultiplier) {
        logger.info(`[AutoTrader] TAKE PROFIT atingido ${multiplier.toFixed(2)}x!`);
        await this._executeSell(tokenAddress, `take_profit_${multiplier.toFixed(2)}x`);
        return;
      }

      // Stop Loss
      if (pnlPct <= -Math.abs(config.autoTrader.stopLossPct)) {
        logger.info(`[AutoTrader] STOP LOSS atingido ${pnlPct.toFixed(1)}%`);
        await this._executeSell(tokenAddress, `stop_loss_${pnlPct.toFixed(1)}pct`);
        return;
      }

      // Timeout máximo (evita ficar preso em token morto)
      const holdingMs = Date.now() - position.entryTime;
      if (holdingMs > config.autoTrader.maxHoldingMs) {
        logger.info(`[AutoTrader] Timeout de posição atingido (${(holdingMs/60000).toFixed(0)}min)`);
        await this._executeSell(tokenAddress, 'max_hold_timeout');
      }

    } catch (err) {
      logger.warn(`[AutoTrader] Erro ao checar preço: ${err.message}`);
    }
  }

  // -------------------------------------------------------
  // Jupiter API helpers
  // -------------------------------------------------------
  async _getQuote(inputMint, outputMint, amount) {
    try {
      const slippage = config.autoTrader.slippageBps;
      const url = `${JUPITER_QUOTE_URL}?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=${slippage}&onlyDirectRoutes=false`;
      const res = await fetch(url, { timeout: 10000 });
      if (!res.ok) return null;
      return await res.json();
    } catch (err) {
      logger.error(`[AutoTrader] getQuote error: ${err.message}`);
      return null;
    }
  }

  async _buildSwapTx(quoteResponse) {
    try {
      const body = {
        quoteResponse,
        userPublicKey: this.keypair.publicKey.toString(),
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
        prioritizationFeeLamports: config.autoTrader.priorityFeeLamports,
      };
      const res = await fetch(JUPITER_SWAP_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        timeout: 15000,
      });
      if (!res.ok) return null;
      const data = await res.json();
      return data.swapTransaction;
    } catch (err) {
      logger.error(`[AutoTrader] buildSwapTx error: ${err.message}`);
      return null;
    }
  }

  async _signAndSend(swapTransactionBase64) {
    const txBuf = Buffer.from(swapTransactionBase64, 'base64');
    const tx    = VersionedTransaction.deserialize(txBuf);
    tx.sign([this.keypair]);

    const signature = await this.connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: false,
      maxRetries: 3,
    });

    // Aguarda confirmação
    await this.connection.confirmTransaction(signature, 'confirmed');
    return signature;
  }

  async _getTokenPrice(tokenAddress) {
    try {
      const url = `${JUPITER_PRICE_URL}?ids=${tokenAddress}&vsToken=${SOL_MINT}`;
      const res = await fetch(url, { timeout: 8000 });
      if (!res.ok) return null;
      const data = await res.json();
      return data?.data?.[tokenAddress]?.price || null;
    } catch (_) {
      return null;
    }
  }

  // -------------------------------------------------------
  // Alertas Telegram para trades
  // -------------------------------------------------------
  async _sendTelegramTrade(tipo, tokenAddress, solIn, solOrTokens, signature, score, pnlSol, pnlPct, reason) {
    if (!config.apis.telegram.botToken || !config.apis.telegram.alertChatId) return;

    let msg;
    if (tipo === 'COMPRA') {
      const pct = score ? `(score ${(score*100).toFixed(0)}%)` : '';
      msg = `🟢 COMPRA EXECUTADA ${pct}\n\nToken: \`${tokenAddress.slice(0,20)}...\`\nSOL gasto: ${solIn} SOL\nTokens recebidos: ${Number(solOrTokens).toFixed(2)}\nTx: \`${signature.slice(0,20)}...\`\n\nTP: ${config.autoTrader.takeProfitMultiplier}x | SL: -${config.autoTrader.stopLossPct}%`;
    } else {
      const emoji = pnlSol >= 0 ? '✅' : '❌';
      msg = `${emoji} VENDA EXECUTADA\n\nToken: \`${tokenAddress.slice(0,20)}...\`\nMotivo: ${reason}\nPnL: ${pnlSol >= 0 ? '+' : ''}${Number(pnlSol).toFixed(4)} SOL (${Number(pnlPct).toFixed(1)}%)\nTx: \`${signature.slice(0,20)}...\``;
    }

    try {
      await fetch(`https://api.telegram.org/bot${config.apis.telegram.botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: config.apis.telegram.alertChatId,
          text: msg,
          parse_mode: 'Markdown',
        }),
        timeout: 8000,
      });
    } catch (_) {}
  }

  // -------------------------------------------------------
  // Banco de dados
  // -------------------------------------------------------
  _saveTrade(trade) {
    this.db.prepare(`
      INSERT OR IGNORE INTO trades
        (id, launch_id, token_address, status, sol_in, take_profit_target, stop_loss_target, buy_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      trade.id, trade.launchId, trade.tokenAddress, trade.status,
      trade.solIn, trade.takeProfitTarget, trade.stopLossTarget, trade.buyAt
    );
  }

  _updateTrade(tradeId, fields) {
    const allowed = ['status','buy_signature','sell_signature','tokens_out','buy_price_usd',
                     'sell_price_usd','sell_at','pnl_sol','pnl_pct','close_reason'];
    const map = {
      status:'status', buySignature:'buy_signature', sellSignature:'sell_signature',
      tokensOut:'tokens_out', buyPriceUsd:'buy_price_usd', sellPriceUsd:'sell_price_usd',
      sellAt:'sell_at', pnlSol:'pnl_sol', pnlPct:'pnl_pct', closeReason:'close_reason',
    };
    const sets = [], vals = [];
    for (const [k, v] of Object.entries(fields)) {
      const col = map[k];
      if (col && allowed.includes(col)) { sets.push(`${col} = ?`); vals.push(v); }
    }
    if (!sets.length) return;
    vals.push(tradeId);
    this.db.prepare(`UPDATE trades SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }

  _loadOpenPositions() {
    try {
      const open = this.db.prepare(
        `SELECT * FROM trades WHERE status IN ('holding', 'buying')`
      ).all();
      for (const t of open) {
        if (t.token_address && t.tokens_out && t.buy_price_usd) {
          this.positions.set(t.token_address, {
            tradeId: t.id, launchId: t.launch_id,
            tokenAddress: t.token_address,
            solIn: t.sol_in, tokensOut: t.tokens_out,
            buyPriceUsd: t.buy_price_usd,
            entryTime: t.buy_at || Date.now(),
            highestPrice: t.buy_price_usd,
          });
          this._startPriceMonitor(t.token_address);
          logger.info(`[AutoTrader] Posição recarregada: ${t.token_address.slice(0,8)}...`);
        }
      }
    } catch (_) {}
  }

  // -------------------------------------------------------
  // Venda manual via API
  // -------------------------------------------------------
  async manualSell(tokenAddress) {
    if (!this.positions.has(tokenAddress)) {
      return { ok: false, error: 'Posição não encontrada' };
    }
    await this._executeSell(tokenAddress, 'manual');
    return { ok: true };
  }

  getOpenPositions() {
    return Array.from(this.positions.values());
  }

  getTradeHistory(limit = 50) {
    return this.db.prepare(
      `SELECT * FROM trades ORDER BY buy_at DESC LIMIT ?`
    ).all(limit);
  }

  getTradePnL() {
    return this.db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN pnl_sol > 0 THEN 1 ELSE 0 END) as wins,
        SUM(CASE WHEN pnl_sol <= 0 THEN 1 ELSE 0 END) as losses,
        COALESCE(SUM(pnl_sol), 0) as total_pnl_sol,
        COALESCE(AVG(pnl_pct), 0) as avg_pnl_pct
      FROM trades WHERE status = 'closed'
    `).get();
  }
}

module.exports = AutoTrader;
