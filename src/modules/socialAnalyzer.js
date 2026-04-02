'use strict';

/**
 * socialAnalyzer.js
 * -----------------
 * Monitors Twitter/X and Telegram for pre-launch social signals:
 *  - New account creation around token keywords
 *  - Unusual mention growth
 *  - Sentiment analysis
 *  - Coordinated hype detection
 */

const { EventEmitter } = require('events');
const Sentiment = require('sentiment');
const config = require('../config/config');
const { getDb } = require('../database/db');
const logger = require('../utils/logger');

// Safe fetch import for Node.js
let fetch;
try {
  fetch = require('node-fetch');
} catch (_) {
  fetch = global.fetch;
}

class SocialAnalyzer extends EventEmitter {
  constructor() {
    super();
    this.db = null;
    this.sentiment = new Sentiment();
    this.mentionHistory = new Map(); // keyword -> [{ timestamp, count }]
    this.pollingIntervals = [];
    this.running = false;
  }

  init() {
    this.db = getDb();
    logger.info('[SocialAnalyzer] Initialized');
  }

  start() {
    this.running = true;

    // Poll Twitter every 60 seconds
    if (config.apis.twitter.bearerToken) {
      const twInterval = setInterval(() => this._pollTwitter(), 60000);
      this.pollingIntervals.push(twInterval);
      this._pollTwitter();
    } else {
      logger.warn('[SocialAnalyzer] Twitter bearer token not set - skipping');
    }

    // Telegram is event-driven via bot webhook
    if (config.apis.telegram.botToken) {
      this._startTelegramPolling();
    }

    logger.info('[SocialAnalyzer] Social monitoring started');
  }

  stop() {
    this.running = false;
    for (const interval of this.pollingIntervals) {
      clearInterval(interval);
    }
    this.pollingIntervals = [];
    logger.info('[SocialAnalyzer] Stopped');
  }

  // -------------------------------------------------------
  // Twitter / X monitoring
  // -------------------------------------------------------
  async _pollTwitter() {
    if (!this.running) return;

    const keywords = this._getActiveKeywords();
    for (const keyword of keywords) {
      await this._searchTwitter(keyword);
      await this._sleep(2000); // Rate limit courtesy
    }
  }

  async _searchTwitter(keyword) {
    try {
      const query = encodeURIComponent(
        `${keyword} (solana OR sol OR memecoin OR pump) -is:retweet lang:en`
      );
      const url = `https://api.twitter.com/2/tweets/search/recent?query=${query}&max_results=20&tweet.fields=created_at,author_id,public_metrics&expansions=author_id&user.fields=created_at,public_metrics`;

      const resp = await fetch(url, {
        headers: {
          Authorization: `Bearer ${config.apis.twitter.bearerToken}`,
        },
        timeout: 10000,
      });

      if (!resp.ok) {
        if (resp.status === 429) {
          logger.warn('[SocialAnalyzer] Twitter rate limit hit');
        }
        return;
      }

      const data = await resp.json();
      if (!data.data) return;

      await this._processTweets(keyword, data.data, data.includes?.users || []);
    } catch (err) {
      logger.error(`[SocialAnalyzer] Twitter search error: ${err.message}`);
    }
  }

  async _processTweets(keyword, tweets, users) {
    const now = Date.now();
    const userMap = {};
    for (const u of users) userMap[u.id] = u;

    let totalSentiment = 0;
    let newAccountCount = 0;

    for (const tweet of tweets) {
      const sentResult = this.sentiment.analyze(tweet.text);
      totalSentiment += sentResult.comparative;

      const author = userMap[tweet.author_id];
      if (author) {
        const accountAge = now - new Date(author.created_at).getTime();
        const isNewAccount = accountAge < 30 * 24 * 3600 * 1000; // < 30 days
        if (isNewAccount) newAccountCount++;
      }

      this.db
        .prepare(
          `INSERT INTO social_signals
           (timestamp, platform, signal_type, content, author, sentiment)
           VALUES (?, 'twitter', 'mention', ?, ?, ?)`
        )
        .run(now, tweet.text.slice(0, 500), tweet.author_id, sentResult.comparative);
    }

    const avgSentiment = tweets.length ? totalSentiment / tweets.length : 0;
    const newAccountRatio = tweets.length ? newAccountCount / tweets.length : 0;

    // Update mention history
    const hist = this.mentionHistory.get(keyword) || [];
    hist.push({ timestamp: now, count: tweets.length });
    // Keep last 48 data points
    if (hist.length > 48) hist.shift();
    this.mentionHistory.set(keyword, hist);

    // Detect abnormal growth
    const growthRate = this._computeGrowthRate(keyword);
    if (growthRate >= config.social.growthRateThreshold) {
      const signal = {
        keyword,
        platform: 'twitter',
        mentionCount: tweets.length,
        growthRate,
        avgSentiment,
        newAccountRatio,
        timestamp: now,
      };
      logger.info(
        `[SocialAnalyzer] HYPE DETECTED: "${keyword}" ${growthRate.toFixed(1)}x growth, ` +
        `sentiment: ${avgSentiment.toFixed(2)}`
      );
      this.emit('hype_detected', signal);
    }
  }

  // -------------------------------------------------------
  // Telegram monitoring (long-polling)
  // -------------------------------------------------------
  _startTelegramPolling() {
    let offset = 0;

    const poll = async () => {
      if (!this.running) return;
      try {
        const url = `https://api.telegram.org/bot${config.apis.telegram.botToken}/getUpdates?offset=${offset}&timeout=30`;
        const resp = await fetch(url, { timeout: 35000 });
        if (!resp.ok) {
          await this._sleep(5000);
          setTimeout(poll, 0);
          return;
        }
        const data = await resp.json();
        if (data.result) {
          for (const update of data.result) {
            offset = update.update_id + 1;
            await this._processTelegramUpdate(update);
          }
        }
      } catch (err) {
        logger.error(`[SocialAnalyzer] Telegram polling error: ${err.message}`);
        await this._sleep(10000);
      }
      setTimeout(poll, 1000);
    };

    setTimeout(poll, 2000);
    logger.info('[SocialAnalyzer] Telegram polling started');
  }

  async _processTelegramUpdate(update) {
    const msg = update.message || update.channel_post;
    if (!msg || !msg.text) return;

    const text = msg.text;
    const now = Date.now();
    const sentResult = this.sentiment.analyze(text);

    // Check if this message mentions any tracked keywords
    const keywords = this._getActiveKeywords();
    const matched = keywords.filter((kw) =>
      text.toLowerCase().includes(kw.toLowerCase())
    );

    if (matched.length === 0) return;

    this.db
      .prepare(
        `INSERT INTO social_signals
         (timestamp, platform, signal_type, content, author, sentiment)
         VALUES (?, 'telegram', 'message', ?, ?, ?)`
      )
      .run(now, text.slice(0, 500), String(msg.from?.id || msg.chat?.id || ''), sentResult.comparative);

    for (const kw of matched) {
      const hist = this.mentionHistory.get(kw) || [];
      hist.push({ timestamp: now, count: 1 });
      if (hist.length > 200) hist.shift();
      this.mentionHistory.set(kw, hist);
    }
  }

  // -------------------------------------------------------
  // Scoring helpers
  // -------------------------------------------------------

  getSocialScore(keyword, launchId) {
    if (!keyword) return 0.05;

    const recentSignals = this.db
      .prepare(
        `SELECT COUNT(*) as cnt, AVG(sentiment) as avg_sentiment
         FROM social_signals
         WHERE content LIKE ? AND timestamp > ?`
      )
      .get(`%${keyword}%`, Date.now() - config.social.lookbackHours * 3600000);

    if (!recentSignals || recentSignals.cnt < config.social.minMentions) {
      return 0.05;
    }

    const mentionScore = Math.min(recentSignals.cnt / 100, 0.4);
    const sentimentScore = Math.max(0, (recentSignals.avg_sentiment + 5) / 10) * 0.3;
    const growthScore = Math.min(this._computeGrowthRate(keyword) / 10, 0.3);

    return Math.min(mentionScore + sentimentScore + growthScore, 1.0);
  }

  _computeGrowthRate(keyword) {
    const hist = this.mentionHistory.get(keyword) || [];
    if (hist.length < 2) return 1.0;

    const recent = hist.slice(-3).reduce((s, h) => s + h.count, 0);
    const older = hist.slice(-6, -3).reduce((s, h) => s + h.count, 0) || 1;

    return recent / older;
  }

  _getActiveKeywords() {
    // Pull keywords from recently detected potential launches
    try {
      const launches = this.db
        .prepare(
          `SELECT token_name, token_symbol FROM potential_launches
           WHERE status IN ('pending', 'pre_launch') AND detected_at > ?`
        )
        .all(Date.now() - 48 * 3600000);

      const kws = new Set(['solana', 'sol memecoin', 'pump.fun']);
      for (const l of launches) {
        if (l.token_name) kws.add(l.token_name);
        if (l.token_symbol) kws.add(l.token_symbol);
      }
      return Array.from(kws);
    } catch (_) {
      return ['solana', 'memecoin', 'pump'];
    }
  }

  addKeyword(keyword) {
    const hist = this.mentionHistory.get(keyword) || [];
    this.mentionHistory.set(keyword, hist);
  }

  _sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }
}

module.exports = SocialAnalyzer;
