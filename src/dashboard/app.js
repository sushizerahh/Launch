'use strict';
/* global io */

// ============================================================
// Predictive Launch Engine - Dashboard Frontend
// ============================================================

const socket = io();
let allLaunches = [];
let alertCount = 0;
let currentFilter = 'pre_launch';

// -------------------------------------------------------
// Socket events
// -------------------------------------------------------

socket.on('connect', () => {
  setStatus(true);
  loadData();
});

socket.on('disconnect', () => setStatus(false));

socket.on('state', (data) => {
  if (data.launches) renderLaunches(data.launches);
  if (data.alerts) data.alerts.forEach(renderAlert);
});

socket.on('alert', (data) => {
  renderAlert(data);
  alertCount++;
  document.getElementById('alert-count').textContent = alertCount;
  // Flash header
  document.querySelector('header').style.boxShadow = '0 0 30px rgba(255,69,69,0.4)';
  setTimeout(() => { document.querySelector('header').style.boxShadow = ''; }, 1500);
});

socket.on('pre_launch', (data) => {
  loadData();
});

// -------------------------------------------------------
// Data loading
// -------------------------------------------------------

async function loadData() {
  try {
    const [launchesRes, statusRes, devsRes, perfRes, alertsRes] = await Promise.all([
      fetch(`/api/launches?status=${currentFilter}&limit=100`),
      fetch('/api/status'),
      fetch('/api/devs'),
      fetch('/api/performance'),
      fetch('/api/alerts'),
    ]);

    const launches = await launchesRes.json();
    const status = await statusRes.json();
    const devs = await devsRes.json();
    const perf = await perfRes.json();
    const alerts = await alertsRes.json();

    allLaunches = launches;
    renderLaunches(launches);
    renderStats(launches, status, perf);
    renderDevs(devs);
    renderPerformance(perf, status);
    renderAlertHistory(alerts);
    updateUptime(status.uptime);
  } catch (err) {
    console.error('Load error:', err);
  }
}

// -------------------------------------------------------
// Renders
// -------------------------------------------------------

function renderLaunches(launches) {
  const tbody = document.getElementById('launches-tbody');
  if (!launches || launches.length === 0) {
    tbody.innerHTML = '<tr><td colspan="11" class="empty-row">No launches detected yet</td></tr>';
    return;
  }

  tbody.innerHTML = launches.map((l) => {
    const score = l.score || 0;
    const priority = scoreToProirity(score);
    const pct = (score * 100).toFixed(1);
    const barWidth = Math.round(score * 80);

    const devPct = ((l.dev_score || 0) * 100).toFixed(0);
    const ocPct = ((l.onchain_score || 0) * 100).toFixed(0);
    const socPct = ((l.social_score || 0) * 100).toFixed(0);
    const capPct = ((l.capital_score || 0) * 100).toFixed(0);

    const wallet = l.dev_wallet
      ? `<span class="wallet-addr" title="${l.dev_wallet}">${l.dev_wallet.slice(0, 8)}...${l.dev_wallet.slice(-4)}</span>`
      : '<span class="wallet-addr">--</span>';

    const tokenName = l.token_name || l.token_symbol
      ? `${l.token_name || ''} ${l.token_symbol ? '(' + l.token_symbol + ')' : ''}`
      : '<span style="color:var(--text-muted)">TBD</span>';

    const detected = timeAgo(l.detected_at);

    const outcome = l.outcome
      ? `<span class="outcome-${l.outcome}">${l.outcome === 'pumped' && l.peak_multiplier ? l.peak_multiplier.toFixed(1) + 'x' : l.outcome}</span>`
      : '<span style="color:var(--text-muted)">--</span>';

    return `
      <tr onclick="showLaunchDetail('${l.id}')" style="cursor:pointer">
        <td>
          <div class="score-bar">
            <div class="score-fill" style="width:${barWidth}px; background:${scoreColor(score)}"></div>
            <span class="score-num" style="color:${scoreColor(score)}">${pct}%</span>
          </div>
        </td>
        <td><span class="priority-badge priority-${priority}">${priority}</span></td>
        <td>${tokenName}</td>
        <td>${wallet}</td>
        <td><span class="sub-score ${subClass(l.dev_score)}">${devPct}%</span></td>
        <td><span class="sub-score ${subClass(l.onchain_score)}">${ocPct}%</span></td>
        <td><span class="sub-score ${subClass(l.social_score)}">${socPct}%</span></td>
        <td><span class="sub-score ${subClass(l.capital_score)}">${capPct}%</span></td>
        <td><span class="status-badge status-${l.status}">${l.status}</span></td>
        <td style="color:var(--text-muted)">${detected}</td>
        <td>${outcome}</td>
      </tr>`;
  }).join('');
}

function renderStats(launches, status, perf) {
  document.getElementById('stat-total').textContent = launches.length;
  const pending = launches.filter((l) => l.status === 'pre_launch').length;
  document.getElementById('stat-pending').textContent = pending;
  const acc = perf.accuracy ? (perf.accuracy * 100).toFixed(1) + '%' : '--';
  document.getElementById('stat-accuracy').textContent = acc;
  const avg = perf.avgPumpMultiplier ? perf.avgPumpMultiplier.toFixed(2) + 'x' : '--';
  document.getElementById('stat-avg-mult').textContent = avg;
}

function renderAlert(data) {
  const feed = document.getElementById('alerts-feed');
  const emptyMsg = feed.querySelector('.empty-msg');
  if (emptyMsg) emptyMsg.remove();

  const scoring = data.scoring || {};
  const launch = data.launch || {};
  const prob = scoring.pumpProbability || launch.score || 0;
  const priority = scoring.entryPriority || scoreToProirity(prob);
  const reasons = scoring.reasoning || [];
  const time = timeAgo(data.timestamp || data.sent_at || Date.now());

  const item = document.createElement('div');
  item.className = `alert-item ${priority}`;
  item.innerHTML = `
    <div class="alert-header">
      <span class="alert-priority priority-badge priority-${priority}">${priority}</span>
      <span class="alert-time">${time}</span>
    </div>
    <div class="alert-score">${(prob * 100).toFixed(1)}%</div>
    <div class="alert-reason">${reasons.slice(0, 2).join(' &bull; ') || 'Pre-launch signal detected'}</div>
  `;

  feed.insertBefore(item, feed.firstChild);
  // Keep only last 20 alerts
  while (feed.children.length > 20) feed.removeChild(feed.lastChild);
}

function renderAlertHistory(alerts) {
  const feed = document.getElementById('alerts-feed');
  if (!alerts || alerts.length === 0) return;
  feed.innerHTML = '';
  alerts.slice(0, 10).forEach((a) => renderAlert({ scoring: { pumpProbability: a.score, entryPriority: scoreToProirity(a.score) }, launch: {}, timestamp: a.sent_at }));
}

function renderDevs(devs) {
  const el = document.getElementById('devs-list');
  if (!devs || devs.length === 0) {
    el.innerHTML = '<p class="empty-msg">No dev history yet</p>';
    return;
  }
  el.innerHTML = devs.map((d) => `
    <div class="dev-item">
      <div>
        <div class="dev-id">${d.id.slice(0, 12)}...</div>
        <div style="color:var(--text-muted);font-size:11px">${d.wallet_count || d.wallet_count_actual || 1} wallet(s)</div>
      </div>
      <div class="dev-stats">
        <div class="dev-winrate">${((d.reliability_score || 0) * 100).toFixed(0)}% win</div>
        <div class="dev-launches">${d.total_launches} launches &bull; ${(d.avg_pump_multiplier || 0).toFixed(1)}x avg</div>
      </div>
    </div>
  `).join('');
}

function renderPerformance(perf, status) {
  const fmt = (v, suffix = '') => v !== undefined && v !== null ? String(v) + suffix : '--';
  document.getElementById('perf-accuracy').textContent = perf.accuracy ? (perf.accuracy * 100).toFixed(1) + '%' : '--';
  document.getElementById('perf-total').textContent = fmt(perf.totalPredictions);
  document.getElementById('perf-resolved').textContent = fmt(perf.resolved);
  document.getElementById('perf-avg-mult').textContent = perf.avgPumpMultiplier ? perf.avgPumpMultiplier.toFixed(2) + 'x' : '--';
  document.getElementById('perf-samples').textContent = fmt(status?.model?.trainingSamples);
  document.getElementById('perf-last-train').textContent = perf.lastRetrained ? timeAgo(perf.lastRetrained) : 'Never';
}

async function showLaunchDetail(id) {
  const res = await fetch(`/api/launches/${id}`);
  const launch = await res.json();

  const modal = document.getElementById('modal-overlay');
  const content = document.getElementById('modal-content');

  const reasons = [];
  if (launch.raw_signals) {
    try {
      const raw = JSON.parse(launch.raw_signals);
      if (raw.events) {
        raw.events.slice(0, 5).forEach((e) => reasons.push(`${e.type}`));
      }
    } catch (_) {}
  }

  content.innerHTML = `
    <h3 style="margin-bottom:16px;color:var(--accent)">${launch.token_name || 'Unknown Token'} ${launch.token_symbol ? '(' + launch.token_symbol + ')' : ''}</h3>
    <div class="perf-panel">
      <div class="perf-row"><span>Pump Probability</span><span>${((launch.score || 0) * 100).toFixed(1)}%</span></div>
      <div class="perf-row"><span>Dev Score</span><span>${((launch.dev_score || 0) * 100).toFixed(0)}%</span></div>
      <div class="perf-row"><span>On-chain Score</span><span>${((launch.onchain_score || 0) * 100).toFixed(0)}%</span></div>
      <div class="perf-row"><span>Social Score</span><span>${((launch.social_score || 0) * 100).toFixed(0)}%</span></div>
      <div class="perf-row"><span>Capital Score</span><span>${((launch.capital_score || 0) * 100).toFixed(0)}%</span></div>
      <div class="perf-row"><span>Dev Wallet</span><span style="font-size:11px">${launch.dev_wallet || '--'}</span></div>
      <div class="perf-row"><span>Token Address</span><span style="font-size:11px">${launch.token_address || 'Not yet minted'}</span></div>
      <div class="perf-row"><span>Status</span><span><span class="status-badge status-${launch.status}">${launch.status}</span></span></div>
      <div class="perf-row"><span>Outcome</span><span class="${launch.outcome ? 'outcome-' + launch.outcome : ''}">${launch.outcome ? (launch.peak_multiplier ? launch.peak_multiplier.toFixed(2) + 'x ' : '') + launch.outcome : 'Pending'}</span></div>
      <div class="perf-row"><span>On-chain Events</span><span>${launch.events?.length || 0}</span></div>
      <div class="perf-row"><span>Social Signals</span><span>${launch.socialSignals?.length || 0}</span></div>
    </div>
    ${reasons.length ? `<div style="margin-top:12px;color:var(--text-muted);font-size:11px">${reasons.map(r => '• ' + r).join('<br>')}</div>` : ''}
    <div style="margin-top:16px;display:flex;gap:8px">
      <button onclick="recordOutcome('${launch.id}')" style="background:var(--accent);border:none;color:#fff;padding:8px 16px;border-radius:6px;cursor:pointer;font-family:inherit">Record Outcome</button>
    </div>
  `;

  modal.classList.remove('hidden');
}

async function recordOutcome(id) {
  const mult = prompt('Enter peak multiplier (e.g. 5.2 for 5.2x):');
  if (!mult) return;
  const tokenAddress = prompt('Token address (optional):') || '';
  const res = await fetch(`/api/launches/${id}/outcome`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ peakMultiplier: parseFloat(mult), tokenAddress }),
  });
  if (res.ok) {
    alert('Outcome recorded! Model will retrain with new data.');
    document.getElementById('modal-overlay').classList.add('hidden');
    loadData();
  }
}

// -------------------------------------------------------
// Helpers
// -------------------------------------------------------

function setStatus(online) {
  const dot = document.getElementById('status-dot');
  const text = document.getElementById('status-text');
  dot.className = `status-dot ${online ? 'online' : 'offline'}`;
  text.textContent = online ? 'Live' : 'Disconnected';
}

function updateUptime(seconds) {
  if (!seconds) return;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  document.getElementById('uptime-display').textContent = `${h}h ${m}m uptime`;
}

function scoreToProirity(score) {
  if (score >= 0.85) return 'HIGH';
  if (score >= 0.70) return 'MEDIUM';
  return 'LOW';
}

function scoreColor(score) {
  if (score >= 0.85) return '#ff4545';
  if (score >= 0.70) return '#ffb800';
  if (score >= 0.50) return '#9945ff';
  return '#7070a0';
}

function subClass(score) {
  if (!score) return 'low';
  if (score >= 0.6) return 'high';
  if (score >= 0.3) return 'medium';
  return 'low';
}

function timeAgo(ts) {
  if (!ts) return '--';
  const diff = Date.now() - ts;
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

// -------------------------------------------------------
// Event listeners
// -------------------------------------------------------

document.querySelectorAll('.filter-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.filter-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    currentFilter = btn.dataset.status;
    loadData();
  });
});

document.getElementById('modal-close').addEventListener('click', () => {
  document.getElementById('modal-overlay').classList.add('hidden');
});

document.getElementById('modal-overlay').addEventListener('click', (e) => {
  if (e.target === document.getElementById('modal-overlay')) {
    document.getElementById('modal-overlay').classList.add('hidden');
  }
});

// Refresh every 30 seconds
setInterval(loadData, 30000);
