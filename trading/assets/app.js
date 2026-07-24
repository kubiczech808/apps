const state = {
  mode: "paper",
  botState: null,
  liveState: null,
  evaluationSort: {
    key: "annualizedReturn",
    direction: "desc",
  },
  tradeSort: {
    open: {
      key: "openedAt",
      direction: "desc",
    },
    closed: {
      key: "resolvedAt",
      direction: "desc",
    },
    live: {
      key: "openedAt",
      direction: "desc",
    },
    liveClosed: {
      key: "resolvedAt",
      direction: "desc",
    },
  },
  evaluationStatus: "ELIGIBLE",
  eligibilityThreshold: null,
  eligibilityThresholdKey: "",
  riskAllocation: null,
  riskAllocationKey: "",
  limitOrders: null,
  limitOrdersKey: "",
  liveExecutionArmed: false,
  liveExecutionState: null,
  executionBusy: null,
  autoLiveSyncBusy: false,
};

const ELIGIBILITY_THRESHOLD_STORAGE_KEY = "tradingEligibilityProbabilityThreshold";
const RISK_ALLOCATION_STORAGE_KEY = "tradingRiskAllocationFraction";
const LIMIT_ORDERS_STORAGE_KEY = "tradingUseLimitOrders";
const MODE_STORAGE_KEY = "tradingDashboardMode";
const LIVE_EXECUTION_STORAGE_KEY = "tradingLiveExecutionArmed";
const DEFAULT_ELIGIBILITY_THRESHOLD = 0.95;
const MIN_ELIGIBILITY_THRESHOLD = 0.01;
const MAX_ELIGIBILITY_THRESHOLD = 0.99;
const DEFAULT_RISK_ALLOCATION = 0.05;
const MIN_RISK_ALLOCATION = 0.01;
const MAX_RISK_ALLOCATION = 0.5;
const LIVE_STATE_REFRESH_MS = 15000;
const LIVE_SYNC_REQUEST_MS = 30000;

const els = {
  botAction: document.querySelector("[data-bot-action]"),
  botInlineAction: document.querySelector("[data-bot-inline-action]"),
  portfolioTitle: document.querySelector("[data-portfolio-title]"),
  primaryPanelTitle: document.querySelector("[data-primary-panel-title]"),
  secondaryPanelTitle: document.querySelector("[data-secondary-panel-title]"),
  botStatus: document.querySelector("[data-bot-status]"),
  accountSummary: document.querySelector("[data-account-summary]"),
  botTrades: document.querySelector("[data-bot-trades]"),
  closedTrades: document.querySelector("[data-closed-trades]"),
  closedSummary: document.querySelector("[data-closed-summary]"),
  botEvaluations: document.querySelector("[data-bot-evaluations]"),
  evaluationSummary: document.querySelector("[data-evaluation-summary]"),
  runLog: document.querySelector("[data-run-log]"),
  runLogSummary: document.querySelector("[data-run-log-summary]"),
  eligibilityThreshold: document.querySelector("[data-eligibility-threshold]"),
  eligibilityThresholdLabel: document.querySelector("[data-eligibility-threshold-label]"),
  riskAllocation: document.querySelector("[data-risk-allocation]"),
  riskAllocationLabel: document.querySelector("[data-risk-allocation-label]"),
  riskAllocationValue: document.querySelector("[data-risk-allocation-value]"),
  riskAllocationNote: document.querySelector("[data-risk-allocation-note]"),
  capitalStatus: document.querySelector("[data-capital-status]"),
  limitOrders: document.querySelector("[data-limit-orders]"),
  executionButtons: document.querySelectorAll("[data-one-time-execution]"),
  executionStatus: document.querySelector("[data-execution-status]"),
  nextOrderScan: document.querySelector("[data-next-order-scan]"),
  accountSyncPolicy: document.querySelector("[data-account-sync-policy]"),
  nextAccountSync: document.querySelector("[data-next-account-sync]"),
  evaluationStatusButtons: document.querySelectorAll("[data-evaluation-status]"),
  evaluationControls: document.querySelector("[data-evaluation-controls]"),
  modeButtons: document.querySelectorAll("[data-mode-toggle]"),
  liveActivation: document.querySelector("[data-live-activation]"),
  tabButtons: document.querySelectorAll("[data-tab-target]"),
  tabPanels: document.querySelectorAll("[data-tab-panel]"),
  portfolioEquity: document.querySelector("[data-portfolio-equity]"),
  portfolioLastRun: document.querySelector("[data-portfolio-last-run]"),
  portfolioTotalPl: document.querySelector("[data-portfolio-total-pl]"),
  portfolioTotalPlPct: document.querySelector("[data-portfolio-total-pl-pct]"),
  portfolioAnnualized: document.querySelector("[data-portfolio-annualized]"),
  portfolioPeriod: document.querySelector("[data-portfolio-period]"),
  portfolioRealized: document.querySelector("[data-portfolio-realized]"),
  portfolioRealizedPct: document.querySelector("[data-portfolio-realized-pct]"),
  portfolioAccuracy: document.querySelector("[data-portfolio-accuracy]"),
  portfolioAccuracyNote: document.querySelector("[data-portfolio-accuracy-note]"),
  portfolioOpenPl: document.querySelector("[data-portfolio-open-pl]"),
  portfolioOpenPlPct: document.querySelector("[data-portfolio-open-pl-pct]"),
  portfolioRisk: document.querySelector("[data-portfolio-risk]"),
  portfolioFree: document.querySelector("[data-portfolio-free]"),
  portfolioRr: document.querySelector("[data-portfolio-rr]"),
  portfolioRrNote: document.querySelector("[data-portfolio-rr-note]"),
};

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function money(value, digits = 2) {
  if (!Number.isFinite(value)) return "-";
  return `$${value.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

function probability(value) {
  if (!Number.isFinite(value)) return "-";
  return `${(value * 100).toFixed(1)}%`;
}

function percent(value) {
  if (!Number.isFinite(value)) return "-";
  return `${(value * 100).toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`;
}

function signedMoney(value, digits = 2) {
  if (!Number.isFinite(value)) return "-";
  return `${value >= 0 ? "+" : ""}${money(value, digits)}`;
}

function signedPercent(value) {
  if (!Number.isFinite(value)) return "-";
  return `${value >= 0 ? "+" : ""}${percent(value)}`;
}

function compactDays(value) {
  if (!Number.isFinite(value)) return "-";
  if (value < 1) return `${Math.max(0, value).toFixed(1)} d`;
  return `${value.toFixed(1)} d`;
}

function shortAddress(value) {
  const text = String(value || "");
  return /^0x[a-fA-F0-9]{40}$/.test(text) ? `${text.slice(0, 6)}...${text.slice(-4)}` : text || "-";
}

function pnlClass(value) {
  return Number(value) >= 0 ? "positive" : "negative";
}

function storedMode() {
  try {
    const value = localStorage.getItem(MODE_STORAGE_KEY);
    if (value === "live" || value === "paper-highReward" || value === "paper-moreProbable" || value === "paper-conservative") return value;
    return "paper-conservative";
  } catch {
    return "paper-conservative";
  }
}

function saveMode(mode) {
  try {
    localStorage.setItem(MODE_STORAGE_KEY, normalizeMode(mode));
  } catch {
    // Ignore localStorage failures; the mode switch still works for this page load.
  }
}

function normalizeMode(mode) {
  if (mode === "live" || mode === "paper-highReward" || mode === "paper-moreProbable" || mode === "paper-conservative") return mode;
  return mode === "paper" ? "paper-conservative" : "paper-conservative";
}

function isLiveMode() {
  return state.mode === "live";
}

function paperStrategyIdFromMode(mode = state.mode) {
  if (mode === "paper-highReward") return "highReward";
  if (mode === "paper-moreProbable") return "moreProbable";
  return "conservative";
}

function paperModeLabel(mode = state.mode) {
  const strategyId = paperStrategyIdFromMode(mode);
  if (strategyId === "highReward") return "High reward";
  if (strategyId === "moreProbable") return "More probable";
  return "Conservative";
}

function storedLiveExecutionArmed() {
  try {
    return localStorage.getItem(LIVE_EXECUTION_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

function saveLiveExecutionArmed(value) {
  try {
    localStorage.setItem(LIVE_EXECUTION_STORAGE_KEY, value ? "true" : "false");
  } catch {
    // Ignore localStorage failures; the guard still works for this page load.
  }
}

function setExecutionStatus(text, tone = "") {
  if (!els.executionStatus) return;
  els.executionStatus.textContent = text;
  els.executionStatus.classList.toggle("error", tone === "error");
  els.executionStatus.classList.toggle("muted", tone !== "error");
}

function syncExecutionButtons() {
  els.executionButtons.forEach((button) => {
    const target = button.dataset.oneTimeExecution === "current" ? (isLiveMode() ? "live" : "paper") : button.dataset.oneTimeExecution;
    const busy = state.executionBusy === target;
    button.disabled = Boolean(state.executionBusy);
    button.classList.toggle("live", isLiveMode());
    const labels = {
      paper: ["Run paper once", "Starting paper..."],
      live: ["Run live once", "Starting live..."],
    };
    const [idleLabel, busyLabel] = labels[target] || ["Run once", "Starting..."];
    button.textContent = busy ? busyLabel : idleLabel;
  });
}

function syncLiveActivationUi() {
  if (!els.liveActivation) return;
  els.liveActivation.hidden = false;
  els.liveActivation.classList.toggle("armed", state.liveExecutionArmed);
  els.liveActivation.setAttribute("aria-pressed", state.liveExecutionArmed ? "true" : "false");
  els.liveActivation.textContent = state.liveExecutionArmed ? "Live execution armed" : "Activate live execution";
}

function syncModeUi() {
  const live = isLiveMode();
  els.modeButtons.forEach((button) => {
    button.classList.toggle("active", button.dataset.modeToggle === state.mode);
  });
  els.tabButtons.forEach((button) => {
    button.textContent = live ? button.dataset.liveLabel : button.dataset.paperLabel;
  });
  if (els.portfolioTitle) els.portfolioTitle.textContent = live ? "Live Polymarket account" : `Paper - ${paperModeLabel()}`;
  if (els.primaryPanelTitle) els.primaryPanelTitle.textContent = live ? "Opened live trades" : `Opened ${paperModeLabel()} trades`;
  if (els.secondaryPanelTitle) els.secondaryPanelTitle.textContent = live ? "Closed live trades" : `Closed ${paperModeLabel()} trades`;
  if (els.evaluationControls) els.evaluationControls.style.display = "";
  if (els.accountSummary) els.accountSummary.hidden = !live;
  if (els.botStatus) els.botStatus.hidden = live;
  syncLiveActivationUi();
  syncExecutionButtons();
}

function formatDate(value) {
  const text = String(value || "");
  const dateOnly = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (dateOnly) return `${dateOnly[3]}. ${dateOnly[2]}. ${dateOnly[1]}`;

  const date = new Date(text);
  if (Number.isNaN(date.getTime())) return text || "-";
  return new Intl.DateTimeFormat("cs-CZ", {
    timeZone: "Europe/Prague",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function nextHourlyMinute(minute, from = new Date()) {
  const next = new Date(from);
  next.setSeconds(0, 0);
  next.setMinutes(minute);
  if (next <= from) next.setHours(next.getHours() + 1);
  return next;
}

function nextMinuteFromSet(minutes, from = new Date()) {
  const sorted = [...minutes].sort((a, b) => a - b);
  for (const minute of sorted) {
    const candidate = new Date(from);
    candidate.setSeconds(0, 0);
    candidate.setMinutes(minute);
    if (candidate > from) return candidate;
  }
  const next = new Date(from);
  next.setSeconds(0, 0);
  next.setHours(next.getHours() + 1);
  next.setMinutes(sorted[0]);
  return next;
}

function compactTimeUntil(date, from = new Date()) {
  const diffMs = date.getTime() - from.getTime();
  if (!Number.isFinite(diffMs) || diffMs <= 0) return "now";
  const minutes = Math.ceil(diffMs / 60000);
  if (minutes < 60) return `in ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `in ${hours}h ${rest}m` : `in ${hours}h`;
}

function scheduleLabel(date) {
  return `${formatDate(date.toISOString())} (${compactTimeUntil(date)})`;
}

function updateSchedulePanel() {
  if (els.nextOrderScan) {
    els.nextOrderScan.textContent = scheduleLabel(nextHourlyMinute(7));
  }
  if (els.accountSyncPolicy) {
    els.accountSyncPolicy.textContent = "On page load";
  }
  if (els.nextAccountSync) {
    els.nextAccountSync.textContent = `scheduled backup ${scheduleLabel(nextMinuteFromSet([5, 20, 35, 50]))}`;
  }
}

function decimalOdds(price) {
  const value = Number(price);
  if (!Number.isFinite(value) || value <= 0) return null;
  return 1 / value;
}

function odds(value) {
  if (!Number.isFinite(value)) return "-";
  return `${value.toFixed(2)}x`;
}

function sortDirectionIndicator(direction) {
  const descending = direction === "desc";
  const label = descending ? "Razeno sestupne" : "Razeno vzestupne";
  return `<span class="sort-arrow" aria-hidden="true" title="${label}">${descending ? "↓" : "↑"}</span>`;
}

function sortArrow(key) {
  if (state.evaluationSort.key !== key) return "";
  return sortDirectionIndicator(state.evaluationSort.direction);
}

function evaluationStake(item) {
  const stake = Number(item.stakeUsdc || 5);
  return Number.isFinite(stake) && stake > 0 ? stake : 5;
}

function evaluationTradingFee(item) {
  if (currentLimitOrders()) return 0;
  const fee = Number(item.takerFeeUsdc || 0);
  return Number.isFinite(fee) && fee > 0 ? fee : 0;
}

function evaluationShares(item) {
  const shares = Number(item.executableShares || item.shares);
  if (Number.isFinite(shares) && shares > 0) return shares;
  const stake = evaluationStake(item);
  const price = Number(item.marketPrice || item.entryPrice);
  const decimal = decimalOdds(price);
  return decimal == null ? null : stake * decimal;
}

function evaluationTotalCost(item) {
  return evaluationStake(item) + evaluationTradingFee(item);
}

function gainIfWin(item) {
  const shares = evaluationShares(item);
  if (!Number.isFinite(shares)) return null;
  return shares - evaluationTotalCost(item);
}

function expectedValue(item) {
  const aiProbability = Number(item.aiProbability);
  const shares = evaluationShares(item);
  if (!Number.isFinite(aiProbability) || !Number.isFinite(shares)) return null;
  return (aiProbability * shares) - evaluationTotalCost(item);
}

function netYield(item) {
  const gain = gainIfWin(item);
  const cost = evaluationTotalCost(item);
  if (!Number.isFinite(gain) || !Number.isFinite(cost) || cost <= 0) return null;
  return gain / cost;
}

function evaluationRiskReward(item) {
  const risk = evaluationTotalCost(item);
  const reward = gainIfWin(item);
  if (!Number.isFinite(risk) || !Number.isFinite(reward) || risk <= 0 || reward <= 0) return null;
  return reward / risk;
}

function annualizedExpectedReturn(item) {
  const ev = expectedValue(item);
  const cost = evaluationTotalCost(item);
  if (!Number.isFinite(ev) || !Number.isFinite(cost) || cost <= 0) return null;
  const roi = ev / cost;
  const days = daysToResolution(item);
  return Number.isFinite(days) && days > 0 ? roi * (365 / days) : roi;
}

function daysToResolution(item) {
  const value = Number(item.daysToResolution);
  return Number.isFinite(value) ? value : null;
}

function evaluationEndDate(item) {
  return tradeEndDate({
    ...item,
    openedAt: item.openedAt || item.evaluatedAt,
    date: item.date || item.evaluatedAt,
  });
}

function evaluationDaysLeft(item) {
  const endDate = evaluationEndDate(item);
  const remaining = daysUntil(endDate);
  if (Number.isFinite(remaining)) return remaining;
  return daysToResolution(item);
}

function evaluationEnded(item) {
  const end = Date.parse(evaluationEndDate(item) || "");
  return Number.isFinite(end) && end <= Date.now();
}

function feeLine(item) {
  if (currentLimitOrders()) return "maker fee $0.00000 (limit)";
  const fee = Number(item.takerFeeUsdc);
  if (!Number.isFinite(fee) || fee <= 0) return "";
  const rate = Number(item.feeRate);
  const type = item.feeType ? ` ${item.feeType}` : "";
  const rateText = Number.isFinite(rate) && rate > 0 ? `, ${(rate * 100).toFixed(1)}%${type}` : type;
  return `fee ${money(fee, 5)}${rateText}`;
}

function riskLine(item) {
  const labels = Array.isArray(item.riskGroupLabels) ? item.riskGroupLabels : [];
  const visible = labels
    .filter((label) => /^(Team|Match|Event):/i.test(label))
    .slice(0, 3);
  if (!visible.length) return "";
  return `risk: ${visible.join(", ")}`;
}

function polymarketUrl(item) {
  const explicitUrl = String(item?.url || item?.marketUrl || "").trim();
  if (/^https:\/\/polymarket\.com\//i.test(explicitUrl)) return explicitUrl;
  const slug = String(item?.eventSlug || item?.slug || "").trim();
  if (/^[a-z0-9-]+$/i.test(slug)) return `https://polymarket.com/event/${slug}`;
  return "https://polymarket.com/";
}

function marketAnchor(item) {
  const href = polymarketUrl(item);
  return `
    <a class="market-link" href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">
      <strong>${escapeHtml(item.outcome)}</strong>
      <span>${escapeHtml(item.question)}</span>
    </a>
  `;
}

function tradePnlValue(trade) {
  if (isClosedTrade(trade)) return Number(trade.realizedPnlUsdc);
  return Number(trade.unrealizedPnlUsdc);
}

function tradePnlPct(trade) {
  if (isClosedTrade(trade)) return Number(trade.realizedPnlPct);
  return Number(trade.unrealizedPnlPct);
}

function isClosedTrade(trade) {
  return ["WON", "LOST", "CLOSED", "REDEEMED", "SOLD", "REDEEM_REQUIRED", "RESOLVED"].includes(String(trade.status || "").toUpperCase());
}

function closedTradeWasCorrect(trade) {
  const status = String(trade.status || "").toUpperCase();
  if (["WON", "REDEEMED"].includes(status)) return true;
  if (status === "LOST") return false;
  const realized = Number(trade.realizedPnlUsdc);
  if (Number.isFinite(realized)) return realized > 0;
  const finalPrice = Number(trade.finalPrice ?? trade.currentPrice);
  if (Number.isFinite(finalPrice)) return finalPrice >= 0.995;
  return false;
}

function closedAccuracyStats(closedTrades) {
  const rows = Array.isArray(closedTrades) ? closedTrades.filter(isClosedTrade) : [];
  const correct = rows.filter(closedTradeWasCorrect).length;
  const total = rows.length;
  return {
    correct,
    total,
    rate: total ? correct / total : null,
  };
}

function renderClosedAccuracy(closedTrades) {
  const stats = closedAccuracyStats(closedTrades);
  if (els.portfolioAccuracy) {
    els.portfolioAccuracy.textContent = stats.rate == null ? "-" : probability(stats.rate);
    els.portfolioAccuracy.className = stats.rate == null ? "" : (stats.rate >= 0.5 ? "positive" : "negative");
  }
  if (els.portfolioAccuracyNote) {
    els.portfolioAccuracyNote.textContent = `${stats.correct} / ${stats.total} closed`;
  }
}

function tradeStatusNote(trade) {
  const parts = [
    trade.statusNote || "",
    trade.finalOutcomePrice == null ? "" : `final ${probability(Number(trade.finalOutcomePrice))}`,
    trade.marketUrlStatus === "use_event_slug" ? "event link" : "",
  ];
  return parts.filter(Boolean).join(", ");
}

function inferredDateFromQuestion(trade) {
  const question = String(trade.question || "");
  const match = question.match(/\b(?:by|on|before|through)\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2})(?:,\s*(\d{4}))?/i);
  if (!match) return null;
  const months = {
    january: 0,
    february: 1,
    march: 2,
    april: 3,
    may: 4,
    june: 5,
    july: 6,
    august: 7,
    september: 8,
    october: 9,
    november: 10,
    december: 11,
  };
  const opened = new Date(trade.openedAt || trade.date || Date.now());
  const fallbackEnd = new Date(trade.endDate || opened);
  const year = Number(match[3]) || (Number.isFinite(fallbackEnd.getTime()) ? fallbackEnd.getUTCFullYear() : opened.getUTCFullYear());
  const month = months[match[1].toLowerCase()];
  const day = Number(match[2]);
  if (!Number.isInteger(month) || !Number.isFinite(day)) return null;
  const inferred = new Date(Date.UTC(year, month, day, 23, 59, 59));
  if (!Number.isFinite(inferred.getTime())) return null;
  return inferred.toISOString();
}

function tradeEndDate(trade) {
  const stored = trade.endDate || trade.closedTime || trade.resolvedAt || null;
  const inferred = inferredDateFromQuestion(trade);
  if (!inferred) return stored;
  const storedTime = Date.parse(stored || "");
  const inferredTime = Date.parse(inferred);
  if (!Number.isFinite(storedTime)) return inferred;
  if (!isClosedTrade(trade) && inferredTime > storedTime) return inferred;
  return stored;
}

function daysBetween(startValue, endValue) {
  const start = Date.parse(startValue || "");
  const end = Date.parse(endValue || "");
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return Math.max(0, (end - start) / 86400000);
}

function daysUntil(value) {
  const end = Date.parse(value || "");
  if (!Number.isFinite(end)) return null;
  return Math.max(0, (end - Date.now()) / 86400000);
}

function tradeHoldingDays(trade) {
  const end = isClosedTrade(trade) ? (trade.resolvedAt || trade.closedTime || trade.lastCheckedAt || new Date().toISOString()) : new Date().toISOString();
  return daysBetween(trade.openedAt || trade.date, end);
}

function annualizedForPeriod(returnPct, days) {
  if (!Number.isFinite(returnPct) || !Number.isFinite(days) || days <= 0) return null;
  return returnPct * (365 / Math.max(days, 1 / 24));
}

function tradePotentialGain(trade) {
  const netGain = Number(trade.netGainIfWinUsdc);
  if (Number.isFinite(netGain)) return netGain;
  const shares = Number(trade.shares);
  const stake = Number(trade.stakeUsdc || 0);
  const fee = Number(trade.takerFeeUsdc || 0);
  if (Number.isFinite(shares) && shares > 0) return shares - stake - fee;
  return null;
}

function tradeCostBasis(trade) {
  return Number(trade.totalCostUsdc || trade.maxLossUsdc || trade.stakeUsdc || 0);
}

function tradePotentialGainPct(trade) {
  const gain = tradePotentialGain(trade);
  const basis = tradeCostBasis(trade);
  return basis > 0 && Number.isFinite(gain) ? gain / basis : null;
}

function tradeRiskReward(trade) {
  const risk = tradeCostBasis(trade);
  const reward = tradePotentialGain(trade);
  if (!Number.isFinite(risk) || !Number.isFinite(reward) || risk <= 0 || reward <= 0) return null;
  return reward / risk;
}

function riskReward(value) {
  if (!Number.isFinite(value)) return "-";
  return `${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}:1`;
}

function riskRewardClass(value) {
  if (!Number.isFinite(value)) return "";
  if (value >= 1) return "positive";
  if (value >= 0.33) return "";
  return "negative";
}

function averageRiskReward(items, mapper) {
  const values = items.map(mapper).filter(Number.isFinite);
  if (!values.length) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function tradePotentialAnnualized(trade) {
  const gainPct = tradePotentialGainPct(trade);
  const endDate = tradeEndDate(trade);
  const totalPlannedDays = daysBetween(trade.openedAt || trade.date, endDate);
  return annualizedForPeriod(gainPct, totalPlannedDays);
}

function resolutionCell(trade) {
  const endDate = tradeEndDate(trade);
  const remaining = isClosedTrade(trade) ? null : daysUntil(endDate);
  const storedDays = Number(trade.daysToResolution);
  const days = Number.isFinite(remaining) && remaining > 0 ? remaining : storedDays;
  const inferred = inferredDateFromQuestion(trade);
  const inferredNote = inferred && trade.endDate && Date.parse(inferred) > Date.parse(trade.endDate) ? "from question" : "";
  return `
    ${escapeHtml(endDate ? formatDate(endDate) : "-")}
    <span>${isClosedTrade(trade) ? "resolved" : `${compactDays(days)} left${inferredNote ? `, ${inferredNote}` : ""}`}</span>
  `;
}

function holdingCell(trade) {
  const heldDays = tradeHoldingDays(trade);
  return `
    ${compactDays(heldDays)}
    <span>${isClosedTrade(trade) ? "closed holding" : "open holding"}</span>
  `;
}

function potentialGainCell(trade) {
  const gain = tradePotentialGain(trade);
  return `<span class="${pnlClass(gain)}">${signedMoney(gain)}</span>`;
}

function potentialPctCell(trade) {
  const gainPct = tradePotentialGainPct(trade);
  return `<span class="${pnlClass(gainPct)}">${signedPercent(gainPct)}</span>`;
}

function potentialAnnualizedCell(trade) {
  const annualized = tradePotentialAnnualized(trade);
  return `<span class="${pnlClass(annualized)}">${signedPercent(annualized)}</span>`;
}

function tradeAiProbability(trade) {
  const fromTrade = Number(trade.aiProbability);
  if (Number.isFinite(fromTrade)) return fromTrade;
  const fromAnalysis = Number(trade.aiAnalysis?.probability);
  if (Number.isFinite(fromAnalysis)) return fromAnalysis;
  const fromEvaluation = Number(trade.sourceEvaluation?.aiProbability);
  return Number.isFinite(fromEvaluation) ? fromEvaluation : null;
}

function tradeAnalysisThesis(trade) {
  return trade.probabilityThesis
    || trade.aiAnalysis?.thesis
    || trade.sourceEvaluation?.probabilityThesis
    || trade.sourceEvaluation?.aiAnalysis?.thesis
    || "";
}

function tradeAnalysisDetails(trade) {
  const ai = trade.aiAnalysis || trade.sourceEvaluation?.aiAnalysis || {};
  const source = trade.sourceEvaluation || {};
  const lines = [
    trade.thesisType || source.thesisType ? `Thesis type: ${trade.thesisType || source.thesisType}` : "",
    `AI probability: ${probability(tradeAiProbability(trade))}`,
    trade.rawProbability != null || source.rawProbability != null ? `Raw probability: ${probability(Number(trade.rawProbability ?? source.rawProbability))}` : "",
    trade.entryPrice != null ? `Entry price: ${probability(Number(trade.entryPrice))}` : "",
    trade.edge != null || source.edge != null ? `Original edge: ${signedPercent(Number(trade.edge ?? source.edge))}` : "",
    trade.expectedValueUsdc != null || source.expectedValueUsdc != null ? `Original EV: ${signedMoney(Number(trade.expectedValueUsdc ?? source.expectedValueUsdc), 4)}` : "",
    trade.annualizedReturn != null || source.annualizedReturn != null ? `Original EV p.a.: ${signedPercent(Number(trade.annualizedReturn ?? source.annualizedReturn))}` : "",
    tradeAnalysisThesis(trade),
    Array.isArray(ai.evidence) && ai.evidence.length ? `Evidence: ${ai.evidence.join(" ")}` : "",
    Array.isArray(ai.counterEvidence) && ai.counterEvidence.length ? `Counter: ${ai.counterEvidence.join(" ")}` : "",
    trade.analysisSummary || source.analysisSummary || "",
    trade.rotationReview?.note ? `Rotation review: ${trade.rotationReview.note}` : "",
    trade.rotationEntryReason ? `Opened after rotation: ${trade.rotationEntryReason}` : "",
    trade.postMortem?.thesisReview ? `Post-mortem: ${trade.postMortem.thesisReview}` : "",
  ];
  return lines.filter(Boolean).join("\n\n");
}

function tradeAnalysisCell(trade) {
  const prob = tradeAiProbability(trade);
  const details = tradeAnalysisDetails(trade);
  return `
    <strong>${probability(prob)}</strong>
    <span class="analysis-popover">
      <button class="info-button" type="button" aria-label="Show original AI analysis">i</button>
      <span class="analysis-tooltip" role="tooltip">${escapeHtml(details)}</span>
    </span>
  `;
}

function postMortemLine(trade) {
  if (trade.rotationReview?.note) return trade.rotationReview.note;
  if (trade.rotationEntryReason) return trade.rotationEntryReason;
  const review = trade.postMortem;
  if (!review) return "";
  const error = Number(review.predictionError);
  const errorText = Number.isFinite(error) ? `error ${signedPercent(error)}` : "";
  return [review.conclusion, errorText].filter(Boolean).join(" ");
}

function tradeSortValue(trade, key) {
  if (key === "openedAt") return Date.parse(trade.openedAt || trade.date || "") || 0;
  if (key === "market") return `${trade.outcome || ""} ${trade.question || ""}`.toLowerCase();
  if (key === "entryPrice") return Number(trade.entryPrice);
  if (key === "currentPrice") return Number(trade.currentPrice);
  if (key === "aiProbability") return tradeAiProbability(trade);
  if (key === "resolution") return Date.parse(tradeEndDate(trade) || "") || 0;
  if (key === "holding") return tradeHoldingDays(trade);
  if (key === "potentialGain") return tradePotentialGain(trade);
  if (key === "potentialPct") return tradePotentialGainPct(trade);
  if (key === "riskReward") return tradeRiskReward(trade);
  if (key === "potentialAnnualized") return tradePotentialAnnualized(trade);
  if (key === "pnl") return tradePnlValue(trade);
  if (key === "pnlPct") return tradePnlPct(trade);
  if (key === "stake") return Number(trade.stakeUsdc || 0);
  if (key === "status") return String(trade.status || "");
  if (key === "resolvedAt") return Date.parse(trade.resolvedAt || trade.closedTime || trade.lastCheckedAt || "") || 0;
  return "";
}

function sortedTrades(trades, tableKey) {
  const sort = state.tradeSort[tableKey] || state.tradeSort.open;
  const direction = sort.direction === "asc" ? 1 : -1;
  return [...trades].sort((a, b) => {
    const aValue = tradeSortValue(a, sort.key);
    const bValue = tradeSortValue(b, sort.key);
    const aMissing = aValue == null || Number.isNaN(aValue);
    const bMissing = bValue == null || Number.isNaN(bValue);
    if (aMissing && bMissing) return 0;
    if (aMissing) return 1;
    if (bMissing) return -1;
    if (typeof aValue === "number" && typeof bValue === "number") return (aValue - bValue) * direction;
    return String(aValue).localeCompare(String(bValue)) * direction;
  });
}

function tradeSortArrow(tableKey, key) {
  const sort = state.tradeSort[tableKey] || state.tradeSort.open;
  if (sort.key !== key) return "";
  return sortDirectionIndicator(sort.direction);
}

function tradeHeader(tableKey, key, label) {
  const sort = state.tradeSort[tableKey] || state.tradeSort.open;
  const active = sort.key === key ? " active" : "";
  return `<th><button class="sort-button${active}" type="button" data-trade-sort="${key}" data-trade-table="${tableKey}">${label}${tradeSortArrow(tableKey, key)}</button></th>`;
}

function tradeTypeBadge(trade) {
  if (trade.mode === "LIVE_ORDER") return '<span class="order-chip">Limit order waiting</span>';
  if (trade.mode === "LIVE_RECONCILIATION") return '<span class="order-chip warning">Sync gap</span>';
  if (String(trade.status || "").toUpperCase() === "REDEEM_REQUIRED") return '<span class="order-chip warning">Redeem needed</span>';
  if (String(trade.status || "").toUpperCase() === "PENDING_RESOLUTION") return '<span class="order-chip warning">Pending resolution</span>';
  if (isClosedTrade(trade) && trade.mode === "LIVE") return '<span class="order-chip filled">Settled position</span>';
  if (trade.mode === "LIVE") return '<span class="order-chip filled">Open position</span>';
  if (trade.strategyLabel) return `<span class="order-chip paper">${escapeHtml(trade.strategyLabel)}</span>`;
  return "";
}

function renderTradeRows(trades, emptyText, options = {}) {
  const tableKey = options.tableKey || "open";
  const showStatus = options.showStatus !== false;
  if (!trades.length) return `<div class="empty">${escapeHtml(emptyText)}</div>`;
  const rows = sortedTrades(trades, tableKey);
  return `
    <table>
      <thead>
        <tr>
          ${tradeHeader(tableKey, showStatus ? "resolvedAt" : "openedAt", showStatus ? "Closed" : "Opened")}
          ${tradeHeader(tableKey, "market", "Market")}
          ${tradeHeader(tableKey, "entryPrice", "Entry")}
          ${tradeHeader(tableKey, "currentPrice", showStatus ? "Final" : "Mark")}
          ${tradeHeader(tableKey, "aiProbability", "AI prob.")}
          ${tradeHeader(tableKey, "resolution", "Resolution")}
          ${tradeHeader(tableKey, "holding", "Holding")}
          ${tradeHeader(tableKey, "potentialGain", "Win $")}
          ${tradeHeader(tableKey, "potentialPct", "Win %")}
          ${tradeHeader(tableKey, "riskReward", "R/R")}
          ${tradeHeader(tableKey, "potentialAnnualized", "Win p.a.")}
          ${showStatus ? tradeHeader(tableKey, "status", "Result") : ""}
          ${tradeHeader(tableKey, "pnl", "P/L")}
          ${tradeHeader(tableKey, "stake", "Stake")}
        </tr>
      </thead>
      <tbody>
        ${rows.map((trade) => `
          <tr>
            <td data-label="${showStatus ? "Closed" : "Opened"}">${escapeHtml(formatDate(showStatus ? (trade.resolvedAt || trade.closedTime || trade.lastCheckedAt || "") : (trade.openedAt || trade.date || "")))}</td>
            <td data-label="Market">
              ${tradeTypeBadge(trade)}
              ${marketAnchor(trade)}
              <span>${escapeHtml(riskLine(trade))}</span>
              <span>${escapeHtml(postMortemLine(trade))}</span>
            </td>
            <td data-label="Entry">
              ${probability(Number(trade.entryPrice))}
              <span>${[trade.slippage == null ? "" : `slip ${(Number(trade.slippage) * 100).toFixed(1)} pts`, feeLine(trade)].filter(Boolean).join(", ")}</span>
            </td>
            <td data-label="${showStatus ? "Final" : "Mark"}">${probability(Number(trade.currentPrice))}</td>
            <td data-label="AI prob.">
              <strong>${probability(tradeAiProbability(trade))}</strong>
              <span class="analysis-popover">
                <button class="info-button" type="button" aria-label="Show original AI analysis">i</button>
                <span class="analysis-tooltip" role="tooltip">${escapeHtml(tradeAnalysisDetails(trade))}</span>
              </span>
            </td>
            <td data-label="Resolution">${resolutionCell(trade)}</td>
            <td data-label="Holding">${holdingCell(trade)}</td>
            <td data-label="Win $">${potentialGainCell(trade)}</td>
            <td data-label="Win %">${potentialPctCell(trade)}</td>
            <td data-label="R/R"><span class="${riskRewardClass(tradeRiskReward(trade))}">${riskReward(tradeRiskReward(trade))}</span></td>
            <td data-label="Win p.a.">${potentialAnnualizedCell(trade)}</td>
            ${showStatus ? `<td data-label="Result">
              ${escapeHtml(trade.status || "OPEN")}
              <span>${escapeHtml(tradeStatusNote(trade))}</span>
            </td>` : ""}
            <td data-label="P/L" class="${pnlClass(tradePnlValue(trade))}">
              ${signedMoney(tradePnlValue(trade))}
              <span>${signedPercent(tradePnlPct(trade))}</span>
            </td>
            <td data-label="Stake">${money(Number(trade.stakeUsdc || 0))}</td>
          </tr>
        `).join("")}
      </tbody>
    </table>
  `;
}

function portfolioPeriodDays(botState, trades) {
  const timestamps = trades
    .map((trade) => Date.parse(trade.openedAt || trade.date || ""))
    .filter(Number.isFinite);
  if (!timestamps.length) return null;
  const start = Math.min(...timestamps);
  const end = Date.parse(botState.generatedAt || "") || Date.now();
  return Math.max(1, (end - start) / 86400000);
}

function annualizedPortfolioReturn(portfolio, days) {
  const totalPct = Number(portfolio.totalPnlPct);
  if (!Number.isFinite(totalPct) || !Number.isFinite(days) || days <= 0) return null;
  return totalPct * (365 / days);
}

function analysisBadge(item) {
  const riskReason = item.selectionStatus === "RISK_BLOCKED"
    ? (item.riskBlockedReason || "risk-blocked by an open correlated paper trade")
    : "";
  const reasons = evaluationReasons(item, riskReason).join("; ") || "passes selected filters";
  const ai = item.aiAnalysis || {};
  const details = [
    `Portfolio status: ${evaluationStatusLabel(item)}`,
    `Stored pipeline status: ${item.status || "-"}`,
    `Selected AI probability threshold: ${probability(currentEligibilityThreshold())}`,
    reasons,
    item.thesisType ? `Thesis type: ${item.thesisType}` : "",
    item.probabilityThesis || ai.thesis || "",
    ai.rawProbability == null ? "" : `Raw probability: ${probability(Number(ai.rawProbability))}`,
    ai.learningAdjustment == null ? "" : `Learning adjustment: ${signedPercent(Number(ai.learningAdjustment))}`,
    Array.isArray(ai.appliedLearning) && ai.appliedLearning.length
      ? `Applied learning: ${ai.appliedLearning.map((entry) => `${entry.key} ${signedPercent(Number(entry.adjustment))}`).join(", ")}`
      : "",
    Array.isArray(ai.evidence) && ai.evidence.length ? `Evidence: ${ai.evidence.join(" ")}` : "",
    Array.isArray(ai.counterEvidence) && ai.counterEvidence.length ? `Counter: ${ai.counterEvidence.join(" ")}` : "",
    item.analysisSummary || "",
  ].filter(Boolean).join("\n\n");
  return `
    <span class="analysis-popover">
      <button class="info-button" type="button" aria-label="Show analysis details">i</button>
      <span class="analysis-tooltip" role="tooltip">${escapeHtml(details)}</span>
    </span>
    <span class="analysis-reason">${escapeHtml(reasons)}</span>
  `;
}

function evaluationStatusLabel(item) {
  const status = portfolioEvaluationStatus(item);
  if (status === "ERROR") return "ERROR";
  if (status === "ELIGIBLE") return "ELIGIBLE";
  if (item.selectionStatus === "RISK_BLOCKED") return "NOT ELIGIBLE / RISK BLOCKED";
  return "NOT ELIGIBLE";
}

function evaluationStatusClass(item) {
  const status = portfolioEvaluationStatus(item);
  if (status === "ERROR") return "negative";
  if (status === "ELIGIBLE") return "positive";
  return "";
}

function evaluationFilterLabel(value) {
  if (value === "ELIGIBLE") return "eligible";
  if (value === "REJECTED") return "not eligible";
  if (value === "ERROR") return "error";
  return "evaluated";
}

function eligibilityThresholdStorageKey() {
  const parts = [ELIGIBILITY_THRESHOLD_STORAGE_KEY, state.mode];
  if (isLiveMode()) {
    const address = state.liveState?.account?.address || state.liveState?.account?.proxyWallet || "";
    if (address) parts.push(String(address).toLowerCase());
  }
  return parts.join(":");
}

function accountScopedStorageKey(baseKey) {
  const parts = [baseKey, state.mode];
  if (isLiveMode()) {
    const address = state.liveState?.account?.address || state.liveState?.account?.proxyWallet || "";
    if (address) parts.push(String(address).toLowerCase());
  }
  return parts.join(":");
}

function riskAllocationStorageKey() {
  return accountScopedStorageKey(RISK_ALLOCATION_STORAGE_KEY);
}

function limitOrdersStorageKey() {
  return accountScopedStorageKey(LIMIT_ORDERS_STORAGE_KEY);
}

function storedEligibilityThreshold() {
  try {
    const scopedKey = eligibilityThresholdStorageKey();
    const scopedValue = normalizeEligibilityThreshold(Number(localStorage.getItem(scopedKey)));
    if (scopedValue != null) return scopedValue;
    const legacyValue = normalizeEligibilityThreshold(Number(localStorage.getItem(ELIGIBILITY_THRESHOLD_STORAGE_KEY)));
    return legacyValue;
  } catch {
    return null;
  }
}

function saveEligibilityThreshold(value) {
  try {
    const key = eligibilityThresholdStorageKey();
    localStorage.setItem(key, String(value));
    state.eligibilityThresholdKey = key;
  } catch {
    // Ignore localStorage failures; the control still works for this page load.
  }
}

function refreshEligibilityThreshold() {
  const key = eligibilityThresholdStorageKey();
  if (state.eligibilityThresholdKey === key && state.eligibilityThreshold != null) {
    syncEligibilityThresholdControl();
    return;
  }
  const portfolioThreshold = Number(state.botState?.portfolio?.minProbability ?? DEFAULT_ELIGIBILITY_THRESHOLD);
  state.eligibilityThreshold = storedEligibilityThreshold() ?? normalizeEligibilityThreshold(portfolioThreshold) ?? DEFAULT_ELIGIBILITY_THRESHOLD;
  state.eligibilityThresholdKey = key;
  syncEligibilityThresholdControl();
}

function normalizeRiskAllocation(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  if (numeric < MIN_RISK_ALLOCATION || numeric > MAX_RISK_ALLOCATION) return null;
  return numeric;
}

function storedRiskAllocation() {
  try {
    const scopedKey = riskAllocationStorageKey();
    const scopedValue = normalizeRiskAllocation(Number(localStorage.getItem(scopedKey)));
    if (scopedValue != null) return scopedValue;
    const legacyValue = normalizeRiskAllocation(Number(localStorage.getItem(RISK_ALLOCATION_STORAGE_KEY)));
    return legacyValue;
  } catch {
    return null;
  }
}

function saveRiskAllocation(value) {
  try {
    const key = riskAllocationStorageKey();
    localStorage.setItem(key, String(value));
    state.riskAllocationKey = key;
  } catch {
    // Ignore localStorage failures; the control still works for this page load.
  }
}

function currentRiskAllocation() {
  const configured = Number(state.riskAllocation);
  return normalizeRiskAllocation(configured) ?? DEFAULT_RISK_ALLOCATION;
}

function refreshRiskAllocation() {
  const key = riskAllocationStorageKey();
  if (state.riskAllocationKey === key && state.riskAllocation != null) {
    syncRiskAllocationControl();
    return;
  }
  state.riskAllocation = storedRiskAllocation() ?? DEFAULT_RISK_ALLOCATION;
  state.riskAllocationKey = key;
  syncRiskAllocationControl();
}

function syncCapitalStatus({ availableCapital = null, baseCapital = null, stake = null, cadenceLabel = "next scheduled run" } = {}) {
  if (!els.capitalStatus) return;
  const available = Number(availableCapital);
  const orderStake = Number(stake);
  if (!Number.isFinite(available) || !Number.isFinite(orderStake) || orderStake <= 0) {
    els.capitalStatus.textContent = "Capital status is not available yet.";
    els.capitalStatus.className = "capital-status muted";
    return;
  }
  if (available + 0.000001 < orderStake) {
    els.capitalStatus.textContent = `Dalsi obchod se ted nerealizuje: k dispozici je ${money(available)}, ale jedna obchodni davka podle diverzifikace vyzaduje ${money(orderStake)}.`;
    els.capitalStatus.className = "capital-status negative";
    return;
  }
  const idleAfterNext = Math.max(0, available - orderStake);
  const base = Number(baseCapital);
  const baseText = Number.isFinite(base) ? ` / base ${money(base)}` : "";
  els.capitalStatus.textContent = `K dispozici pro ${cadenceLabel}: ${money(available)}; dalsi obchodni davka ${money(orderStake)}${baseText}; po dalsim obchodu zustane cca ${money(idleAfterNext)}.`;
  els.capitalStatus.className = idleAfterNext > orderStake ? "capital-status warning" : "capital-status positive";
}

function syncRiskAllocationControl(availableCapital = null, sourceLabel = "available capital", options = {}) {
  const value = currentRiskAllocation();
  const base = Number(options.baseCapital ?? availableCapital);
  const available = Number(availableCapital);
  const stake = Number.isFinite(base) ? base * value : null;
  if (els.riskAllocation) {
    els.riskAllocation.value = String(Math.round(value * 100));
  }
  if (els.riskAllocationLabel) {
    els.riskAllocationLabel.textContent = probability(value);
  }
  if (els.riskAllocationValue) {
    els.riskAllocationValue.textContent = Number.isFinite(stake) ? money(stake) : "-";
  }
  if (els.riskAllocationNote) {
    els.riskAllocationNote.textContent = `maximum stake from ${sourceLabel}`;
  }
  syncCapitalStatus({
    availableCapital: Number.isFinite(available) ? available : null,
    baseCapital: Number.isFinite(base) ? base : null,
    stake,
    cadenceLabel: options.cadenceLabel || "next scheduled run",
  });
}

function defaultLimitOrdersForMode() {
  return isLiveMode();
}

function storedLimitOrders() {
  try {
    const key = limitOrdersStorageKey();
    const scoped = localStorage.getItem(key);
    if (scoped === "true") return true;
    if (scoped === "false") return false;
    const legacy = localStorage.getItem(LIMIT_ORDERS_STORAGE_KEY);
    if (legacy === "true") return true;
    if (legacy === "false") return false;
    return null;
  } catch {
    return null;
  }
}

function saveLimitOrders(value) {
  try {
    const key = limitOrdersStorageKey();
    localStorage.setItem(key, value ? "true" : "false");
    state.limitOrdersKey = key;
  } catch {
    // Ignore localStorage failures; the control still works for this page load.
  }
}

function currentLimitOrders() {
  return typeof state.limitOrders === "boolean" ? state.limitOrders : defaultLimitOrdersForMode();
}

function refreshLimitOrders() {
  const key = limitOrdersStorageKey();
  if (state.limitOrdersKey === key && typeof state.limitOrders === "boolean") {
    syncLimitOrdersControl();
    return;
  }
  state.limitOrders = storedLimitOrders() ?? defaultLimitOrdersForMode();
  state.limitOrdersKey = key;
  syncLimitOrdersControl();
}

function syncLimitOrdersControl() {
  if (els.limitOrders) {
    els.limitOrders.checked = currentLimitOrders();
  }
}

function analysisModal() {
  let modal = document.querySelector("[data-analysis-modal]");
  if (modal) return modal;
  modal = document.createElement("div");
  modal.className = "analysis-modal-backdrop";
  modal.dataset.analysisModal = "";
  modal.hidden = true;
  modal.innerHTML = `
    <section class="analysis-modal" role="dialog" aria-modal="true" aria-labelledby="analysis-modal-title">
      <div class="analysis-modal-head">
        <h2 id="analysis-modal-title">Analysis detail</h2>
        <button class="analysis-modal-close" type="button" data-analysis-modal-close aria-label="Close analysis detail">x</button>
      </div>
      <div class="analysis-modal-body" data-analysis-modal-body></div>
    </section>
  `;
  document.body.appendChild(modal);
  return modal;
}

function openAnalysisModal(text, trigger) {
  const modal = analysisModal();
  const body = modal.querySelector("[data-analysis-modal-body]");
  if (body) body.textContent = text || "No analysis detail available.";
  modal.hidden = false;
  document.body.classList.add("modal-open");
  modal.querySelector("[data-analysis-modal-close]")?.focus();
  if (trigger) {
    modal.dataset.returnFocus = "true";
    analysisModal.lastTrigger = trigger;
  }
}

function closeAnalysisModal() {
  const modal = document.querySelector("[data-analysis-modal]");
  if (!modal || modal.hidden) return;
  modal.hidden = true;
  document.body.classList.remove("modal-open");
  if (analysisModal.lastTrigger instanceof HTMLElement) {
    analysisModal.lastTrigger.focus();
  }
  analysisModal.lastTrigger = null;
}

function executionModal() {
  let modal = document.querySelector("[data-execution-modal]");
  if (modal) return modal;
  modal = document.createElement("div");
  modal.className = "analysis-modal-backdrop execution-modal-backdrop";
  modal.dataset.executionModal = "";
  modal.hidden = true;
  modal.innerHTML = `
    <section class="analysis-modal execution-modal" role="dialog" aria-modal="true" aria-labelledby="execution-modal-title">
      <div class="analysis-modal-head">
        <h2 id="execution-modal-title">Execution progress</h2>
        <button class="analysis-modal-close" type="button" data-execution-modal-close aria-label="Close execution progress">x</button>
      </div>
      <div class="analysis-modal-body execution-modal-body" data-execution-modal-body></div>
    </section>
  `;
  document.body.appendChild(modal);
  return modal;
}

function openExecutionModal(target) {
  const modal = executionModal();
  modal.hidden = false;
  modal.dataset.target = target;
  modal.dataset.done = "false";
  document.body.classList.add("modal-open");
  renderExecutionSteps([{ tone: "active", text: `${target === "live" ? "Live" : "Paper"} run requested` }]);
  modal.querySelector("[data-execution-modal-close]")?.focus();
}

function closeExecutionModal() {
  const modal = document.querySelector("[data-execution-modal]");
  if (!modal || modal.hidden) return;
  modal.hidden = true;
  document.body.classList.remove("modal-open");
}

function renderExecutionSteps(steps) {
  const modal = executionModal();
  const body = modal.querySelector("[data-execution-modal-body]");
  if (!body) return;
  body.innerHTML = `
    <div class="execution-steps">
      ${steps.map((step) => `
        <div class="execution-step ${escapeHtml(step.tone || "")}">
          <strong>${escapeHtml(step.title || step.text || "")}</strong>
          ${step.detail ? `<span>${escapeHtml(step.detail)}</span>` : ""}
        </div>
      `).join("")}
    </div>
  `;
}

function addExecutionStep(steps, title, detail = "", tone = "") {
  const next = [...steps, { title, detail, tone }];
  renderExecutionSteps(next);
  return next;
}

function sleep(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function runMatchesStart(run, startedAt) {
  const created = Date.parse(run?.createdAt || "");
  const start = Date.parse(startedAt || "");
  return !Number.isFinite(start) || !Number.isFinite(created) || created >= start - 120000;
}

function workflowStatusText(run) {
  if (!run) return "waiting for GitHub workflow to appear";
  if (run.status === "completed") return `completed${run.conclusion ? ` / ${run.conclusion}` : ""}`;
  return run.status || "queued";
}

async function waitForWorkflowRun(target, startedAt, steps) {
  let latest = null;
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const status = await fetchApiJson(`api.php?action=workflow-status&target=${encodeURIComponent(target)}&since=${encodeURIComponent(startedAt)}`);
    latest = (status.runs || []).find((run) => runMatchesStart(run, startedAt)) || status.latest || null;
    const detail = latest?.htmlUrl ? `${workflowStatusText(latest)} / ${latest.htmlUrl}` : workflowStatusText(latest);
    steps = addExecutionStep(steps, attempt === 0 ? "Workflow status" : "Workflow update", detail, latest?.status === "completed" ? "done" : "active");
    if (latest?.status === "completed") return { run: latest, steps };
    await sleep(4000);
  }
  return { run: latest, steps };
}

function liveExecutionSummary(execution) {
  if (!execution || typeof execution !== "object") return "Live execution state is not available yet.";
  const selected = execution.selected || {};
  const response = execution.response || {};
  const monitoring = execution.monitoring || {};
  const attempts = Array.isArray(execution.attempts) ? execution.attempts : [];
  const lastAttempt = attempts[attempts.length - 1] || {};
  const idleCashLimit = Number(monitoring.idleCashLimitUsdc);
  const idleCashHours = Number(monitoring.idleCashHours);
  const lines = [
    `Action: ${execution.action || "-"}`,
    execution.reason ? `Reason: ${execution.reason}` : "",
    Number.isFinite(idleCashLimit)
      ? `Idle cash: ${monitoring.idleCashOverdue ? "overdue" : "monitored"} / limit ${money(idleCashLimit)} / ${Number.isFinite(idleCashHours) ? `${idleCashHours.toFixed(1)}h` : "-"}`
      : "",
    selected.question ? `Selected: ${selected.question} / ${selected.outcome || "-"}` : "",
    selected.orderType ? `Order: ${selected.orderType} ${selected.orderSize || "-"} @ ${probability(Number(selected.orderPrice))}` : "",
    response.orderID ? `Order ID: ${response.orderID}` : "",
    response.status ? `Polymarket status: ${response.status}` : "",
    lastAttempt.rejectReason ? `Last reject: ${lastAttempt.rejectReason}` : "",
  ];
  return lines.filter(Boolean).join("\n");
}

async function waitForExecutionResult(target, startedAt, steps) {
  const stateTarget = target === "live" ? "live-execution" : "paper";
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const payload = await fetchApiJson(`api.php?action=state&target=${stateTarget}`);
    const generated = Date.parse(payload.generatedAt || payload.lastDecision?.runAt || "");
    const start = Date.parse(startedAt || "");
    if (!Number.isFinite(start) || (Number.isFinite(generated) && generated >= start - 120000)) {
      const detail = target === "live"
        ? liveExecutionSummary(payload)
        : `Paper action: ${payload.lastDecision?.action || "-"} / ${payload.lastDecision?.reason || "-"}`;
      steps = addExecutionStep(steps, "Execution result", detail, "done");
      return { payload, steps };
    }
    await sleep(3000);
  }
  steps = addExecutionStep(steps, "Execution result", "Result state has not updated yet; dashboard will keep refreshing.", "active");
  return { payload: null, steps };
}

function currentEligibilityThreshold() {
  const configured = Number(state.eligibilityThreshold);
  const normalizedConfigured = normalizeEligibilityThreshold(configured);
  if (normalizedConfigured != null) return normalizedConfigured;
  const portfolio = state.botState?.portfolio || {};
  const fallback = Number(portfolio.minProbability ?? 0.95);
  return normalizeEligibilityThreshold(fallback) ?? DEFAULT_ELIGIBILITY_THRESHOLD;
}

function normalizeEligibilityThreshold(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  if (numeric < MIN_ELIGIBILITY_THRESHOLD || numeric > MAX_ELIGIBILITY_THRESHOLD) return null;
  return numeric;
}

function syncEligibilityThresholdControl() {
  const value = currentEligibilityThreshold();
  state.eligibilityThreshold = value;
  if (els.eligibilityThreshold) {
    els.eligibilityThreshold.value = String(Math.round(value * 100));
  }
  if (els.eligibilityThresholdLabel) {
    els.eligibilityThresholdLabel.textContent = probability(value);
  }
}

function isProbabilityRejectReason(reason) {
  return /probability .*below|below .*probability|high-confidence threshold|edge-opportunity threshold/i.test(String(reason || ""));
}

function nonProbabilityRejectReasons(item) {
  const reasons = (Array.isArray(item.rejectReasons) ? item.rejectReasons : []).filter((reason) => !isProbabilityRejectReason(reason));
  if (evaluationEnded(item) && !reasons.some((reason) => /end date|past|closed|accepting orders/i.test(String(reason || "")))) {
    reasons.push("event end date is in the past");
  }
  return reasons;
}

function adjustedEvaluationStatus(item) {
  const original = String(item.status || "-").toUpperCase();
  if (original === "ERROR") return "ERROR";
  if (evaluationEnded(item)) return "REJECTED";
  const aiProbability = Number(item.aiProbability);
  if (!Number.isFinite(aiProbability)) return original;
  const threshold = currentEligibilityThreshold();
  if (aiProbability < threshold) return "REJECTED";
  if (original === "ELIGIBLE") return "ELIGIBLE";
  if (original === "REJECTED" && nonProbabilityRejectReasons(item).length === 0) return "ELIGIBLE";
  return original;
}

function portfolioEvaluationStatus(item) {
  const status = adjustedEvaluationStatus(item);
  if (status === "ERROR") return "ERROR";
  if (status === "ELIGIBLE" && item.selectionStatus !== "RISK_BLOCKED") return "ELIGIBLE";
  return "REJECTED";
}

function evaluationReasons(item, riskReason = "") {
  const aiProbability = Number(item.aiProbability);
  const threshold = currentEligibilityThreshold();
  const adjustedStatus = adjustedEvaluationStatus(item);
  const reasons = [];
  if (riskReason) reasons.push(riskReason);
  if (Number.isFinite(aiProbability) && aiProbability < threshold) {
    reasons.push(`AI probability ${probability(aiProbability)} below selected ${probability(threshold)}`);
  }
  reasons.push(...nonProbabilityRejectReasons(item));
  if (adjustedStatus === "ELIGIBLE" && String(item.status || "").toUpperCase() === "REJECTED") {
    reasons.push("passes selected probability threshold after current portfolio settings");
  }
  return reasons.filter(Boolean);
}

async function loadBotState() {
  try {
    const botState = await fetchJson("data/paper-state.json");
    renderBotState(botState);
  } catch (error) {
    state.botState = null;
    if (els.botAction) els.botAction.textContent = "offline";
    if (els.botInlineAction) els.botInlineAction.textContent = "offline";
    els.botStatus.innerHTML = `<div class="error">${escapeHtml(error.message)}</div>`;
    els.botTrades.innerHTML = '<div class="empty">Autonomous paper portfolio state is not available yet.</div>';
    if (els.closedTrades) els.closedTrades.innerHTML = '<div class="empty">Closed paper trades are not available yet.</div>';
    if (els.closedSummary) els.closedSummary.textContent = "offline";
    els.botEvaluations.innerHTML = '<div class="empty">No common evaluation log loaded.</div>';
  }
}

async function fetchJson(path) {
  const statePath = String(path || "");
  const stateTarget = statePath === "data/live-state.json" ? "live" : (statePath === "data/paper-state.json" ? "paper" : "");
  const url = stateTarget
    ? `api.php?action=state&target=${stateTarget}&t=${Date.now()}`
    : `${statePath}?t=${Date.now()}`;
  const statePayload = await fetch(url, { cache: "no-store" });
  if (!statePayload.ok) throw new Error(`${path} HTTP ${statePayload.status}`);
  return statePayload.json();
}

async function fetchApiJson(url, options = {}) {
  const response = await fetch(`${url}${url.includes("?") ? "&" : "?"}t=${Date.now()}`, {
    cache: "no-store",
    ...options,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.ok === false) {
    throw new Error(payload.error || `${url} HTTP ${response.status}`);
  }
  return payload;
}

async function requestLiveAccountSync(options = {}) {
  if (state.autoLiveSyncBusy) return;
  state.autoLiveSyncBusy = true;
  const quiet = Boolean(options.quiet);
  const minSeconds = Math.max(30, Math.round(Number(options.minSeconds || LIVE_SYNC_REQUEST_MS / 1000)));
  if (!quiet) setExecutionStatus("syncing live account");
  try {
    const response = await fetch(`api.php?action=live-sync&minSeconds=${encodeURIComponent(minSeconds)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      cache: "no-store",
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.ok === false) {
      throw new Error(payload.error || `live sync HTTP ${response.status}`);
    }
    if (payload.action === "DISPATCH") {
      if (!quiet) setExecutionStatus("live sync started");
      [8000, 16000, 30000, 45000].forEach((delay) => {
        window.setTimeout(() => {
          loadDashboardState({ skipAutoLiveSync: true });
        }, delay);
      });
    } else {
      if (!quiet) setExecutionStatus("live account current");
    }
  } catch (error) {
    if (!quiet) setExecutionStatus(error.message || "live sync failed", "error");
  } finally {
    state.autoLiveSyncBusy = false;
  }
}

async function triggerOneTimeExecution(target) {
  const live = target === "live";
  if (live && !state.liveExecutionArmed) {
    window.alert("Nejdrive aktivuj live execution gate.");
    return;
  }
  if (live) {
    const confirmed = window.confirm("Spustit jednorazovou LIVE exekuci? Workflow znovu overi kandidaty a muze poslat realny Polymarket order.");
    if (!confirmed) return;
  }

  state.executionBusy = target;
  syncExecutionButtons();
  setExecutionStatus(live ? "starting live workflow" : "starting paper workflow");
  const startedAt = new Date().toISOString();
  openExecutionModal(target);
  let steps = [
    {
      title: live ? "Live execution requested" : "Paper execution requested",
      detail: `Started ${formatDate(startedAt)}`,
      tone: "active",
    },
  ];
  renderExecutionSteps(steps);

  try {
    const response = await fetch("api.php?action=workflow", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        target,
        ...(!live ? {
          max_order_fraction: currentRiskAllocation(),
        } : {
          min_probability: currentEligibilityThreshold(),
          max_order_fraction: currentRiskAllocation(),
        }),
      }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.ok === false) {
      throw new Error(payload.error || `workflow HTTP ${response.status}`);
    }
    steps = addExecutionStep(steps, "Workflow dispatched", payload.workflow || payload.message || "GitHub Actions accepted the request", "done");
    setExecutionStatus(`${target} workflow started`);
    steps = addExecutionStep(steps, "Revalidation running", live
      ? "The runner refreshes account state, revalidates candidates, checks risk diversification, then submits an order only if criteria still pass."
      : "The evaluation engine scans markets, prioritizes new opportunities, updates known evaluations, and may open one paper trade.", "active");
    const workflow = await waitForWorkflowRun(target, startedAt, steps);
    steps = workflow.steps;
    if (workflow.run?.conclusion && workflow.run.conclusion !== "success") {
      steps = addExecutionStep(steps, "Workflow finished with warning", `Conclusion: ${workflow.run.conclusion}`, "error");
      setExecutionStatus(`${target} workflow ${workflow.run.conclusion}`, "error");
      return;
    }
    const result = await waitForExecutionResult(target, startedAt, steps);
    steps = result.steps;
    steps = addExecutionStep(steps, "Dashboard refreshed", "Open positions and limit orders are shown in the tables below.", "done");
    setExecutionStatus(`${target} workflow completed`);
    await loadDashboardState();
  } catch (error) {
    steps = addExecutionStep(steps, "Execution failed", error.message || "workflow failed", "error");
    setExecutionStatus(error.message || "workflow failed", "error");
  } finally {
    state.executionBusy = null;
    syncExecutionButtons();
  }
}

async function loadLiveState(options = {}) {
  try {
    const [liveResult, botResult, executionResult] = await Promise.allSettled([
      fetchJson("data/live-state.json"),
      fetchJson("data/paper-state.json"),
      fetchJson("data/live-execution-state.json"),
    ]);
    if (liveResult.status === "rejected") throw liveResult.reason;
    state.botState = botResult.status === "fulfilled" ? botResult.value : null;
    state.liveExecutionState = executionResult.status === "fulfilled" ? executionResult.value : null;
    const liveState = liveResult.value;
    renderLiveState(liveState);
    if (!options.skipAutoLiveSync) {
      requestLiveAccountSync();
    }
    if (botResult.status === "rejected") {
      els.botEvaluations.innerHTML = `<div class="empty">Common evaluation log is not available: ${escapeHtml(botResult.reason?.message || String(botResult.reason))}</div>`;
    }
  } catch (error) {
    state.liveState = null;
    state.liveExecutionState = null;
    syncModeUi();
    if (els.botAction) els.botAction.textContent = "offline";
    if (els.botInlineAction) els.botInlineAction.textContent = "offline";
    els.portfolioEquity.textContent = "-";
    els.portfolioLastRun.textContent = "Live sync not available";
    els.portfolioTotalPl.textContent = "-";
    els.portfolioTotalPlPct.textContent = "-";
    els.portfolioAnnualized.textContent = "-";
    els.portfolioPeriod.textContent = "No live data";
    els.portfolioRealized.textContent = "-";
    els.portfolioRealizedPct.textContent = "-";
    renderClosedAccuracy([]);
    els.portfolioOpenPl.textContent = "-";
    els.portfolioOpenPlPct.textContent = "-";
    els.portfolioRisk.textContent = "-";
    els.portfolioFree.textContent = "-";
    if (els.portfolioRr) els.portfolioRr.textContent = "-";
    if (els.portfolioRrNote) els.portfolioRrNote.textContent = "live data not available";
    if (els.accountSummary) {
      els.accountSummary.hidden = false;
      els.accountSummary.innerHTML = `<div class="error">${escapeHtml(error.message)}</div>`;
    }
    els.botStatus.innerHTML = "";
    els.botStatus.hidden = true;
    els.botTrades.innerHTML = '<div class="empty">Live Polymarket account state is not available yet.</div>';
    if (els.closedTrades) els.closedTrades.innerHTML = '<div class="empty">Closed live trades are not available yet.</div>';
    if (els.closedSummary) els.closedSummary.textContent = "offline";
    if (state.botState) {
      renderBotEvaluations();
    } else {
      els.botEvaluations.innerHTML = '<div class="empty">Common evaluation log is not available yet.</div>';
    }
  }
}

function loadDashboardState(options = {}) {
  syncModeUi();
  return isLiveMode() ? loadLiveState(options) : loadBotState();
}

function paperPortfolioList(botState) {
  const portfolios = botState?.paperPortfolios && typeof botState.paperPortfolios === "object"
    ? Object.values(botState.paperPortfolios)
    : [];
  if (portfolios.length) return portfolios;
  return [{
    id: "conservative",
    label: "Conservative",
    selectionMetric: "EV p.a.",
    description: "Prioritizes eligible opportunities by EV p.a. and expected value.",
    portfolio: botState?.portfolio || {},
    trades: Array.isArray(botState?.trades) ? botState.trades : [],
    lastDecision: botState?.lastDecision || null,
  }];
}

function selectedPaperPortfolio(botState) {
  const portfolios = paperPortfolioList(botState);
  const strategyId = paperStrategyIdFromMode();
  return portfolios.find((item) => item.id === strategyId) || portfolios[0] || {};
}

function paperPortfolioTrades(portfolioState) {
  return (Array.isArray(portfolioState?.trades) ? portfolioState.trades : [])
    .map((trade) => ({
      ...trade,
      strategyId: trade.strategyId || portfolioState.id,
      strategyLabel: trade.strategyLabel || portfolioState.label,
    }));
}

function portfolioRuleLine(portfolio) {
  const parts = [];
  const orderLabel = portfolio.selectionOrder === "highest_reward_risk_first"
    ? "Highest R/R first"
    : "Highest EV p.a. first";
  const maxResolutionDays = Number(portfolio.maxResolutionDays);
  const minLiquidityUsdc = Number(portfolio.minLiquidityUsdc);
  parts.push(orderLabel);
  if (Number.isFinite(maxResolutionDays)) parts.push(`<= ${maxResolutionDays.toLocaleString("en-US", { maximumFractionDigits: 0 })} days`);
  else parts.push("preferred shortest horizon bucket");
  if (Number.isFinite(minLiquidityUsdc)) parts.push(`liquidity >= ${money(minLiquidityUsdc)}`);
  if (portfolio.requireMostProbableOutcome) parts.push("most probable outcome per market");
  return parts.join(" / ");
}

function renderBotState(botState) {
  state.botState = botState;
  syncModeUi();
  if (els.accountSummary) {
    els.accountSummary.hidden = true;
    els.accountSummary.innerHTML = "";
  }
  els.botStatus.hidden = false;
  refreshEligibilityThreshold();
  refreshRiskAllocation();
  refreshLimitOrders();
  const portfolioState = selectedPaperPortfolio(botState);
  const decision = portfolioState.lastDecision || botState.lastDecision || {};
  const portfolio = portfolioState.portfolio || botState.portfolio || {};
  const learning = botState.learningProfile || {};
  const trades = paperPortfolioTrades(portfolioState);
  const closedTrades = trades.filter(isClosedTrade);
  const openTrades = trades.filter((trade) => !isClosedTrade(trade));
  const portfolioRiskReward = averageRiskReward(trades, tradeRiskReward);
  const periodDays = portfolioPeriodDays(botState, trades);
  const annualized = annualizedPortfolioReturn(portfolio, periodDays);
  const totalPnl = Number(portfolio.totalPnlUsdc || 0);
  const totalPnlPct = Number(portfolio.totalPnlPct || 0);
  const realizedPnl = Number(portfolio.realizedPnlUsdc || 0);
  const realizedPnlPct = Number(portfolio.realizedPnlPct || 0);
  const openPnl = Number(portfolio.openPnlUsdc || 0);
  const openPnlPct = Number(portfolio.openPnlPct || 0);
  const freeCapital = Number(portfolio.freeCapitalUsdc ?? portfolio.initialUsdc ?? 100);
  const paperCapitalBase = Number(portfolio.initialUsdc ?? 100);
  const maxResolutionDays = Number(portfolio.maxResolutionDays);
  const resolutionLabel = Number.isFinite(maxResolutionDays)
    ? `No later than ${maxResolutionDays.toLocaleString("en-US", { maximumFractionDigits: 0 })} days`
    : "Best available horizon";
  syncRiskAllocationControl(freeCapital, "paper portfolio", {
    baseCapital: paperCapitalBase,
    cadenceLabel: "next paper execution",
  });

  if (els.botAction) els.botAction.textContent = decision.action || "waiting";
  if (els.botInlineAction) els.botInlineAction.textContent = decision.action || "waiting";
  els.portfolioEquity.textContent = money(Number(portfolio.equityUsdc ?? portfolio.initialUsdc ?? 100));
  els.portfolioEquity.className = pnlClass(totalPnl);
  els.portfolioLastRun.textContent = `Last run ${botState.generatedAt ? formatDate(botState.generatedAt) : "-"}`;
  els.portfolioTotalPl.textContent = signedMoney(totalPnl);
  els.portfolioTotalPl.className = pnlClass(totalPnl);
  els.portfolioTotalPlPct.textContent = signedPercent(totalPnlPct);
  els.portfolioAnnualized.textContent = signedPercent(annualized);
  els.portfolioAnnualized.className = pnlClass(annualized);
  els.portfolioPeriod.textContent = periodDays == null ? "No trades yet" : `since first trade, ${periodDays.toFixed(1)} days`;
  els.portfolioRealized.textContent = signedMoney(realizedPnl);
  els.portfolioRealized.className = pnlClass(realizedPnl);
  els.portfolioRealizedPct.textContent = signedPercent(realizedPnlPct);
  renderClosedAccuracy(closedTrades);
  els.portfolioOpenPl.textContent = signedMoney(openPnl);
  els.portfolioOpenPl.className = pnlClass(openPnl);
  els.portfolioOpenPlPct.textContent = signedPercent(openPnlPct);
  els.portfolioRisk.textContent = money(Number(portfolio.openRiskUsdc || 0));
  els.portfolioFree.textContent = `${money(freeCapital)} free`;
  if (els.portfolioRr) {
    els.portfolioRr.textContent = riskReward(portfolioRiskReward);
    els.portfolioRr.className = riskRewardClass(portfolioRiskReward);
  }
  if (els.portfolioRrNote) {
    els.portfolioRrNote.textContent = trades.length ? `avg all, ${trades.length} trades` : "no trades";
  }

  els.botStatus.innerHTML = `
    <div class="bot-summary">
      <div>
        <span class="label">Last run</span>
        <strong>${escapeHtml(botState.generatedAt ? formatDate(botState.generatedAt) : "not yet")}</strong>
      </div>
      <div>
        <span class="label">Free capital</span>
        <strong>${money(freeCapital)}</strong>
      </div>
      <div>
        <span class="label">Max per trade</span>
        <strong>${money(freeCapital * currentRiskAllocation())}</strong>
        <span>${probability(currentRiskAllocation())} of paper free capital</span>
      </div>
      <div>
        <span class="label">Order mode</span>
        <strong>${currentLimitOrders() ? "Limit" : "Market"}</strong>
        <span>paper execution preference</span>
      </div>
      <div>
        <span class="label">P/L</span>
        <strong class="${pnlClass(totalPnl)}">${signedMoney(totalPnl)} (${signedPercent(totalPnlPct)})</strong>
        <span>realized ${signedMoney(realizedPnl)} / open ${signedMoney(openPnl)}</span>
      </div>
      <div>
        <span class="label">Portfolio parameters</span>
        <strong>${percent(Number(portfolio.minProbability ?? 0.95))} AI threshold</strong>
        <span>${escapeHtml(portfolioRuleLine(portfolio) || resolutionLabel)}</span>
      </div>
      <div>
        <span class="label">Learning</span>
        <strong>${Number(learning.sampleSize || 0)} reviewed</strong>
        <span>Brier ${Number.isFinite(Number(learning.brierScore)) ? Number(learning.brierScore).toFixed(3) : "-"} / bias ${Number.isFinite(Number(learning.calibrationBias)) ? signedPercent(Number(learning.calibrationBias)) : "-"}</span>
      </div>
      <div>
        <span class="label">Decision</span>
        <strong>${escapeHtml(decision.reason || "-")}</strong>
        <span>${Number(decision.riskSkippedCount || 0) ? `${decision.riskSkippedCount} risk-blocked` : ""}</span>
      </div>
    </div>
  `;

  els.botTrades.innerHTML = renderTradeRows(openTrades.slice(0, 12), "Zatim zadne otevrene autonomni paper obchody.", {
    tableKey: "open",
    showStatus: false,
  });
  if (els.closedSummary) {
    const closedPnl = closedTrades.reduce((sum, trade) => sum + Number(trade.realizedPnlUsdc || 0), 0);
    els.closedSummary.textContent = `${closedTrades.length} closed / ${signedMoney(closedPnl)}`;
  }
  if (els.closedTrades) {
    els.closedTrades.innerHTML = renderTradeRows(closedTrades, "Zatim zadne ukoncene paper obchody.", {
      tableKey: "closed",
      showStatus: true,
    });
  }

  renderBotEvaluations();
  renderRunLog();
}

function livePositions(liveState) {
  return Array.isArray(liveState?.positions) ? liveState.positions.filter((trade) => !isClosedTrade(trade)) : [];
}

function liveOpenOrders(liveState) {
  return Array.isArray(liveState?.openOrders) ? liveState.openOrders : [];
}

function liveActivity(liveState) {
  return Array.isArray(liveState?.activity) ? liveState.activity : [];
}

function liveClosedTrades(liveState) {
  if (Array.isArray(liveState?.closedTrades)) return liveState.closedTrades;
  if (Array.isArray(liveState?.trades?.closed)) return liveState.trades.closed;
  return [];
}

function evaluationByTokenId(tokenId) {
  const token = String(tokenId || "");
  if (!token) return null;
  const evaluations = Array.isArray(state.botState?.evaluations) ? state.botState.evaluations : [];
  return evaluations.find((item) => String(item.tokenId || item.clobTokenId || "") === token) || null;
}

function normalizedMatchText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function evaluationByTrade(item) {
  const byToken = evaluationByTokenId(item?.tokenId || item?.assetId || item?.asset);
  if (byToken) return byToken;

  const evaluations = Array.isArray(state.botState?.evaluations) ? state.botState.evaluations : [];
  const outcome = normalizedMatchText(item?.outcome || item?.side);
  const slug = normalizedMatchText(item?.eventSlug || item?.slug);
  const question = normalizedMatchText(item?.question || item?.title || item?.market);
  if (!outcome) return null;

  return evaluations.find((candidate) => {
    const candidateOutcome = normalizedMatchText(candidate.outcome);
    if (candidateOutcome !== outcome) return false;
    const candidateSlug = normalizedMatchText(candidate.eventSlug || candidate.slug);
    if (slug && candidateSlug && slug === candidateSlug) return true;
    const candidateQuestion = normalizedMatchText(candidate.question);
    return question && candidateQuestion && question === candidateQuestion;
  }) || null;
}

function decorateLiveTradeForTable(trade) {
  if (trade.sourceEvaluation || Number.isFinite(Number(trade.aiProbability))) return trade;
  const source = evaluationByTrade(trade);
  if (!source) {
    return {
      ...trade,
      analysisSummary: trade.analysisSummary || "No matching AI evaluation was found for this live Polymarket row. Treat this as an audit gap until the order/execution ledger links it back to an evaluated candidate.",
    };
  }
  return {
    ...trade,
    aiProbability: Number(source.aiProbability),
    rawProbability: Number(source.rawProbability),
    thesisType: source.thesisType,
    annualizedReturn: trade.annualizedReturn ?? source.annualizedReturn,
    expectedValueUsdc: trade.expectedValueUsdc ?? source.expectedValueUsdc,
    edge: trade.edge ?? source.edge,
    sourceEvaluation: source,
    aiAnalysis: trade.aiAnalysis || source.aiAnalysis || null,
    probabilityThesis: trade.probabilityThesis || source.probabilityThesis || source.aiAnalysis?.thesis || "",
    analysisModel: trade.analysisModel || source.analysisModel || source.aiAnalysis?.model || "",
    analysisSummary: [
      trade.analysisSummary || "",
      source.analysisSummary ? `Original AI evaluation: ${source.analysisSummary}` : "",
    ].filter(Boolean).join(" "),
  };
}

function normalizeLiveOpenOrderForTable(order) {
  const source = evaluationByTrade(order);
  const price = Number(order.price);
  const remainingSize = Number(order.remainingSize ?? order.originalSize ?? 0);
  const notional = Number(order.notionalUsdc);
  const stake = Number.isFinite(notional) ? notional : (Number.isFinite(price) ? price * remainingSize : 0);
  return {
    id: `open-order-${order.id}`,
    mode: "LIVE_ORDER",
    status: "LIMIT ORDER",
    question: source?.question || order.question || "Open live limit order",
    outcome: source?.outcome || order.outcome || order.side || "-",
    slug: source?.slug || source?.eventSlug || "",
    eventSlug: source?.eventSlug || source?.slug || "",
    url: source ? polymarketUrl(source) : "https://polymarket.com/",
    tokenId: order.tokenId || order.assetId || null,
    date: order.createdAt || null,
    openedAt: order.createdAt || null,
    openedAtSource: order.createdAt ? "open-orders-api" : "unknown",
    endDate: source?.endDate || null,
    entryPrice: price,
    currentPrice: Number(source?.marketPrice),
    shares: remainingSize,
    stakeUsdc: stake,
    totalCostUsdc: stake,
    netGainIfWinUsdc: Number.isFinite(remainingSize) ? remainingSize - stake : null,
    unrealizedPnlUsdc: 0,
    unrealizedPnlPct: 0,
    aiProbability: Number(source?.aiProbability),
    sourceEvaluation: source || null,
    analysisSummary: `Open ${order.side || ""} limit order, ${remainingSize.toLocaleString("en-US", { maximumFractionDigits: 4 })} shares at ${probability(price)}. Matched ${Number(order.sizeMatched || 0).toLocaleString("en-US", { maximumFractionDigits: 4 })} shares.`,
  };
}

function liveAccountName(account = {}) {
  const profile = account.profile || {};
  return profile.displayName || profile.pseudonym || account.label || shortAddress(account.address);
}

function liveAccountSubtitle(account = {}) {
  const profile = account.profile || {};
  const parts = [
    profile.xUsername ? `X @${profile.xUsername}` : "",
    profile.verifiedBadge ? "verified" : "",
    account.connectionMode || "public API sync",
  ];
  return parts.filter(Boolean).join(" / ") || "public profile not published";
}

function liveAccountProfileLine(account = {}) {
  const profile = account.profile || {};
  return [
    profile.pseudonym ? `pseudonym ${profile.pseudonym}` : "",
    profile.displayUsernamePublic === false ? "username hidden" : "",
    account.loginMethod || "",
  ].filter(Boolean).join(" / ");
}

function renderLiveState(liveState) {
  state.liveState = liveState;
  syncModeUi();
  refreshEligibilityThreshold();
  refreshRiskAllocation();
  refreshLimitOrders();

  const account = liveState.account || {};
  const portfolio = liveState.portfolio || {};
  const balanceAllowance = liveState.balanceAllowance || {};
  const collateral = balanceAllowance.collateral || {};
  const positions = livePositions(liveState).map(decorateLiveTradeForTable);
  const openOrders = liveOpenOrders(liveState);
  const openedRows = [
    ...positions,
    ...openOrders.map(normalizeLiveOpenOrderForTable),
  ];
  const activity = liveActivity(liveState);
  const closedTrades = liveClosedTrades(liveState).map(decorateLiveTradeForTable);
  const portfolioRiskReward = averageRiskReward([...openedRows, ...closedTrades], tradeRiskReward);
  const sync = liveState.sync || {};
  const reconciliation = liveState.reconciliation || {};
  const reconciliationGaps = Number(reconciliation.orphanedCount || 0);
  const sources = Array.isArray(sync.sources) ? sync.sources : [];
  const totalPnl = Number(portfolio.totalPnlUsdc);
  const totalPnlPct = Number(portfolio.totalPnlPct);
  const realizedPnl = Number(portfolio.realizedPnlUsdc);
  const realizedPnlPct = Number(portfolio.realizedPnlPct);
  const openPnl = Number(portfolio.openPnlUsdc);
  const openPnlPct = Number(portfolio.openPnlPct);
  const marketValue = Number(portfolio.marketValueUsdc);
  const cash = Number(portfolio.cashUsdc);
  const executionState = state.liveExecutionState || {};
  const monitoring = executionState.monitoring || {};
  const idleCashLimit = Number(monitoring.idleCashLimitUsdc);
  const idleCashHours = Number(monitoring.idleCashHours);
  const idleCashOverdue = Boolean(monitoring.idleCashOverdue);
  const idleCashStatus = idleCashOverdue ? "Overdue" : (monitoring.cashAboveIdleLimit ? "Grace period" : "OK");
  const idleCashDetail = Number.isFinite(idleCashLimit)
    ? `${Number.isFinite(cash) ? money(cash) : "-"} cash / limit ${money(idleCashLimit)} / idle ${Number.isFinite(idleCashHours) ? `${idleCashHours.toFixed(1)}h` : "-"}`
    : "live execution monitor not available yet";
  const equity = Number.isFinite(Number(portfolio.equityUsdc))
    ? Number(portfolio.equityUsdc)
    : (Number.isFinite(marketValue) ? marketValue : 0);
  const deposited = Number(portfolio.depositedUsdc);
  const depositedLine = Number.isFinite(deposited)
    ? `Deposited/original value ${money(deposited)}`
    : "Deposited/original value not available";
  const liveCapitalBase = Number.isFinite(cash) ? cash : null;
  const liveGuardLabel = state.liveExecutionArmed ? "Armed" : "Inactive";
  const liveGuardText = state.liveExecutionArmed
    ? "UI gate enabled; no automatic live order submitter is connected yet"
    : "click Activate live execution before future live order routing";
  syncRiskAllocationControl(liveCapitalBase, Number.isFinite(cash) ? "live pUSD cash" : "live cash once balance sync is available", {
    baseCapital: liveCapitalBase,
    cadenceLabel: "next live execution",
  });

  if (els.botAction) els.botAction.textContent = "live";
  if (els.botInlineAction) els.botInlineAction.textContent = `${positions.length} positions / ${openOrders.length} orders`;
  els.portfolioEquity.textContent = money(equity);
  els.portfolioEquity.className = pnlClass(totalPnl);
  els.portfolioLastRun.innerHTML = `
    ${escapeHtml(liveAccountName(account))} / sync ${escapeHtml(liveState.generatedAt ? formatDate(liveState.generatedAt) : "-")}
    <small class="metric-note">${escapeHtml(depositedLine)}</small>
  `;
  els.portfolioTotalPl.textContent = signedMoney(totalPnl);
  els.portfolioTotalPl.className = pnlClass(totalPnl);
  els.portfolioTotalPlPct.textContent = signedPercent(totalPnlPct);
  els.portfolioAnnualized.textContent = "-";
  els.portfolioAnnualized.className = "";
  els.portfolioPeriod.textContent = "based on live account snapshot";
  els.portfolioRealized.textContent = signedMoney(realizedPnl);
  els.portfolioRealized.className = pnlClass(realizedPnl);
  els.portfolioRealizedPct.textContent = signedPercent(realizedPnlPct);
  renderClosedAccuracy(closedTrades);
  els.portfolioOpenPl.textContent = signedMoney(openPnl);
  els.portfolioOpenPl.className = pnlClass(openPnl);
  els.portfolioOpenPlPct.textContent = signedPercent(openPnlPct);
  els.portfolioRisk.textContent = money(Number(portfolio.openRiskUsdc || marketValue || 0));
  els.portfolioFree.textContent = Number.isFinite(cash) ? `${money(cash)} cash` : "cash not available";
  if (els.portfolioRr) {
    els.portfolioRr.textContent = riskReward(portfolioRiskReward);
    els.portfolioRr.className = riskRewardClass(portfolioRiskReward);
  }
  if (els.portfolioRrNote) {
    const portfolioRows = openedRows.length + closedTrades.length;
    els.portfolioRrNote.textContent = portfolioRows ? `avg all, ${portfolioRows} rows` : "no rows";
  }

  if (els.accountSummary) {
    els.accountSummary.hidden = false;
    els.accountSummary.innerHTML = `
    <div class="bot-summary">
      <div>
        <span class="label">Synced account</span>
        <strong>${escapeHtml(liveAccountName(account))}</strong>
        <span>${escapeHtml(shortAddress(account.address))} / ${escapeHtml(liveAccountSubtitle(account))}</span>
      </div>
      <div>
        <span class="label">Last sync</span>
        <strong>${escapeHtml(liveState.generatedAt ? formatDate(liveState.generatedAt) : "not yet")}</strong>
        <span>${escapeHtml(liveAccountProfileLine(account) || "Polymarket proxy wallet")}</span>
      </div>
      <div>
        <span class="label">Sync status</span>
        <strong>${escapeHtml(sync.status || "OK")}</strong>
        <span>${escapeHtml([sync.message || "latest live snapshot loaded", sources.join(", ")].filter(Boolean).join(" / "))}</span>
      </div>
      <div>
        <span class="label">Positions</span>
        <strong>${positions.length}</strong>
        <span>${money(marketValue)} market value / ${openOrders.length} open orders${reconciliationGaps ? ` / ${reconciliationGaps} sync gap` : ""}</span>
      </div>
      <div>
        <span class="label">Ledger check</span>
        <strong class="${reconciliationGaps ? "negative" : ""}">${escapeHtml(reconciliation.status || "OK")}</strong>
        <span>${escapeHtml(reconciliationGaps ? `${reconciliationGaps} known trade kept visible as reconciliation row` : (reconciliation.invariant || "all known trades are classified"))}</span>
      </div>
      <div>
        <span class="label">Max per trade</span>
        <strong>${Number.isFinite(liveCapitalBase) ? money(liveCapitalBase * currentRiskAllocation()) : "-"}</strong>
        <span>${probability(currentRiskAllocation())} of synced live cash</span>
      </div>
      <div>
        <span class="label">Open P/L</span>
        <strong class="${pnlClass(openPnl)}">${signedMoney(openPnl)} (${signedPercent(openPnlPct)})</strong>
        <span>from Polymarket live positions</span>
      </div>
      <div>
        <span class="label">Realized P/L</span>
        <strong class="${pnlClass(realizedPnl)}">${signedMoney(realizedPnl)} (${signedPercent(realizedPnlPct)})</strong>
        <span>where available from activity data</span>
      </div>
      <div>
        <span class="label">Cash</span>
        <strong>${Number.isFinite(cash) ? money(cash) : "-"}</strong>
        <span>${escapeHtml(balanceAllowance.status === "OK" ? `pUSD balance / allowance ${collateral.allowanceUsdc == null ? "-" : money(Number(collateral.allowanceUsdc))}` : (balanceAllowance.message || "CLOB balance sync not available yet"))}</span>
      </div>
      <div>
        <span class="label">Idle cash guard</span>
        <strong class="${idleCashOverdue ? "negative" : ""}">${escapeHtml(idleCashStatus)}</strong>
        <span>${escapeHtml(idleCashDetail)}</span>
      </div>
      <div>
        <span class="label">Original value</span>
        <strong>${Number.isFinite(deposited) ? money(deposited) : "-"}</strong>
        <span>${escapeHtml(portfolio.depositedSource || "estimated from equity and tracked P/L")}</span>
      </div>
      <div>
        <span class="label">Live execution</span>
        <strong>${escapeHtml(liveGuardLabel)}</strong>
        <span>${escapeHtml(`${liveGuardText}; ${currentLimitOrders() ? "limit orders preferred" : "market orders preferred"}`)}</span>
      </div>
      <div>
        <span class="label">Portfolio parameters</span>
        <strong>${percent(currentEligibilityThreshold())} AI threshold</strong>
        <span>${escapeHtml(`Revalidate first / risk-diversified / ${currentLimitOrders() ? "limit" : "market"} orders / ${probability(currentRiskAllocation())} cash stake`)}</span>
      </div>
    </div>
  `;
  }
  els.botStatus.innerHTML = "";
  els.botStatus.hidden = true;

  els.botTrades.innerHTML = renderTradeRows(openedRows, "Zatim zadne otevrene live pozice ani limit objednavky na napojenem Polymarket uctu.", {
    tableKey: "live",
    showStatus: false,
  });
  if (els.closedSummary) {
    const closedPnl = closedTrades.reduce((sum, trade) => sum + Number(trade.realizedPnlUsdc || 0), 0);
    els.closedSummary.textContent = `${closedTrades.length} closed / ${activity.length} events / ${signedMoney(closedPnl)}`;
  }
  if (els.closedTrades) {
    els.closedTrades.innerHTML = renderTradeRows(closedTrades, "Zatim zadne ukoncene live obchody na napojenem Polymarket uctu.", {
      tableKey: "liveClosed",
      showStatus: true,
    });
  }
  renderBotEvaluations();
  renderRunLog();
}

function evaluationSortValue(item, key) {
  if (key === "evaluatedAt") return Date.parse(item.evaluatedAt || "") || 0;
  if (key === "status") return portfolioEvaluationStatus(item);
  if (key === "market") return `${item.outcome || ""} ${item.question || ""}`.toLowerCase();
  if (key === "endDate") return Date.parse(evaluationEndDate(item) || "") || 0;
  if (key === "daysLeft") return evaluationDaysLeft(item);
  if (key === "marketPrice") return Number(item.marketPrice);
  if (key === "odds") return decimalOdds(item.marketPrice);
  if (key === "gainIfWin") return gainIfWin(item);
  if (key === "netYield") return netYield(item);
  if (key === "riskReward") return evaluationRiskReward(item);
  if (key === "aiProbability") return Number(item.aiProbability);
  if (key === "annualizedReturn") return annualizedExpectedReturn(item);
  if (key === "updates") return Number(item.evaluationCount || 1);
  if (key === "analysis") return `${evaluationReasons(item).join("; ")} ${item.analysisSummary || ""}`.toLowerCase();
  return "";
}

function sortedEvaluations(evaluations) {
  const direction = state.evaluationSort.direction === "asc" ? 1 : -1;
  const key = state.evaluationSort.key;
  return [...evaluations].sort((a, b) => {
    const aValue = evaluationSortValue(a, key);
    const bValue = evaluationSortValue(b, key);
    const aMissing = aValue == null || Number.isNaN(aValue);
    const bMissing = bValue == null || Number.isNaN(bValue);
    if (aMissing && bMissing) return 0;
    if (aMissing) return 1;
    if (bMissing) return -1;
    if (typeof aValue === "number" && typeof bValue === "number") return (aValue - bValue) * direction;
    return String(aValue).localeCompare(String(bValue)) * direction;
  });
}

function filteredEvaluations(evaluations) {
  if (state.evaluationStatus === "ALL") return evaluations;
  return evaluations.filter((item) => portfolioEvaluationStatus(item) === state.evaluationStatus);
}

function sortableHeader(key, label) {
  const active = state.evaluationSort.key === key ? " active" : "";
  return `<th><button class="sort-button${active}" type="button" data-evaluation-sort="${key}">${label}${sortArrow(key)}</button></th>`;
}

function gainCell(item) {
  const gain = gainIfWin(item);
  const ev = expectedValue(item);
  const fee = evaluationTradingFee(item);
  return `
    <span class="${Number(gain) >= 0 ? "positive" : "negative"}">${signedMoney(gain)}</span>
    <span>profit if win</span>
    <span>${currentLimitOrders() ? "limit maker fee $0" : `market taker fee ${money(fee, 5)}`}</span>
    <span class="${pnlClass(ev)}">EV ${signedMoney(ev, 4)}</span>
  `;
}

function netYieldCell(item) {
  const value = netYield(item);
  return `
    <span class="${pnlClass(value)}">${signedPercent(value)}</span>
    <span>${currentLimitOrders() ? "after maker fee" : "after taker fee"}</span>
  `;
}

function evaluationRiskRewardCell(item) {
  const value = evaluationRiskReward(item);
  return `
    <span class="${riskRewardClass(value)}">${riskReward(value)}</span>
    <span>reward / risk</span>
  `;
}

function evaluationEndDateCell(item) {
  const endDate = evaluationEndDate(item);
  const inferred = inferredDateFromQuestion({
    ...item,
    openedAt: item.openedAt || item.evaluatedAt,
    date: item.date || item.evaluatedAt,
  });
  const inferredNote = inferred && item.endDate && Date.parse(inferred) > Date.parse(item.endDate) ? "from question" : "";
  return `
    ${escapeHtml(endDate ? formatDate(endDate) : "-")}
    <span>${escapeHtml(inferredNote || "final day")}</span>
  `;
}

function evaluationDaysLeftCell(item) {
  const days = evaluationDaysLeft(item);
  return `
    ${Number.isFinite(days) ? compactDays(days) : "-"}
    <span>to final day</span>
  `;
}

function annualizedCell(item) {
  const annualized = annualizedExpectedReturn(item);
  const ev = expectedValue(item);
  const days = daysToResolution(item);
  return `
    <span class="${pnlClass(annualized)}">${signedPercent(annualized)}</span>
    <span>${Number.isFinite(days) ? `${days.toFixed(1)}d horizon` : "horizon n/a"}</span>
    <span class="${pnlClass(ev)}">EV ${signedMoney(ev, 4)}</span>
  `;
}

function updateHistoryCell(item) {
  const count = Number(item.evaluationCount || 1);
  const history = Array.isArray(item.updateHistory) ? item.updateHistory : [];
  const detail = [
    `Evaluations: ${count}`,
    item.firstEvaluatedAt ? `First: ${formatDate(item.firstEvaluatedAt)}` : "",
    item.lastSeenAt ? `Last: ${formatDate(item.lastSeenAt)}` : "",
    ...history.slice(0, 8).map((entry) => {
      const changes = Array.isArray(entry.changes) ? entry.changes : [];
      const lines = changes.slice(0, 8).map((change) => `${change.field}: ${change.from ?? "-"} -> ${change.to ?? "-"}`);
      return [`${formatDate(entry.changedAt || "")}:`, ...lines].join("\n");
    }),
  ].filter(Boolean).join("\n\n");

  return `
    <span>${count.toLocaleString("en-US")}</span>
    <span>${history.length ? `${history.length} changed` : "no material change"}</span>
    ${history.length ? `
      <span class="analysis-popover">
        <button class="info-button" type="button" aria-label="Show evaluation update history">i</button>
        <span class="analysis-tooltip" role="tooltip">${escapeHtml(detail)}</span>
      </span>
    ` : ""}
  `;
}

function renderBotEvaluations() {
  const evaluations = Array.isArray(state.botState?.evaluations) ? state.botState.evaluations : [];
  const eligibleCount = evaluations.filter((item) => portfolioEvaluationStatus(item) === "ELIGIBLE").length;
  const errorCount = evaluations.filter((item) => portfolioEvaluationStatus(item) === "ERROR").length;
  const notEligibleCount = Math.max(0, evaluations.length - eligibleCount - errorCount);

  if (els.evaluationSummary) {
    els.evaluationSummary.textContent = `${eligibleCount} eligible / ${notEligibleCount} not eligible / ${errorCount} errors / ${evaluations.length} evaluated`;
  }

  if (!evaluations.length) {
    els.botEvaluations.innerHTML = '<div class="empty">Zatim zadna vyhodnoceni.</div>';
    return;
  }

  const visibleEvaluations = sortedEvaluations(filteredEvaluations(evaluations)).slice(0, 80);

  if (!visibleEvaluations.length) {
    els.botEvaluations.innerHTML = `<div class="empty">No ${evaluationFilterLabel(state.evaluationStatus)} markets in the latest evaluation log.</div>`;
    return;
  }

  els.botEvaluations.innerHTML = `
    <table>
      <thead>
        <tr>
          ${sortableHeader("evaluatedAt", "Time")}
          ${sortableHeader("status", "Status")}
          ${sortableHeader("market", "Market")}
          ${sortableHeader("endDate", "End date")}
          ${sortableHeader("daysLeft", "Days left")}
          ${sortableHeader("marketPrice", "Mkt entry")}
          ${sortableHeader("odds", "Odds")}
          ${sortableHeader("gainIfWin", "Win @ $5")}
          ${sortableHeader("netYield", "Net yield %")}
          ${sortableHeader("riskReward", "R/R")}
          ${sortableHeader("aiProbability", "AI prob.")}
          ${sortableHeader("annualizedReturn", "EV p.a.")}
          ${sortableHeader("updates", "Updates")}
          ${sortableHeader("analysis", "Analysis")}
        </tr>
      </thead>
      <tbody>
        ${visibleEvaluations.map((item) => `
          <tr>
            <td data-label="Time">${escapeHtml(formatDate(item.evaluatedAt || ""))}</td>
            <td data-label="Status" class="${evaluationStatusClass(item)}">${escapeHtml(evaluationStatusLabel(item))}</td>
            <td data-label="Market">
              ${marketAnchor(item)}
              <span>${escapeHtml(riskLine(item))}</span>
            </td>
            <td data-label="End date">${evaluationEndDateCell(item)}</td>
            <td data-label="Days left">${evaluationDaysLeftCell(item)}</td>
            <td data-label="Mkt entry">
              ${probability(Number(item.marketPrice))}
              <span>${[
                item.bestAsk == null ? "" : `ask ${probability(Number(item.bestAsk))}`,
                item.slippage == null ? "" : `slip ${(Number(item.slippage) * 100).toFixed(1)} pts`,
                feeLine(item),
              ].filter(Boolean).join(", ")}</span>
            </td>
            <td data-label="Odds">${odds(decimalOdds(item.marketPrice))}</td>
            <td data-label="Win @ $5">${gainCell(item)}</td>
            <td data-label="Net yield %">${netYieldCell(item)}</td>
            <td data-label="R/R">${evaluationRiskRewardCell(item)}</td>
            <td data-label="AI prob.">${probability(Number(item.aiProbability))}</td>
            <td data-label="EV p.a.">${annualizedCell(item)}</td>
            <td data-label="Updates">${updateHistoryCell(item)}</td>
            <td data-label="Analysis">
              ${analysisBadge(item)}
            </td>
          </tr>
        `).join("")}
      </tbody>
    </table>
  `;
}

function runEventDetail(event) {
  const reasons = Array.isArray(event.rejectReasons) && event.rejectReasons.length
    ? event.rejectReasons.join("; ")
    : "No filter reason recorded.";
  const risk = Array.isArray(event.riskGroupLabels) && event.riskGroupLabels.length
    ? event.riskGroupLabels.join(", ")
    : "-";
  return [
    `${event.outcome || "-"} - ${event.question || "-"}`,
    "",
    `Portfolio status: ${String(event.status || "").toUpperCase() === "ELIGIBLE" ? "ELIGIBLE" : "NOT ELIGIBLE"}`,
    `Stored pipeline status: ${event.status || "-"}`,
    `AI probability: ${probability(Number(event.aiProbability))}`,
    `Raw probability: ${probability(Number(event.rawProbability))}`,
    `Market entry: ${probability(Number(event.marketPrice))}`,
    `EV p.a.: ${signedPercent(Number(event.annualizedReturn))}`,
    `Expected value: ${signedMoney(Number(event.expectedValueUsdc), 4)}`,
    `Win if correct: ${signedMoney(Number(event.netGainIfWinUsdc), 4)}`,
    `R/R: ${riskReward(Number(event.riskReward))}`,
    `Liquidity: ${money(Number(event.liquidity || 0))}`,
    `24h volume: ${money(Number(event.volume24hr || 0))}`,
    `End date: ${event.endDate ? formatDate(event.endDate) : "-"}`,
    `Days to resolution: ${Number.isFinite(Number(event.daysToResolution)) ? Number(event.daysToResolution).toFixed(2) : "-"}`,
    `Model: ${event.analysisModel || "-"}`,
    `Risk groups: ${risk}`,
    "",
    `Thesis: ${event.probabilityThesis || "-"}`,
    "",
    `AI analysis: ${event.analysisSummary || "-"}`,
    "",
    `Filter reasons: ${reasons}`,
    "",
    `Polymarket: ${event.url || polymarketUrl(event)}`,
  ].join("\n");
}

function renderRunLog() {
  const runs = Array.isArray(state.botState?.evaluationRunLog) ? state.botState.evaluationRunLog : [];
  if (els.runLogSummary) {
    els.runLogSummary.textContent = `${runs.length} runs`;
  }
  if (!els.runLog) return;
  if (!runs.length) {
    els.runLog.innerHTML = '<div class="empty">Evaluation run log is not available yet. It will appear after the next evaluation run.</div>';
    return;
  }

  els.runLog.innerHTML = runs.slice(0, 30).map((run, runIndex) => {
    const events = Array.isArray(run.events) ? run.events : [];
    const status = run.statusCounts || {};
    return `
      <section class="run-card">
        <div class="run-card-head">
          <div>
            <strong>${escapeHtml(formatDate(run.runAt || ""))}</strong>
            <span>${run.refreshOnly ? "refresh-only" : "full evaluation"} / ${Number(run.evaluatedCount || events.length)} evaluated</span>
          </div>
          <div class="run-counts">
            <span class="pill">${Number(run.eligibleCount || status.ELIGIBLE || 0)} eligible</span>
            <span class="pill muted">${Number(run.rejectedCount || status.REJECTED || 0)} not eligible</span>
            ${Number(run.errorCount || status.ERROR || 0) ? `<span class="pill error">${Number(run.errorCount || status.ERROR || 0)} error</span>` : ""}
          </div>
        </div>
        <div class="run-events">
          ${events.length ? events.slice(0, 80).map((event, eventIndex) => `
            <button class="run-event" type="button" data-run-event="${runIndex}:${eventIndex}">
              <span class="${String(event.status || "").toUpperCase() === "ELIGIBLE" ? "positive" : ""}">${escapeHtml(String(event.status || "").toUpperCase() === "ELIGIBLE" ? "ELIGIBLE" : "NOT ELIGIBLE")}</span>
              <strong>${escapeHtml(event.outcome || "-")}</strong>
              <span>${escapeHtml(event.question || "-")}</span>
              <em>${probability(Number(event.aiProbability))} AI / ${signedPercent(Number(event.annualizedReturn))} EV p.a.</em>
            </button>
          `).join("") : '<div class="run-empty">No market evaluations in this refresh-only run.</div>'}
        </div>
      </section>
    `;
  }).join("");
}

els.tabButtons.forEach((button) => {
  button.addEventListener("click", () => {
    const target = button.dataset.tabTarget;
    els.tabButtons.forEach((item) => {
      item.classList.toggle("active", item === button);
    });
    els.tabPanels.forEach((panel) => {
      panel.classList.toggle("active", panel.dataset.tabPanel === target);
    });
  });
});

els.modeButtons.forEach((button) => {
  button.addEventListener("click", () => {
    const mode = normalizeMode(button.dataset.modeToggle);
    if (state.mode === mode) return;
    state.mode = mode;
    saveMode(mode);
    state.eligibilityThreshold = null;
    state.eligibilityThresholdKey = "";
    state.riskAllocation = null;
    state.riskAllocationKey = "";
    state.limitOrders = null;
    state.limitOrdersKey = "";
    loadDashboardState();
  });
});

els.liveActivation?.addEventListener("click", () => {
  if (!state.liveExecutionArmed) {
    const confirmed = window.confirm("Activate the live execution gate for this browser? Live one-time execution can submit real Polymarket orders after preflight checks.");
    if (!confirmed) return;
  }
  state.liveExecutionArmed = !state.liveExecutionArmed;
  saveLiveExecutionArmed(state.liveExecutionArmed);
  syncLiveActivationUi();
  if (isLiveMode() && state.liveState) renderLiveState(state.liveState);
});

els.executionButtons.forEach((button) => {
  button.addEventListener("click", () => {
    const target = button.dataset.oneTimeExecution === "current"
      ? (isLiveMode() ? "live" : "paper")
      : (button.dataset.oneTimeExecution === "live" ? "live" : "paper");
    triggerOneTimeExecution(target);
  });
});

els.evaluationStatusButtons.forEach((button) => {
  button.addEventListener("click", () => {
    state.evaluationStatus = button.dataset.evaluationStatus;
    els.evaluationStatusButtons.forEach((item) => {
      item.classList.toggle("active", item === button);
    });
    renderBotEvaluations();
  });
});

els.eligibilityThreshold?.addEventListener("input", () => {
  const raw = Number(els.eligibilityThreshold.value);
  if (!Number.isFinite(raw)) return;
  const normalized = normalizeEligibilityThreshold(raw / 100);
  const value = normalized ?? currentEligibilityThreshold();
  state.eligibilityThreshold = value;
  saveEligibilityThreshold(value);
  syncEligibilityThresholdControl();
  renderBotEvaluations();
});

els.riskAllocation?.addEventListener("input", () => {
  const raw = Number(els.riskAllocation.value);
  if (!Number.isFinite(raw)) return;
  const normalized = normalizeRiskAllocation(raw / 100);
  const value = normalized ?? currentRiskAllocation();
  state.riskAllocation = value;
  saveRiskAllocation(value);
  if (isLiveMode() && state.liveState) {
    renderLiveState(state.liveState);
  } else if (state.botState) {
    renderBotState(state.botState);
  } else {
    syncRiskAllocationControl();
  }
});

els.limitOrders?.addEventListener("change", () => {
  state.limitOrders = Boolean(els.limitOrders.checked);
  saveLimitOrders(state.limitOrders);
  if (isLiveMode() && state.liveState) {
    renderLiveState(state.liveState);
  } else if (state.botState) {
    renderBotState(state.botState);
  } else {
    syncLimitOrdersControl();
  }
});

els.botEvaluations?.addEventListener("click", (event) => {
  const button = event.target.closest("[data-evaluation-sort]");
  if (!button) return;
  const key = button.dataset.evaluationSort;
  if (state.evaluationSort.key === key) {
    state.evaluationSort.direction = state.evaluationSort.direction === "asc" ? "desc" : "asc";
  } else {
    state.evaluationSort.key = key;
    state.evaluationSort.direction = ["marketPrice", "odds", "gainIfWin", "netYield", "aiProbability", "annualizedReturn"].includes(key) ? "desc" : "asc";
  }
  renderBotEvaluations();
});

document.addEventListener("click", (event) => {
  const execution = event.target.closest("[data-execution-modal]");
  if (execution) {
    if (event.target === execution || event.target.closest("[data-execution-modal-close]")) {
      closeExecutionModal();
    }
    return;
  }

  const runEventButton = event.target.closest("[data-run-event]");
  if (runEventButton) {
    event.preventDefault();
    const [runIndexRaw, eventIndexRaw] = String(runEventButton.dataset.runEvent || "").split(":");
    const run = (Array.isArray(state.botState?.evaluationRunLog) ? state.botState.evaluationRunLog : [])[Number(runIndexRaw)];
    const runEvent = Array.isArray(run?.events) ? run.events[Number(eventIndexRaw)] : null;
    openAnalysisModal(runEventDetail(runEvent || {}), runEventButton);
    return;
  }

  const infoButton = event.target.closest(".info-button");
  if (infoButton) {
    event.preventDefault();
    event.stopPropagation();
    const popover = infoButton.closest(".analysis-popover");
    const detail = popover?.querySelector(".analysis-tooltip")?.textContent || "";
    openAnalysisModal(detail, infoButton);
    return;
  }

  const modal = event.target.closest("[data-analysis-modal]");
  if (!modal) return;
  if (event.target === modal || event.target.closest("[data-analysis-modal-close]")) {
    closeAnalysisModal();
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    closeExecutionModal();
    closeAnalysisModal();
  }
});

function handleTradeSort(event) {
  const button = event.target.closest("[data-trade-sort]");
  if (!button) return;
  const tableKey = button.dataset.tradeTable || "open";
  const key = button.dataset.tradeSort;
  state.tradeSort[tableKey] ||= { key, direction: "desc" };
  if (state.tradeSort[tableKey].key === key) {
    state.tradeSort[tableKey].direction = state.tradeSort[tableKey].direction === "asc" ? "desc" : "asc";
  } else {
    state.tradeSort[tableKey].key = key;
    state.tradeSort[tableKey].direction = ["market", "status"].includes(key) ? "asc" : "desc";
  }
  if (isLiveMode()) {
    if (!state.liveState) return;
    renderLiveState(state.liveState);
  } else {
    if (!state.botState) return;
    renderBotState(state.botState);
  }
}

els.botTrades?.addEventListener("click", handleTradeSort);
els.closedTrades?.addEventListener("click", handleTradeSort);

state.mode = storedMode();
state.liveExecutionArmed = storedLiveExecutionArmed();
updateSchedulePanel();
window.setInterval(updateSchedulePanel, 60000);
loadDashboardState().then(() => {
  if (isLiveMode()) requestLiveAccountSync({ quiet: true });
});

window.setInterval(() => {
  if (!isLiveMode()) return;
  loadDashboardState({ skipAutoLiveSync: true });
  requestLiveAccountSync({ quiet: true, minSeconds: LIVE_SYNC_REQUEST_MS / 1000 });
}, LIVE_STATE_REFRESH_MS);
