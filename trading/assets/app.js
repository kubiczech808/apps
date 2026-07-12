const STORAGE_KEY = "polymarket-paper-ledger-v1";

const state = {
  candidates: [],
  selected: null,
  ledger: readLedger(),
};

const els = {
  candidates: document.querySelector("[data-candidates]"),
  candidateCount: document.querySelector("[data-candidate-count]"),
  refresh: document.querySelector("[data-refresh]"),
  search: document.querySelector("[data-search]"),
  searchInput: document.querySelector("#marketSearch"),
  minVolume: document.querySelector("[data-min-volume]"),
  maxSpread: document.querySelector("[data-max-spread]"),
  title: document.querySelector("[data-selected-title]"),
  selectedScore: document.querySelector("[data-selected-score]"),
  outcomeLabel: document.querySelector("[data-outcome-label]"),
  bestAsk: document.querySelector("[data-best-ask]"),
  spread: document.querySelector("[data-spread]"),
  liquidity: document.querySelector("[data-liquidity]"),
  aiProbability: document.querySelector("[data-ai-probability]"),
  bankroll: document.querySelector("[data-bankroll]"),
  allocation: document.querySelector("[data-allocation]"),
  priceCap: document.querySelector("[data-price-cap]"),
  stake: document.querySelector("[data-stake]"),
  ev: document.querySelector("[data-ev]"),
  drawdown: document.querySelector("[data-drawdown]"),
  decision: document.querySelector("[data-decision]"),
  memo: document.querySelector("[data-memo]"),
  buildMemo: document.querySelector("[data-build-memo]"),
  paperEnter: document.querySelector("[data-paper-enter]"),
  ledger: document.querySelector("[data-ledger]"),
  clearLedger: document.querySelector("[data-clear-ledger]"),
  payload: document.querySelector("[data-payload]"),
  copy: document.querySelector("[data-copy]"),
  sidebarEquity: document.querySelector("[data-sidebar-equity]"),
  sidebarRisk: document.querySelector("[data-sidebar-risk]"),
  sidebarPl: document.querySelector("[data-sidebar-pl]"),
};

function readLedger() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveLedger() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state.ledger));
}

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

function parseInput(input, fallback = 0) {
  const value = Number(input?.value);
  return Number.isFinite(value) ? value : fallback;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

async function getJson(url) {
  const response = await fetch(url, { cache: "no-store" });
  const payload = await response.json();
  if (!response.ok || !payload.ok) {
    throw new Error(payload.error || `Request failed: ${response.status}`);
  }
  return payload;
}

function marketTags(question) {
  const text = question.toLowerCase();
  const tags = [];
  if (/\b(bitcoin|btc|ethereum|eth|crypto|solana|xrp)\b/.test(text)) tags.push("crypto");
  if (/\b(election|president|senate|trump|biden|congress|minister|vote)\b/.test(text)) tags.push("politics");
  if (/\b(fed|rate|inflation|cpi|jobs|unemployment|gdp)\b/.test(text)) tags.push("macro");
  if (/\b(nba|nfl|mlb|nhl|ufc|world cup|champions|match|game)\b/.test(text)) tags.push("sports");
  if (/\b(will|before|by|in 2026|in 2027|on)\b/.test(text)) tags.push("clear-resolution");
  return tags.length ? tags : ["general"];
}

function daysToEnd(endDate) {
  if (!endDate) return null;
  const end = new Date(endDate).getTime();
  if (!Number.isFinite(end)) return null;
  return Math.max(0, (end - Date.now()) / 86400000);
}

function scoreCandidate(market, outcomeIndex, book) {
  const ask = Number(book.bestAsk);
  const bid = Number(book.bestBid);
  const spread = Number(book.spread);
  const volume24hr = Number(market.volume24hr || 0);
  const liquidity = Number(market.liquidity || 0);
  const dte = daysToEnd(market.endDate);
  const tags = marketTags(market.question);

  const volumeScore = clamp(Math.log10(volume24hr + 1) / 5, 0, 1) * 24;
  const liquidityScore = clamp(Math.log10(liquidity + 1) / 5, 0, 1) * 22;
  const spreadScore = Number.isFinite(spread) ? clamp(1 - spread / 0.12, 0, 1) * 24 : 0;
  const priceScore = Number.isFinite(ask) ? clamp(1 - Math.abs(ask - 0.5) / 0.5, 0, 1) * 12 : 0;
  const timeScore = dte == null ? 6 : dte <= 2 ? 2 : dte <= 120 ? 12 : 7;
  const clarityScore = tags.includes("clear-resolution") ? 6 : 3;
  const score = Math.round(volumeScore + liquidityScore + spreadScore + priceScore + timeScore + clarityScore);

  return {
    id: `${market.id}-${outcomeIndex}`,
    market,
    outcomeIndex,
    outcome: market.outcomes?.[outcomeIndex] || `Outcome ${outcomeIndex + 1}`,
    tokenId: market.clobTokenIds?.[outcomeIndex] || "",
    ask,
    bid,
    spread,
    volume24hr,
    liquidity,
    daysToEnd: dte,
    tags,
    score,
  };
}

function calcTrade(candidate = state.selected) {
  if (!candidate) return null;

  const bankroll = Math.max(0, parseInput(els.bankroll, 100));
  const allocation = clamp(parseInput(els.allocation, 5), 0.5, 5);
  const stake = bankroll * (allocation / 100);
  const aiProbability = clamp(parseInput(els.aiProbability, 50) / 100, 0.01, 0.99);
  const entry = clamp(Math.min(parseInput(els.priceCap, candidate.ask || 0.5), candidate.ask || 0.99), 0.01, 0.99);
  const shares = stake / entry;
  const profitIfWin = shares - stake;
  const ev = aiProbability * profitIfWin - (1 - aiProbability) * stake;
  const edge = aiProbability - entry;
  const roi = stake > 0 ? ev / stake : 0;
  const maxDrawdown = bankroll > 0 ? stake / bankroll : 0;
  const spreadOk = Number.isFinite(candidate.spread) && candidate.spread <= parseInput(els.maxSpread, 8) / 100;
  const liquidityOk = candidate.liquidity >= 100 || candidate.volume24hr >= 100;
  const priceOk = Number.isFinite(candidate.ask) && candidate.ask <= parseInput(els.priceCap, 1);
  const decision = edge >= 0.04 && ev > 0 && spreadOk && liquidityOk && priceOk ? "PAPER BUY" : "WAIT";

  return {
    bankroll,
    allocation,
    stake,
    aiProbability,
    entry,
    shares,
    profitIfWin,
    ev,
    edge,
    roi,
    maxDrawdown,
    spreadOk,
    liquidityOk,
    priceOk,
    decision,
  };
}

function renderCandidates() {
  els.candidateCount.textContent = String(state.candidates.length);
  if (!state.candidates.length) {
    els.candidates.innerHTML = '<div class="empty">Zatim nejsou nacteni kandidati.</div>';
    return;
  }

  els.candidates.innerHTML = state.candidates.map((item, index) => `
    <button class="candidate-button${state.selected === item ? " active" : ""}" type="button" data-candidate-index="${index}">
      <span class="candidate-score">${item.score}</span>
      <span>
        <strong>${escapeHtml(item.market.question)}</strong>
        <span class="market-meta">
          <span>${escapeHtml(item.outcome)}</span>
          <span>Ask ${probability(item.ask)}</span>
          <span>Spread ${Number.isFinite(item.spread) ? (item.spread * 100).toFixed(1) : "-"} pts</span>
          <span>24h ${money(item.volume24hr, 0)}</span>
        </span>
      </span>
    </button>
  `).join("");
}

function renderSelected() {
  const item = state.selected;
  if (!item) {
    els.title.textContent = "Vyber kandidata";
    els.selectedScore.textContent = "-";
    els.outcomeLabel.textContent = "-";
    els.bestAsk.textContent = "-";
    els.spread.textContent = "-";
    els.liquidity.textContent = "-";
    els.payload.value = "";
    return;
  }

  els.title.textContent = item.market.question;
  els.selectedScore.textContent = `${item.score}/100`;
  els.outcomeLabel.textContent = item.outcome;
  els.bestAsk.textContent = probability(item.ask);
  els.spread.textContent = Number.isFinite(item.spread) ? `${(item.spread * 100).toFixed(1)} pts` : "-";
  els.liquidity.textContent = money(item.liquidity, 0);
  els.priceCap.value = Number.isFinite(item.ask) ? item.ask.toFixed(3) : "0.50";
  updateMetrics();
  buildMemo();
}

function updateMetrics() {
  const trade = calcTrade();
  if (!trade) return;

  els.stake.textContent = money(trade.stake);
  els.ev.textContent = `${trade.ev >= 0 ? "+" : ""}${money(trade.ev)}`;
  els.ev.classList.toggle("positive", trade.ev > 0);
  els.ev.classList.toggle("negative", trade.ev < 0);
  els.drawdown.textContent = probability(trade.maxDrawdown);
  els.decision.textContent = trade.decision;
  els.decision.classList.toggle("positive", trade.decision === "PAPER BUY");
  els.decision.classList.toggle("negative", trade.decision !== "PAPER BUY");
  buildPayload();
  renderPortfolio();
}

function buildMemo() {
  const item = state.selected;
  const trade = calcTrade(item);
  if (!item || !trade) return;

  const positiveChecks = [
    trade.edge >= 0.04 ? "Edge proti best ask je alespon 4 procentni body." : "Edge zatim neni dostatecny.",
    trade.spreadOk ? "Spread je v ramci nastaveneho filtru." : "Spread je prilis siroky pro maly ucet.",
    trade.liquidityOk ? "Likvidita/volume staci pro paper test." : "Likvidita je tenka, live exekuce by mohla klouzat.",
    trade.priceOk ? "Entry price cap nepousti horsi cenu nez aktualni ask." : "Aktualni ask je nad cenovym limitem.",
  ];

  const tags = item.tags.join(", ");
  const dte = item.daysToEnd == null ? "neznamy" : `${item.daysToEnd.toFixed(0)} dni`;
  const breakEven = probability(trade.entry);
  const targetProbability = probability(trade.aiProbability);

  els.memo.innerHTML = `
    <section class="memo-section">
      <h3>Investment memo</h3>
      <p><strong>Hypoteza:</strong> paper BUY outcome <strong>${escapeHtml(item.outcome)}</strong>, jen pokud nase odhadovana pravdepodobnost ${targetProbability} realisticky prevysuje vstupni cenu ${probability(trade.entry)}.</p>
      <p><strong>Break-even:</strong> potrebuje se trefit alespon ${breakEven}. Aktualni edge je ${(trade.edge * 100).toFixed(1)} procentniho bodu.</p>
      <p><strong>Trzni kvalita:</strong> score ${item.score}/100, tagy ${escapeHtml(tags)}, konec trhu ${escapeHtml(dte)}, volume 24h ${money(item.volume24hr, 0)}.</p>
    </section>
    <section class="memo-section">
      <h3>Duvody pro / proti</h3>
      <ul>
        ${positiveChecks.map((check) => `<li>${escapeHtml(check)}</li>`).join("")}
      </ul>
    </section>
    <section class="memo-section">
      <h3>Co overit pred live obchodem</h3>
      <ul>
        <li>Presna resolution criteria v detailu Polymarket trhu.</li>
        <li>Primarni zdroj udalosti a cas, kdy se vysledek rozhodne.</li>
        <li>Zda existuje silny contra-scenar, ktery trh ocenuje spravne.</li>
        <li>Hloubka orderbooku na planovanou velikost orderu a pripadne fees/slippage.</li>
      </ul>
    </section>
  `;
  buildPayload();
}

function buildPayload() {
  const item = state.selected;
  const trade = calcTrade(item);
  if (!item || !trade) return;

  const payload = {
    mode: "paper-trading",
    portfolio: {
      bankrollUsdc: Number(trade.bankroll.toFixed(2)),
      maxAllocationPct: Number(trade.allocation.toFixed(2)),
      stakeUsdc: Number(trade.stake.toFixed(2)),
    },
    analysis: {
      aiProbability: Number(trade.aiProbability.toFixed(4)),
      marketPrice: Number(trade.entry.toFixed(4)),
      edge: Number(trade.edge.toFixed(4)),
      expectedValueUsdc: Number(trade.ev.toFixed(4)),
      expectedRoi: Number(trade.roi.toFixed(4)),
      maxLossUsdc: Number(trade.stake.toFixed(2)),
      decision: trade.decision,
    },
    market: {
      id: item.market.id,
      question: item.market.question,
      slug: item.market.slug,
      outcome: item.outcome,
      tokenId: item.tokenId,
      negRisk: Boolean(item.market.negRisk),
    },
    futureExecutorCommand:
      `npm run order:poc -- --token-id ${item.tokenId} --side BUY --price ${trade.entry.toFixed(4)} --size ${trade.shares.toFixed(4)} --tick-size ${item.market.orderPriceMinTickSize || "0.01"}${item.market.negRisk ? " --neg-risk true" : ""}`,
  };
  els.payload.value = JSON.stringify(payload, null, 2);
}

async function loadCandidates() {
  els.candidates.innerHTML = '<div class="empty">Nacitam trhy a orderbooky...</div>';
  els.candidateCount.textContent = "scan";
  const search = els.searchInput.value.trim();
  const minVolume = parseInput(els.minVolume, 500);
  const maxSpread = parseInput(els.maxSpread, 8) / 100;
  const query = new URLSearchParams({ action: "markets", limit: "20" });
  if (search) query.set("search", search);

  try {
    const payload = await getJson(`api.php?${query}`);
    const markets = payload.markets || [];
    const enriched = [];

    for (const market of markets) {
      const outcomes = Array.isArray(market.outcomes) ? market.outcomes : [];
      const tokenIds = Array.isArray(market.clobTokenIds) ? market.clobTokenIds : [];
      const maxOutcomes = Math.min(outcomes.length, tokenIds.length, 2);
      for (let outcomeIndex = 0; outcomeIndex < maxOutcomes; outcomeIndex += 1) {
        const tokenId = tokenIds[outcomeIndex];
        if (!tokenId) continue;
        try {
          const book = await getJson(`api.php?action=book&token_id=${encodeURIComponent(tokenId)}`);
          const candidate = scoreCandidate(market, outcomeIndex, book);
          if (
            candidate.volume24hr >= minVolume &&
            Number.isFinite(candidate.ask) &&
            Number.isFinite(candidate.spread) &&
            candidate.spread <= maxSpread
          ) {
            enriched.push(candidate);
          }
        } catch {
          // Some markets do not have a usable CLOB book; ignore them for paper candidates.
        }
      }
    }

    state.candidates = enriched.sort((a, b) => b.score - a.score).slice(0, 18);
    state.selected = state.candidates[0] || null;
    renderCandidates();
    renderSelected();
  } catch (error) {
    els.candidates.innerHTML = `<div class="error">${escapeHtml(error.message)}</div>`;
  }
}

function paperEnter() {
  const item = state.selected;
  const trade = calcTrade(item);
  if (!item || !trade) return;
  if (trade.decision !== "PAPER BUY") {
    window.alert("Paper entry blocked: analysis decision is WAIT. Raise AI probability, lower price cap, or choose a stronger candidate.");
    return;
  }

  const position = {
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    createdAt: new Date().toISOString(),
    status: "OPEN",
    question: item.market.question,
    outcome: item.outcome,
    tokenId: item.tokenId,
    entryPrice: Number(trade.entry.toFixed(4)),
    aiProbability: Number(trade.aiProbability.toFixed(4)),
    stake: Number(trade.stake.toFixed(2)),
    shares: Number(trade.shares.toFixed(4)),
    expectedValue: Number(trade.ev.toFixed(4)),
    maxLoss: Number(trade.stake.toFixed(2)),
    realizedPnl: 0,
    decision: trade.decision,
  };

  state.ledger.unshift(position);
  saveLedger();
  renderPortfolio();
}

function resolvePosition(id, outcome) {
  const position = state.ledger.find((item) => item.id === id);
  if (!position || position.status !== "OPEN") return;
  position.status = outcome === "WIN" ? "WON" : "LOST";
  position.resolvedAt = new Date().toISOString();
  position.realizedPnl = outcome === "WIN" ? Number((position.shares - position.stake).toFixed(2)) : -position.stake;
  saveLedger();
  renderPortfolio();
}

function renderPortfolio() {
  const bankroll = Math.max(0, parseInput(els.bankroll, 100));
  const open = state.ledger.filter((item) => item.status === "OPEN");
  const realizedPnl = state.ledger.reduce((sum, item) => sum + Number(item.realizedPnl || 0), 0);
  const openRisk = open.reduce((sum, item) => sum + Number(item.maxLoss || item.stake || 0), 0);
  const equity = bankroll + realizedPnl;

  els.sidebarEquity.textContent = money(equity);
  els.sidebarRisk.textContent = money(openRisk);
  els.sidebarPl.textContent = `${realizedPnl >= 0 ? "+" : ""}${money(realizedPnl)}`;

  if (!state.ledger.length) {
    els.ledger.innerHTML = '<div class="empty">Zatim zadne paper pozice.</div>';
    return;
  }

  els.ledger.innerHTML = `
    <table>
      <thead>
        <tr>
          <th>Market</th>
          <th>Entry</th>
          <th>Stake</th>
          <th>EV</th>
          <th>Status</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        ${state.ledger.map((position) => `
          <tr>
            <td>
              <strong>${escapeHtml(position.outcome)}</strong>
              <span>${escapeHtml(position.question)}</span>
            </td>
            <td>${probability(position.entryPrice)}</td>
            <td>${money(position.stake)}</td>
            <td class="${position.expectedValue >= 0 ? "positive" : "negative"}">${position.expectedValue >= 0 ? "+" : ""}${money(position.expectedValue)}</td>
            <td>${escapeHtml(position.status)}</td>
            <td>
              ${position.status === "OPEN" ? `
                <button class="mini-button" type="button" data-resolve-win="${position.id}">Win</button>
                <button class="mini-button" type="button" data-resolve-loss="${position.id}">Loss</button>
              ` : `<span class="${position.realizedPnl >= 0 ? "positive" : "negative"}">${position.realizedPnl >= 0 ? "+" : ""}${money(position.realizedPnl)}</span>`}
            </td>
          </tr>
        `).join("")}
      </tbody>
    </table>
  `;
}

els.candidates.addEventListener("click", (event) => {
  const button = event.target.closest("[data-candidate-index]");
  if (!button) return;
  state.selected = state.candidates[Number(button.dataset.candidateIndex)];
  renderCandidates();
  renderSelected();
});

[els.aiProbability, els.bankroll, els.allocation, els.priceCap, els.maxSpread].forEach((input) => {
  input.addEventListener("input", updateMetrics);
  input.addEventListener("change", updateMetrics);
});

els.refresh.addEventListener("click", loadCandidates);
els.search.addEventListener("click", loadCandidates);
els.searchInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") loadCandidates();
});
els.buildMemo.addEventListener("click", buildMemo);
els.paperEnter.addEventListener("click", paperEnter);
els.clearLedger.addEventListener("click", () => {
  state.ledger = [];
  saveLedger();
  renderPortfolio();
});
els.ledger.addEventListener("click", (event) => {
  const win = event.target.closest("[data-resolve-win]");
  const loss = event.target.closest("[data-resolve-loss]");
  if (win) resolvePosition(win.dataset.resolveWin, "WIN");
  if (loss) resolvePosition(loss.dataset.resolveLoss, "LOSS");
});
els.copy.addEventListener("click", async () => {
  await navigator.clipboard.writeText(els.payload.value);
});

renderPortfolio();
loadCandidates();
