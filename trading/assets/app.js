const state = {
  markets: [],
  selectedMarket: null,
  selectedOutcomeIndex: 0,
  selectedBook: null,
};

const els = {
  markets: document.querySelector("[data-markets]"),
  refresh: document.querySelector("[data-refresh]"),
  search: document.querySelector("[data-search]"),
  searchInput: document.querySelector("#marketSearch"),
  title: document.querySelector("[data-selected-title]"),
  outcome: document.querySelector("[data-outcome]"),
  side: document.querySelector("[data-side]"),
  price: document.querySelector("[data-price]"),
  bankroll: document.querySelector("[data-bankroll]"),
  allocation: document.querySelector("[data-allocation]"),
  amount: document.querySelector("[data-amount]"),
  maxOrder: document.querySelector("[data-max-order]"),
  payload: document.querySelector("[data-payload]"),
  build: document.querySelector("[data-build]"),
  copy: document.querySelector("[data-copy]"),
  bestBid: document.querySelector("[data-best-bid]"),
  bestAsk: document.querySelector("[data-best-ask]"),
  spread: document.querySelector("[data-spread]"),
};

function money(value, digits = 2) {
  if (!Number.isFinite(value)) return "-";
  return `$${value.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

function probability(value) {
  if (!Number.isFinite(value)) return "-";
  return `${(value * 100).toFixed(1)}%`;
}

function parseNumber(input, fallback = 0) {
  const value = Number(input?.value);
  return Number.isFinite(value) ? value : fallback;
}

async function getJson(url) {
  const response = await fetch(url, { cache: "no-store" });
  const payload = await response.json();
  if (!response.ok || !payload.ok) {
    throw new Error(payload.error || `Request failed: ${response.status}`);
  }
  return payload;
}

function renderMarkets() {
  if (!state.markets.length) {
    els.markets.innerHTML = '<div class="empty">No markets loaded.</div>';
    return;
  }

  els.markets.innerHTML = state.markets
    .map((market, index) => {
      const prices = market.outcomePrices?.map((item) => Number(item)).filter(Number.isFinite) || [];
      const summary = prices.length ? prices.map(probability).join(" / ") : "No prices";
      return `
        <button class="market-button${market === state.selectedMarket ? " active" : ""}" type="button" data-market-index="${index}">
          <strong>${market.question}</strong>
          <span class="market-meta">
            <span>${summary}</span>
            <span>Liquidity ${money(Number(market.liquidity || 0), 0)}</span>
            <span>24h ${money(Number(market.volume24hr || 0), 0)}</span>
          </span>
        </button>
      `;
    })
    .join("");
}

function renderOutcomeOptions() {
  const market = state.selectedMarket;
  if (!market) {
    els.outcome.innerHTML = "";
    return;
  }

  els.outcome.innerHTML = market.outcomes
    .map((outcome, index) => `<option value="${index}">${outcome}</option>`)
    .join("");
  els.outcome.value = String(state.selectedOutcomeIndex);
}

function selectedTokenId() {
  return state.selectedMarket?.clobTokenIds?.[state.selectedOutcomeIndex] || "";
}

function updateRisk() {
  const bankroll = parseNumber(els.bankroll, 0);
  const allocation = Math.min(5, Math.max(0, parseNumber(els.allocation, 5)));
  const max = bankroll * (allocation / 100);
  const amount = Math.min(parseNumber(els.amount, max), max || parseNumber(els.amount, 0));
  els.maxOrder.textContent = money(max);
  if (Number.isFinite(amount) && max > 0 && parseNumber(els.amount, 0) > max) {
    els.amount.value = amount.toFixed(2);
  }
}

function buildPayload() {
  updateRisk();
  const tokenId = selectedTokenId();
  const price = parseNumber(els.price, 0.5);
  const amount = parseNumber(els.amount, 0);
  const size = price > 0 ? amount / price : 0;
  const payload = {
    mode: "dry-run",
    market: {
      id: state.selectedMarket?.id || null,
      question: state.selectedMarket?.question || null,
      slug: state.selectedMarket?.slug || null,
    },
    order: {
      tokenId,
      outcome: state.selectedMarket?.outcomes?.[state.selectedOutcomeIndex] || null,
      side: els.side.value,
      price: Number(price.toFixed(4)),
      size: Number(size.toFixed(4)),
      amountUsdc: Number(amount.toFixed(2)),
      tickSize: state.selectedBook?.book?.tick_size || "0.01",
      negRisk: Boolean(state.selectedMarket?.negRisk),
      orderType: "GTC",
    },
    executorCommand:
      `npm run order:poc -- --token-id ${tokenId} --side ${els.side.value} --price ${price.toFixed(4)} --size ${size.toFixed(4)} --tick-size ${state.selectedBook?.book?.tick_size || "0.01"}${state.selectedMarket?.negRisk ? " --neg-risk true" : ""}`,
  };
  els.payload.value = JSON.stringify(payload, null, 2);
}

function renderBook() {
  const book = state.selectedBook;
  els.bestBid.textContent = book?.bestBid == null ? "-" : probability(Number(book.bestBid));
  els.bestAsk.textContent = book?.bestAsk == null ? "-" : probability(Number(book.bestAsk));
  els.spread.textContent = book?.spread == null ? "-" : `${(Number(book.spread) * 100).toFixed(1)} pts`;
  if (book?.bestAsk != null && els.side.value === "BUY") {
    els.price.value = Number(book.bestAsk).toFixed(2);
  }
  buildPayload();
}

async function loadMarkets() {
  els.markets.innerHTML = '<div class="empty">Loading markets...</div>';
  const search = els.searchInput.value.trim();
  const query = new URLSearchParams({ action: "markets", limit: "20" });
  if (search) query.set("search", search);
  try {
    const payload = await getJson(`api.php?${query}`);
    state.markets = payload.markets || [];
    state.selectedMarket = state.markets[0] || null;
    state.selectedOutcomeIndex = 0;
    renderMarkets();
    renderOutcomeOptions();
    await loadBook();
  } catch (error) {
    els.markets.innerHTML = `<div class="error">${error.message}</div>`;
  }
}

async function loadBook() {
  const tokenId = selectedTokenId();
  if (!tokenId) return;
  els.title.textContent = state.selectedMarket.question;
  state.selectedBook = null;
  renderBook();
  try {
    state.selectedBook = await getJson(`api.php?action=book&token_id=${encodeURIComponent(tokenId)}`);
    renderBook();
  } catch (error) {
    els.payload.value = JSON.stringify({ error: error.message }, null, 2);
  }
}

els.markets.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-market-index]");
  if (!button) return;
  state.selectedMarket = state.markets[Number(button.dataset.marketIndex)];
  state.selectedOutcomeIndex = 0;
  renderMarkets();
  renderOutcomeOptions();
  await loadBook();
});

els.outcome.addEventListener("change", async () => {
  state.selectedOutcomeIndex = Number(els.outcome.value);
  await loadBook();
});

[els.side, els.price, els.bankroll, els.allocation, els.amount].forEach((input) => {
  input.addEventListener("input", buildPayload);
  input.addEventListener("change", buildPayload);
});

els.refresh.addEventListener("click", loadMarkets);
els.search.addEventListener("click", loadMarkets);
els.searchInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") loadMarkets();
});
els.build.addEventListener("click", buildPayload);
els.copy.addEventListener("click", async () => {
  await navigator.clipboard.writeText(els.payload.value);
});

loadMarkets();
