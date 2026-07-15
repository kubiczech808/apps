const state = {
  botState: null,
  evaluationSort: {
    key: "evaluatedAt",
    direction: "desc",
  },
  evaluationStatus: "ELIGIBLE",
};

const els = {
  botAction: document.querySelector("[data-bot-action]"),
  botInlineAction: document.querySelector("[data-bot-inline-action]"),
  botStatus: document.querySelector("[data-bot-status]"),
  botTrades: document.querySelector("[data-bot-trades]"),
  closedTrades: document.querySelector("[data-closed-trades]"),
  closedSummary: document.querySelector("[data-closed-summary]"),
  botEvaluations: document.querySelector("[data-bot-evaluations]"),
  evaluationSummary: document.querySelector("[data-evaluation-summary]"),
  evaluationStatusButtons: document.querySelectorAll("[data-evaluation-status]"),
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
  return `${(value * 100).toFixed(1)}%`;
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

function pnlClass(value) {
  return Number(value) >= 0 ? "positive" : "negative";
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

function sortArrow(key) {
  if (state.evaluationSort.key !== key) return "";
  return state.evaluationSort.direction === "asc" ? " asc" : " desc";
}

function gainIfWin(item) {
  const netGain = Number(item.netGainIfWinUsdc);
  if (Number.isFinite(netGain)) return netGain;
  const stake = Number(item.stakeUsdc || 5);
  const fee = Number(item.takerFeeUsdc || 0);
  const shares = Number(item.executableShares || item.shares);
  const price = Number(item.marketPrice || item.entryPrice);
  if (Number.isFinite(shares) && Number.isFinite(stake)) return shares - stake - (Number.isFinite(fee) ? fee : 0);
  const decimal = decimalOdds(price);
  if (decimal == null || !Number.isFinite(stake)) return null;
  return stake * (decimal - 1) - (Number.isFinite(fee) ? fee : 0);
}

function feeLine(item) {
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
  if (["WON", "LOST"].includes(trade.status)) return Number(trade.realizedPnlUsdc);
  return Number(trade.unrealizedPnlUsdc);
}

function tradePnlPct(trade) {
  if (["WON", "LOST"].includes(trade.status)) return Number(trade.realizedPnlPct);
  return Number(trade.unrealizedPnlPct);
}

function isClosedTrade(trade) {
  return ["WON", "LOST"].includes(String(trade.status || "").toUpperCase());
}

function tradeStatusNote(trade) {
  const parts = [
    trade.currentPrice == null ? "" : `mark ${probability(Number(trade.currentPrice))}`,
    trade.finalOutcomePrice == null ? "" : `final ${probability(Number(trade.finalOutcomePrice))}`,
    trade.marketUrlStatus === "use_event_slug" ? "event link" : "",
  ];
  return parts.filter(Boolean).join(", ");
}

function tradeEndDate(trade) {
  return trade.endDate || trade.closedTime || trade.resolvedAt || null;
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

function resolutionCell(trade) {
  const endDate = tradeEndDate(trade);
  const remaining = isClosedTrade(trade) ? null : daysUntil(endDate);
  const storedDays = Number(trade.daysToResolution);
  const days = Number.isFinite(remaining) ? remaining : storedDays;
  return `
    ${escapeHtml(endDate ? formatDate(endDate) : "-")}
    <span>${isClosedTrade(trade) ? "resolved" : `${compactDays(days)} left`}</span>
  `;
}

function holdingCell(trade) {
  const heldDays = tradeHoldingDays(trade);
  const currentReturn = tradePnlPct(trade);
  const annualized = annualizedForPeriod(currentReturn, heldDays);
  return `
    ${compactDays(heldDays)}
    <span class="${pnlClass(annualized)}">${signedPercent(annualized)} p.a. current</span>
  `;
}

function potentialCell(trade) {
  const gain = tradePotentialGain(trade);
  const basis = tradeCostBasis(trade);
  const gainPct = basis > 0 && Number.isFinite(gain) ? gain / basis : null;
  const endDate = tradeEndDate(trade);
  const totalPlannedDays = daysBetween(trade.openedAt || trade.date, endDate);
  const annualized = annualizedForPeriod(gainPct, totalPlannedDays);
  return `
    <span class="${pnlClass(gain)}">${signedMoney(gain)}</span>
    <span class="${pnlClass(gainPct)}">${signedPercent(gainPct)} if win${Number.isFinite(annualized) ? ` / ${signedPercent(annualized)} p.a.` : ""}</span>
  `;
}

function postMortemLine(trade) {
  const review = trade.postMortem;
  if (!review) return "";
  const error = Number(review.predictionError);
  const errorText = Number.isFinite(error) ? `error ${signedPercent(error)}` : "";
  return [review.conclusion, errorText].filter(Boolean).join(" ");
}

function renderTradeRows(trades, emptyText) {
  if (!trades.length) return `<div class="empty">${escapeHtml(emptyText)}</div>`;
  return `
    <table>
      <thead>
        <tr>
          <th>Opened</th>
          <th>Market</th>
          <th>Entry</th>
          <th>Resolution</th>
          <th>Holding</th>
          <th>Potential</th>
          <th>Status</th>
          <th>P/L</th>
          <th>Stake</th>
        </tr>
      </thead>
      <tbody>
        ${trades.map((trade) => `
          <tr>
            <td>${escapeHtml(formatDate(trade.date || trade.openedAt || ""))}</td>
            <td>
              ${marketAnchor(trade)}
              <span>${escapeHtml(riskLine(trade))}</span>
              <span>${escapeHtml(postMortemLine(trade))}</span>
            </td>
            <td>
              ${probability(Number(trade.entryPrice))}
              <span>${[trade.slippage == null ? "" : `slip ${(Number(trade.slippage) * 100).toFixed(1)} pts`, feeLine(trade)].filter(Boolean).join(", ")}</span>
            </td>
            <td>${resolutionCell(trade)}</td>
            <td>${holdingCell(trade)}</td>
            <td>${potentialCell(trade)}</td>
            <td>
              ${escapeHtml(trade.status || "OPEN")}
              <span>${escapeHtml(tradeStatusNote(trade))}</span>
            </td>
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
  const reasons = [riskReason, ...(item.rejectReasons || [])].filter(Boolean).join("; ") || "passes filters";
  const ai = item.aiAnalysis || {};
  const details = [
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
      <button class="info-button" type="button" aria-label="Show analysis details" title="${escapeHtml(details)}">i</button>
      <span class="analysis-tooltip" role="tooltip">${escapeHtml(details)}</span>
    </span>
    <span class="analysis-reason">${escapeHtml(reasons)}</span>
  `;
}

function evaluationStatusLabel(item) {
  const status = String(item.status || "-");
  if (item.selectionStatus === "RISK_BLOCKED") return `${status} / RISK BLOCKED`;
  return status;
}

async function loadBotState() {
  try {
    const statePayload = await fetch(`data/paper-state.json?t=${Date.now()}`, { cache: "no-store" });
    if (!statePayload.ok) throw new Error(`paper-state.json HTTP ${statePayload.status}`);
    renderBotState(await statePayload.json());
  } catch (error) {
    els.botAction.textContent = "offline";
    if (els.botInlineAction) els.botInlineAction.textContent = "offline";
    els.botStatus.innerHTML = `<div class="error">${escapeHtml(error.message)}</div>`;
    els.botTrades.innerHTML = '<div class="empty">Autonomous paper bot state is not available yet.</div>';
    if (els.closedTrades) els.closedTrades.innerHTML = '<div class="empty">Closed paper trades are not available yet.</div>';
    if (els.closedSummary) els.closedSummary.textContent = "offline";
    els.botEvaluations.innerHTML = '<div class="empty">No evaluations loaded.</div>';
  }
}

function renderBotState(botState) {
  state.botState = botState;
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
  els.portfolioFree.textContent = `${money(Number(portfolio.freeCapitalUsdc ?? portfolio.initialUsdc ?? 100))} free`;

  els.botStatus.innerHTML = `
    <div class="bot-summary">
      <div>
        <span class="label">Last run</span>
        <strong>${escapeHtml(botState.generatedAt ? formatDate(botState.generatedAt) : "not yet")}</strong>
      </div>
      <div>
        <span class="label">Free capital</span>
        <strong>${money(Number(portfolio.freeCapitalUsdc ?? portfolio.initialUsdc ?? 100))}</strong>
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

  els.botTrades.innerHTML = renderTradeRows(openTrades.slice(0, 12), "Zatim zadne otevrene autonomni paper obchody.");
  if (els.closedSummary) {
    const closedPnl = closedTrades.reduce((sum, trade) => sum + Number(trade.realizedPnlUsdc || 0), 0);
    els.closedSummary.textContent = `${closedTrades.length} closed / ${signedMoney(closedPnl)}`;
  }
  if (els.closedTrades) {
    els.closedTrades.innerHTML = renderTradeRows(closedTrades, "Zatim zadne ukoncene paper obchody.");
  }

  renderBotEvaluations();
}

function evaluationSortValue(item, key) {
  if (key === "evaluatedAt") return Date.parse(item.evaluatedAt || "") || 0;
  if (key === "status") return String(item.status || "");
  if (key === "market") return `${item.outcome || ""} ${item.question || ""}`.toLowerCase();
  if (key === "marketPrice") return Number(item.marketPrice);
  if (key === "odds") return decimalOdds(item.marketPrice);
  if (key === "gainIfWin") return gainIfWin(item);
  if (key === "aiProbability") return Number(item.aiProbability);
  if (key === "annualizedReturn") return Number(item.annualizedReturn);
  if (key === "analysis") return `${(item.rejectReasons || []).join("; ")} ${item.analysisSummary || ""}`.toLowerCase();
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
  return evaluations.filter((item) => String(item.status || "").toUpperCase() === state.evaluationStatus);
}

function sortableHeader(key, label) {
  const active = state.evaluationSort.key === key ? " active" : "";
  return `<th><button class="sort-button${active}" type="button" data-evaluation-sort="${key}">${label}${sortArrow(key)}</button></th>`;
}

function renderBotEvaluations() {
  const evaluations = Array.isArray(state.botState?.evaluations) ? state.botState.evaluations : [];
  const eligibleCount = evaluations.filter((item) => item.status === "ELIGIBLE").length;
  const riskBlockedCount = evaluations.filter((item) => item.selectionStatus === "RISK_BLOCKED").length;
  const tradableCount = Math.max(0, eligibleCount - riskBlockedCount);

  if (els.evaluationSummary) {
    els.evaluationSummary.textContent = `${tradableCount} tradable / ${eligibleCount} eligible / ${evaluations.length} total`;
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
          ${sortableHeader("marketPrice", "Mkt entry")}
          ${sortableHeader("odds", "Odds")}
          ${sortableHeader("gainIfWin", "Gain @ $5")}
          ${sortableHeader("aiProbability", "AI prob.")}
          ${sortableHeader("annualizedReturn", "EV p.a.")}
          ${sortableHeader("analysis", "Analysis")}
        </tr>
      </thead>
      <tbody>
        ${visibleEvaluations.map((item) => `
          <tr>
            <td>${escapeHtml(formatDate(item.evaluatedAt || ""))}</td>
            <td class="${item.status === "ELIGIBLE" && item.selectionStatus !== "RISK_BLOCKED" ? "positive" : "negative"}">${escapeHtml(evaluationStatusLabel(item))}</td>
            <td>
              ${marketAnchor(item)}
              <span>${escapeHtml(riskLine(item))}</span>
            </td>
            <td>
              ${probability(Number(item.marketPrice))}
              <span>${[
                item.bestAsk == null ? "" : `ask ${probability(Number(item.bestAsk))}`,
                item.slippage == null ? "" : `slip ${(Number(item.slippage) * 100).toFixed(1)} pts`,
                feeLine(item),
              ].filter(Boolean).join(", ")}</span>
            </td>
            <td>${odds(decimalOdds(item.marketPrice))}</td>
            <td class="${Number(gainIfWin(item)) >= 0 ? "positive" : "negative"}">
              ${money(gainIfWin(item))}
              <span>net after fee</span>
            </td>
            <td>${probability(Number(item.aiProbability))}</td>
            <td class="${Number(item.annualizedReturn) >= 0 ? "positive" : "negative"}">${percent(Number(item.annualizedReturn))}</td>
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

els.evaluationStatusButtons.forEach((button) => {
  button.addEventListener("click", () => {
    state.evaluationStatus = button.dataset.evaluationStatus;
    els.evaluationStatusButtons.forEach((item) => {
      item.classList.toggle("active", item === button);
    });
    renderBotEvaluations();
  });
});

els.botEvaluations?.addEventListener("click", (event) => {
  const button = event.target.closest("[data-evaluation-sort]");
  if (!button) return;
  const key = button.dataset.evaluationSort;
  if (state.evaluationSort.key === key) {
    state.evaluationSort.direction = state.evaluationSort.direction === "asc" ? "desc" : "asc";
  } else {
    state.evaluationSort.key = key;
    state.evaluationSort.direction = ["marketPrice", "odds", "gainIfWin", "aiProbability", "annualizedReturn"].includes(key) ? "desc" : "asc";
  }
  renderBotEvaluations();
});

loadBotState();
