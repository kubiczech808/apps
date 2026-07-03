const chart = document.querySelector("#equityChart");
const rangeButtons = document.querySelectorAll("[data-range]");
const risk = document.querySelector("#risk");
const riskValue = document.querySelector("#riskValue");
const toggleButton = document.querySelector("[data-toggle-bot]");
const refreshButton = document.querySelector("[data-refresh]");
const botState = document.querySelector("[data-bot-state]");
const botDetail = document.querySelector("[data-bot-detail]");
const pl = document.querySelector("[data-pl]");

let botRunning = false;
let activeRange = "1D";

const series = {
  "1D": [48010, 48070, 48120, 48040, 48190, 48210, 48160, 48290, 48325, 48260],
  "1W": [46200, 46520, 46880, 47140, 46990, 47660, 48120, 47940, 48260, 48280],
  "1M": [42100, 43060, 44420, 43840, 45220, 46640, 47290, 46910, 47880, 48260],
};

function drawChart() {
  if (!chart) return;

  const ctx = chart.getContext("2d");
  const rect = chart.getBoundingClientRect();
  const scale = window.devicePixelRatio || 1;
  chart.width = Math.round(rect.width * scale);
  chart.height = Math.round(rect.height * scale);
  ctx.scale(scale, scale);

  const width = rect.width;
  const height = rect.height;
  const padding = 34;
  const values = series[activeRange];
  const min = Math.min(...values) - 180;
  const max = Math.max(...values) + 180;
  const stepX = (width - padding * 2) / (values.length - 1);

  ctx.clearRect(0, 0, width, height);
  ctx.lineWidth = 1;
  ctx.strokeStyle = "#d9e1e7";

  for (let i = 0; i < 5; i += 1) {
    const y = padding + ((height - padding * 2) / 4) * i;
    ctx.beginPath();
    ctx.moveTo(padding, y);
    ctx.lineTo(width - padding, y);
    ctx.stroke();
  }

  const points = values.map((value, index) => ({
    x: padding + stepX * index,
    y: padding + (1 - (value - min) / (max - min)) * (height - padding * 2),
  }));

  const gradient = ctx.createLinearGradient(0, padding, 0, height - padding);
  gradient.addColorStop(0, "rgba(15, 159, 122, 0.22)");
  gradient.addColorStop(1, "rgba(15, 159, 122, 0)");

  ctx.beginPath();
  points.forEach((point, index) => {
    if (index === 0) ctx.moveTo(point.x, point.y);
    else ctx.lineTo(point.x, point.y);
  });
  ctx.lineTo(points.at(-1).x, height - padding);
  ctx.lineTo(points[0].x, height - padding);
  ctx.closePath();
  ctx.fillStyle = gradient;
  ctx.fill();

  ctx.beginPath();
  points.forEach((point, index) => {
    if (index === 0) ctx.moveTo(point.x, point.y);
    else ctx.lineTo(point.x, point.y);
  });
  ctx.strokeStyle = "#0f9f7a";
  ctx.lineWidth = 3;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.stroke();

  const lastPoint = points.at(-1);
  ctx.beginPath();
  ctx.arc(lastPoint.x, lastPoint.y, 6, 0, Math.PI * 2);
  ctx.fillStyle = "#ffffff";
  ctx.fill();
  ctx.strokeStyle = "#0f9f7a";
  ctx.lineWidth = 3;
  ctx.stroke();
}

rangeButtons.forEach((button) => {
  button.addEventListener("click", () => {
    activeRange = button.dataset.range;
    rangeButtons.forEach((item) => item.classList.toggle("active", item === button));
    drawChart();
  });
});

risk?.addEventListener("input", () => {
  riskValue.textContent = `${Number(risk.value).toFixed(1)} %`;
});

toggleButton?.addEventListener("click", () => {
  botRunning = !botRunning;
  toggleButton.classList.toggle("running", botRunning);
  toggleButton.textContent = botRunning ? "Pozastavit robota" : "Spustit robota";
  botState.textContent = botRunning ? "Bezi" : "Pozastaveno";
  botDetail.textContent = botRunning ? "Skenuje trhy kazdych 30 s" : "Ceka na spusteni";
});

refreshButton?.addEventListener("click", () => {
  const current = Number(pl.textContent.replace(/[^0-9.-]/g, ""));
  const next = current + (Math.random() * 48 - 18);
  pl.textContent = `${next >= 0 ? "+" : "-"}$${Math.abs(next).toFixed(2)}`;
  pl.classList.toggle("positive", next >= 0);
  pl.classList.toggle("negative", next < 0);
  drawChart();
});

window.addEventListener("resize", drawChart);
drawChart();
