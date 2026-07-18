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
  eligibilityThreshold: document.querySelector("[data-eligibility-threshold]"),
  eligibilityThresholdLabel: document.querySelector("[data-eligibility-threshold-label]"),
  riskAllocation: document.querySelector("[data-risk-allocation]"),
  riskAllocationLabel: document.querySelector("[data-risk-allocation-label]"),
  riskAllocationValue: document.querySelector("[data-risk-allocation-value]"),
  riskAllocationNote: document.querySelector("[data-risk-allocation-note]"),
  limitOrders: document.querySelector("[data-limit-orders]"),
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
  portfolioOpenPl: document.querySelector("[data-portfolio-open-pl]"),
  portfolioOpenPlPct: document.querySelector("[data-portfolio-open-pl-pct]"),
  portfolioRisk: document.querySelector("[data-portfolio-risk]"),
  portfolioFree: document.querySelector("[data-portfolio-free]"),
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
    return localStorage.getItem(MODE_STORAGE_KEY) === "live" ? "live" : "paper";
  } catch {
    return "paper";
  }
}

function saveMode(mode) {
  try {
    localStorage.setItem(MODE_STORAGE_KEY, mode);
  } catch {
    // Ignore localStorage failures; the mode switch still works for this page load.
  }
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

function syncLiveActivationUi() {
  if (!els.liveActivation) return;
  const live = state.mode === "live";
  els.liveActivation.hidden = !live;
  els.liveActivation.classList.toggle("armed", state.liveExecutionArmed);
  els.liveActivation.setAttribute("aria-pressed", state.liveExecutionArmed ? "true" : "false");
  els.liveActivation.textContent = state.liveExecutionArmed ? "Live execution armed" : "Activate live execution";
}

function syncModeUi() {
  const live = state.mode === "live";
  els.modeButtons.forEach((button) => {
    button.classList.toggle("active", button.dataset.modeToggle === state.mode);
  });
  els.tabButtons.forEach((button) => {
    button.textContent = live ? button.dataset.liveLabel : button.dataset.paperLabel;
  });
  if (els.portfolioTitle) els.portfolioTitle.textContent = live ? "Live Polymarket account" : "Autonomous paper portfolio";
  if (els.primaryPanelTitle) els.primaryPanelTitle.textContent = live ? "Opened live trades" : "Opened paper trades";
  if (els.secondaryPanelTitle) els.secondaryPanelTitle.textContent = live ? "Closed live trades" : "Closed paper trades";
  if (els.evaluationControls) els.evaluationControls.style.display = "";
  if (els.accountSummary) els.accountSummary.hidden = !live;
  if (els.botStatus) els.botStatus.hidden = live;
  syncLiveActivationUi();
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
  return ["WON", "LOST", "CLOSED", "REDEEMED", "SOLD"].includes(String(trade.status || "").toUpperCase());
}

function tradeStatusNote(trade) {
  const parts = [
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
  const currentReturn = tradePnlPct(trade);
  const label = isClosedTrade(trade) ? "realized P/L" : "current P/L";
  return `
    ${compactDays(heldDays)}
    <span class="${pnlClass(currentReturn)}">${signedPercent(currentReturn)} ${label}</span>
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
          ${tradeHeader(tableKey, "potentialAnnualized", "Win p.a.")}
          ${showStatus ? tradeHeader(tableKey, "status", "Result") : ""}
          ${tradeHeader(tableKey, "pnl", "P/L")}
          ${tradeHeader(tableKey, "stake", "Stake")}
        </tr>
      </thead>
      <tbody>
        ${rows.map((trade) => `
          <tr>
            <td>${escapeHtml(formatDate(showStatus ? (trade.resolvedAt || trade.closedTime || trade.lastCheckedAt || "") : (trade.date || trade.openedAt || "")))}</td>
            <td>
              ${marketAnchor(trade)}
              <span>${escapeHtml(riskLine(trade))}</span>
              <span>${escapeHtml(postMortemLine(trade))}</span>
            </td>
            <td>
              ${probability(Number(trade.entryPrice))}
              <span>${[trade.slippage == null ? "" : `slip ${(Number(trade.slippage) * 100).toFixed(1)} pts`, feeLine(trade)].filter(Boolean).join(", ")}</span>
            </td>
            <td>${probability(Number(trade.currentPrice))}</td>
            <td>
              <strong>${probability(tradeAiProbability(trade))}</strong>
              <span class="analysis-popover">
                <button class="info-button" type="button" aria-label="Show original AI analysis">i</button>
                <span class="analysis-tooltip" role="tooltip">${escapeHtml(tradeAnalysisDetails(trade))}</span>
              </span>
            </td>
            <td>${resolutionCell(trade)}</td>
            <td>${holdingCell(trade)}</td>
            <td>${potentialGainCell(trade)}</td>
            <td>${potentialPctCell(trade)}</td>
            <td>${potentialAnnualizedCell(trade)}</td>
            ${showStatus ? `<td>
              ${escapeHtml(trade.status || "OPEN")}
              <span>${escapeHtml(tradeStatusNote(trade))}</span>
            </td>` : ""}
            <td class="${pnlClass(tradePnlValue(trade))}">
              ${signedMoney(tradePnlValue(trade))}
              <span>${signedPercent(tradePnlPct(trade))}</span>
            </td>
            <td>${money(Number(trade.stakeUsdc || 0))}</td>
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
    `Bot status: ${item.status || "-"}`,
    `Adjusted status: ${adjustedEvaluationStatus(item)}`,
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
  const status = adjustedEvaluationStatus(item);
  if (item.selectionStatus === "RISK_BLOCKED") return `${status} / RISK BLOCKED`;
  if (status !== String(item.status || "").toUpperCase()) return `${status} / THRESHOLD`;
  return status;
}

function eligibilityThresholdStorageKey() {
  const parts = [ELIGIBILITY_THRESHOLD_STORAGE_KEY, state.mode];
  if (state.mode === "live") {
    const address = state.liveState?.account?.address || state.liveState?.account?.proxyWallet || "";
    if (address) parts.push(String(address).toLowerCase());
  }
  return parts.join(":");
}

function accountScopedStorageKey(baseKey) {
  const parts = [baseKey, state.mode];
  if (state.mode === "live") {
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

function syncRiskAllocationControl(availableCapital = null, sourceLabel = "available capital") {
  const value = currentRiskAllocation();
  if (els.riskAllocation) {
    els.riskAllocation.value = String(Math.round(value * 100));
  }
  if (els.riskAllocationLabel) {
    els.riskAllocationLabel.textContent = probability(value);
  }
  if (els.riskAllocationValue) {
    const base = Number(availableCapital);
    els.riskAllocationValue.textContent = Number.isFinite(base) ? money(base * value) : "-";
  }
  if (els.riskAllocationNote) {
    els.riskAllocationNote.textContent = `maximum stake from ${sourceLabel}`;
  }
}

function defaultLimitOrdersForMode() {
  return state.mode === "live";
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
  return (Array.isArray(item.rejectReasons) ? item.rejectReasons : []).filter((reason) => !isProbabilityRejectReason(reason));
}

function adjustedEvaluationStatus(item) {
  const original = String(item.status || "-").toUpperCase();
  if (original === "ERROR") return "ERROR";
  const aiProbability = Number(item.aiProbability);
  if (!Number.isFinite(aiProbability)) return original;
  const threshold = currentEligibilityThreshold();
  if (aiProbability < threshold) return "REJECTED";
  if (original === "ELIGIBLE") return "ELIGIBLE";
  if (original === "REJECTED" && nonProbabilityRejectReasons(item).length === 0) return "ELIGIBLE";
  return original;
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
    reasons.push("passes selected probability threshold; originally rejected by bot threshold");
  }
  return reasons.filter(Boolean);
}

async function loadBotState() {
  try {
    const botState = await fetchJson("data/paper-state.json");
    renderBotState(botState);
  } catch (error) {
    state.botState = null;
    els.botAction.textContent = "offline";
    if (els.botInlineAction) els.botInlineAction.textContent = "offline";
    els.botStatus.innerHTML = `<div class="error">${escapeHtml(error.message)}</div>`;
    els.botTrades.innerHTML = '<div class="empty">Autonomous paper bot state is not available yet.</div>';
    if (els.closedTrades) els.closedTrades.innerHTML = '<div class="empty">Closed paper trades are not available yet.</div>';
    if (els.closedSummary) els.closedSummary.textContent = "offline";
    els.botEvaluations.innerHTML = '<div class="empty">No common evaluation log loaded.</div>';
  }
}

async function fetchJson(path) {
  const statePayload = await fetch(`${path}?t=${Date.now()}`, { cache: "no-store" });
  if (!statePayload.ok) throw new Error(`${path} HTTP ${statePayload.status}`);
  return statePayload.json();
}

async function loadLiveState() {
  try {
    const [liveResult, botResult] = await Promise.allSettled([
      fetchJson("data/live-state.json"),
      fetchJson("data/paper-state.json"),
    ]);
    if (liveResult.status === "rejected") throw liveResult.reason;
    state.botState = botResult.status === "fulfilled" ? botResult.value : null;
    const liveState = liveResult.value;
    renderLiveState(liveState);
    if (botResult.status === "rejected") {
      els.botEvaluations.innerHTML = `<div class="empty">Common evaluation log is not available: ${escapeHtml(botResult.reason?.message || String(botResult.reason))}</div>`;
    }
  } catch (error) {
    state.liveState = null;
    syncModeUi();
    els.botAction.textContent = "offline";
    if (els.botInlineAction) els.botInlineAction.textContent = "offline";
    els.portfolioEquity.textContent = "-";
    els.portfolioLastRun.textContent = "Live sync not available";
    els.portfolioTotalPl.textContent = "-";
    els.portfolioTotalPlPct.textContent = "-";
    els.portfolioAnnualized.textContent = "-";
    els.portfolioPeriod.textContent = "No live data";
    els.portfolioRealized.textContent = "-";
    els.portfolioRealizedPct.textContent = "-";
    els.portfolioOpenPl.textContent = "-";
    els.portfolioOpenPlPct.textContent = "-";
    els.portfolioRisk.textContent = "-";
    els.portfolioFree.textContent = "-";
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

function loadDashboardState() {
  syncModeUi();
  return state.mode === "live" ? loadLiveState() : loadBotState();
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
  const decision = botState.lastDecision || {};
  const portfolio = botState.portfolio || {};
  const learning = botState.learningProfile || {};
  const trades = Array.isArray(botState.trades) ? botState.trades : [];
  const closedTrades = trades.filter(isClosedTrade);
  const openTrades = trades.filter((trade) => !isClosedTrade(trade));
  const periodDays = portfolioPeriodDays(botState, trades);
  const annualized = annualizedPortfolioReturn(portfolio, periodDays);
  const totalPnl = Number(portfolio.totalPnlUsdc || 0);
  const totalPnlPct = Number(portfolio.totalPnlPct || 0);
  const realizedPnl = Number(portfolio.realizedPnlUsdc || 0);
  const realizedPnlPct = Number(portfolio.realizedPnlPct || 0);
  const openPnl = Number(portfolio.openPnlUsdc || 0);
  const openPnlPct = Number(portfolio.openPnlPct || 0);
  const freeCapital = Number(portfolio.freeCapitalUsdc ?? portfolio.initialUsdc ?? 100);
  syncRiskAllocationControl(freeCapital, "paper free capital");

  els.botAction.textContent = decision.action || "waiting";
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
  els.portfolioOpenPl.textContent = signedMoney(openPnl);
  els.portfolioOpenPl.className = pnlClass(openPnl);
  els.portfolioOpenPlPct.textContent = signedPercent(openPnlPct);
  els.portfolioRisk.textContent = money(Number(portfolio.openRiskUsdc || 0));
  els.portfolioFree.textContent = `${money(freeCapital)} free`;

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
        <span class="label">Filters</span>
        <strong>${percent(Number(portfolio.minProbability ?? 0.95))} or edge ${percent(Number(portfolio.opportunityMinProbability ?? 0.6))}</strong>
        <span>${percent(Number(portfolio.minAnnualReturn ?? 0.05))} p.a. / edge ${percent(Number(portfolio.opportunityMinEdge ?? 0.04))}</span>
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
}

function livePositions(liveState) {
  return Array.isArray(liveState?.positions) ? liveState.positions : [];
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

function normalizeLiveOpenOrderForTable(order) {
  const source = evaluationByTokenId(order.tokenId || order.assetId);
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
    date: order.createdAt || new Date().toISOString(),
    openedAt: order.createdAt || new Date().toISOString(),
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
  const positions = livePositions(liveState);
  const openOrders = liveOpenOrders(liveState);
  const openedRows = [
    ...positions,
    ...openOrders.map(normalizeLiveOpenOrderForTable),
  ];
  const activity = liveActivity(liveState);
  const closedTrades = liveClosedTrades(liveState);
  const sync = liveState.sync || {};
  const sources = Array.isArray(sync.sources) ? sync.sources : [];
  const totalPnl = Number(portfolio.totalPnlUsdc);
  const totalPnlPct = Number(portfolio.totalPnlPct);
  const realizedPnl = Number(portfolio.realizedPnlUsdc);
  const realizedPnlPct = Number(portfolio.realizedPnlPct);
  const openPnl = Number(portfolio.openPnlUsdc);
  const openPnlPct = Number(portfolio.openPnlPct);
  const marketValue = Number(portfolio.marketValueUsdc);
  const cash = Number(portfolio.cashUsdc);
  const equity = Number.isFinite(Number(portfolio.equityUsdc))
    ? Number(portfolio.equityUsdc)
    : (Number.isFinite(marketValue) ? marketValue : 0);
  const liveCapitalBase = Number.isFinite(cash) ? cash : null;
  const liveGuardLabel = state.liveExecutionArmed ? "Armed" : "Inactive";
  const liveGuardText = state.liveExecutionArmed
    ? "UI gate enabled; no automatic live order submitter is connected yet"
    : "click Activate live execution before future live order routing";
  syncRiskAllocationControl(liveCapitalBase, Number.isFinite(cash) ? "live pUSD cash" : "live cash once balance sync is available");

  els.botAction.textContent = "live";
  if (els.botInlineAction) els.botInlineAction.textContent = `${positions.length} positions / ${openOrders.length} orders`;
  els.portfolioEquity.textContent = money(equity);
  els.portfolioEquity.className = pnlClass(totalPnl);
  els.portfolioLastRun.textContent = `${liveAccountName(account)} / sync ${liveState.generatedAt ? formatDate(liveState.generatedAt) : "-"}`;
  els.portfolioTotalPl.textContent = signedMoney(totalPnl);
  els.portfolioTotalPl.className = pnlClass(totalPnl);
  els.portfolioTotalPlPct.textContent = signedPercent(totalPnlPct);
  els.portfolioAnnualized.textContent = "-";
  els.portfolioAnnualized.className = "";
  els.portfolioPeriod.textContent = "based on live account snapshot";
  els.portfolioRealized.textContent = signedMoney(realizedPnl);
  els.portfolioRealized.className = pnlClass(realizedPnl);
  els.portfolioRealizedPct.textContent = signedPercent(realizedPnlPct);
  els.portfolioOpenPl.textContent = signedMoney(openPnl);
  els.portfolioOpenPl.className = pnlClass(openPnl);
  els.portfolioOpenPlPct.textContent = signedPercent(openPnlPct);
  els.portfolioRisk.textContent = money(Number(portfolio.openRiskUsdc || marketValue || 0));
  els.portfolioFree.textContent = Number.isFinite(cash) ? `${money(cash)} cash` : "cash not available";

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
        <span>${money(marketValue)} market value / ${openOrders.length} open orders</span>
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
        <span class="label">Live execution</span>
        <strong>${escapeHtml(liveGuardLabel)}</strong>
        <span>${escapeHtml(`${liveGuardText}; ${currentLimitOrders() ? "limit orders preferred" : "market orders preferred"}`)}</span>
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
}

function evaluationSortValue(item, key) {
  if (key === "evaluatedAt") return Date.parse(item.evaluatedAt || "") || 0;
  if (key === "status") return adjustedEvaluationStatus(item);
  if (key === "market") return `${item.outcome || ""} ${item.question || ""}`.toLowerCase();
  if (key === "endDate") return Date.parse(evaluationEndDate(item) || "") || 0;
  if (key === "daysLeft") return evaluationDaysLeft(item);
  if (key === "marketPrice") return Number(item.marketPrice);
  if (key === "odds") return decimalOdds(item.marketPrice);
  if (key === "gainIfWin") return gainIfWin(item);
  if (key === "netYield") return netYield(item);
  if (key === "aiProbability") return Number(item.aiProbability);
  if (key === "annualizedReturn") return annualizedExpectedReturn(item);
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
  return evaluations.filter((item) => adjustedEvaluationStatus(item) === state.evaluationStatus);
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

function renderBotEvaluations() {
  const evaluations = Array.isArray(state.botState?.evaluations) ? state.botState.evaluations : [];
  const eligibleCount = evaluations.filter((item) => adjustedEvaluationStatus(item) === "ELIGIBLE").length;
  const botEligibleCount = evaluations.filter((item) => String(item.status || "").toUpperCase() === "ELIGIBLE").length;
  const riskBlockedCount = evaluations.filter((item) => adjustedEvaluationStatus(item) === "ELIGIBLE" && item.selectionStatus === "RISK_BLOCKED").length;
  const tradableCount = Math.max(0, eligibleCount - riskBlockedCount);

  if (els.evaluationSummary) {
    els.evaluationSummary.textContent = `${tradableCount} tradable / ${eligibleCount} eligible / ${botEligibleCount} bot / ${evaluations.length} total`;
  }

  if (!evaluations.length) {
    els.botEvaluations.innerHTML = '<div class="empty">Zatim zadna vyhodnoceni.</div>';
    return;
  }

  const visibleEvaluations = sortedEvaluations(filteredEvaluations(evaluations)).slice(0, 80);

  if (!visibleEvaluations.length) {
    els.botEvaluations.innerHTML = `<div class="empty">No ${state.evaluationStatus.toLowerCase()} evaluations in the latest log.</div>`;
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
          ${sortableHeader("aiProbability", "AI prob.")}
          ${sortableHeader("annualizedReturn", "EV p.a.")}
          ${sortableHeader("analysis", "Analysis")}
        </tr>
      </thead>
      <tbody>
        ${visibleEvaluations.map((item) => `
          <tr>
            <td>${escapeHtml(formatDate(item.evaluatedAt || ""))}</td>
            <td class="${adjustedEvaluationStatus(item) === "ELIGIBLE" && item.selectionStatus !== "RISK_BLOCKED" ? "positive" : "negative"}">${escapeHtml(evaluationStatusLabel(item))}</td>
            <td>
              ${marketAnchor(item)}
              <span>${escapeHtml(riskLine(item))}</span>
            </td>
            <td>${evaluationEndDateCell(item)}</td>
            <td>${evaluationDaysLeftCell(item)}</td>
            <td>
              ${probability(Number(item.marketPrice))}
              <span>${[
                item.bestAsk == null ? "" : `ask ${probability(Number(item.bestAsk))}`,
                item.slippage == null ? "" : `slip ${(Number(item.slippage) * 100).toFixed(1)} pts`,
                feeLine(item),
              ].filter(Boolean).join(", ")}</span>
            </td>
            <td>${odds(decimalOdds(item.marketPrice))}</td>
            <td>${gainCell(item)}</td>
            <td>${netYieldCell(item)}</td>
            <td>${probability(Number(item.aiProbability))}</td>
            <td>${annualizedCell(item)}</td>
            <td>
              ${analysisBadge(item)}
            </td>
          </tr>
        `).join("")}
      </tbody>
    </table>
  `;
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
    const mode = button.dataset.modeToggle === "live" ? "live" : "paper";
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
    const confirmed = window.confirm("Activate the live execution gate for this browser? This only arms the UI; this version still does not submit live orders automatically.");
    if (!confirmed) return;
  }
  state.liveExecutionArmed = !state.liveExecutionArmed;
  saveLiveExecutionArmed(state.liveExecutionArmed);
  syncLiveActivationUi();
  if (state.mode === "live" && state.liveState) renderLiveState(state.liveState);
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
  if (state.mode === "live" && state.liveState) {
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
  if (state.mode === "live" && state.liveState) {
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
  if (event.key === "Escape") closeAnalysisModal();
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
  if (state.mode === "live") {
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
loadDashboardState();
