import { DEFAULT_PROJ, callStatus } from "./engine.js";

// Página ao vivo (/) lê o histórico gravado pelo coletor (server/poller.mjs) em live/.
// A demonstração (/demo) reproduz o 2º turno de 2022 na ordem real de apuração, com um
// controle que define o ponto da apuração.
const DEV = document.documentElement.dataset.mode === "demo";
const asset = (p) => new URL(p, import.meta.url).href; // caminhos relativos a este arquivo
document.body.insertAdjacentHTML("afterbegin", `
<div class="dev" id="dev" hidden>
  <div class="dev-in">
    <b>DEV</b>
    <input type="range" id="progress" min="0" max="1000" value="350" aria-label="Andamento da apuração (reprodução de 2022)">
    <output id="progress-o"></output>
  </div>
</div>

<div class="wrap">
  <div class="top">
    <div class="brand"><img data-src="img/brasil.webp" alt="Bandeira do Brasil" width="44" height="31"><span><b>2º turno</b> – Acompanhamento e Projeção</span></div>
    <div class="live" id="live" role="status"><i></i><span id="updated">Carregando…</span></div>
  </div>

  <section class="hero" id="hero" aria-live="polite">
    <div class="verdict"><h1 id="headline">Carregando a apuração</h1><p id="subline"></p></div>
    <div class="duel" id="duel"></div>
    <div class="tug" id="tug"></div>
    <div class="progress" id="prog"></div>
  </section>

  <section class="block">
    <h2>A noite até agora</h2>
    <p>As linhas contínuas são a apuração oficial. As tracejadas levam ao resultado final projetado, e a faixa mostra o intervalo de confiança de <span id="conf-l">95%</span>.</p>
    <div class="panel">
      <div class="legend" id="legend"></div>
      <div class="chart" id="chart"></div>
    </div>
  </section>

  <section class="block">
    <h2>Estados</h2>
    <p>Resultado apurado e projetado em cada estado. Clique no nome de uma coluna para ordenar.</p>
    <div class="tablewrap"><table class="ufs" id="ufs"></table></div>
  </section>

  <p class="note" id="note"></p>

  <footer class="credit">
    <img data-src="img/carlos-schwabe.jpg" alt="Carlos Schwabe" width="48" height="60">
    <span>Desenvolvido por <strong>Carlos Schwabe</strong></span>
    <a href="https://github.com/carlos-schwabe" target="_blank" rel="noopener" aria-label="GitHub de Carlos Schwabe">
      <svg viewBox="0 0 16 16" width="22" height="22" aria-hidden="true"><path fill="currentColor" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>
    </a>
  </footer>
</div>
`);
for (const img of document.querySelectorAll("img[data-src]")) img.src = asset(img.dataset.src);
// "lula" e "bolso" são os candidatos A (13) e B (22) do motor
const CANDIDATES = DEV ? {
  lula: { name: "Lula", number: "13", party: "PT", color: "--a", photo: asset("img/lula.jpg") },
  bolso: { name: "Bolsonaro", number: "22", party: "PL", color: "--b", photo: asset("img/flavio-bolsonaro.jpg") },
} : {
  lula: { name: "Lula", number: "13", party: "PT", color: "--a", photo: asset("img/lula.jpg") },
  bolso: { name: "Flávio Bolsonaro", number: "22", party: "PL", color: "--b", photo: asset("img/flavio-bolsonaro.jpg") },
};
const CERTAINTY = 0.999;
const PROJ = { ...DEFAULT_PROJ };
const ELECTION = DEV ? "30/10/2022" : "25/10/2026";
const LIVE_REFRESH = 15000; // ms entre leituras de latest.json
const FULL_REFRESH = 5 * 60000; // ms entre leituras do histórico completo
const STALE_AFTER = 60000; // ms sem atualização do coletor até avisar o leitor

const $ = (id) => document.getElementById(id);
const pct = (v, d = 1) => (v * 100).toFixed(d).replace(".", ",") + "%";
const pp = (v, d = 1) => (v * 100).toFixed(d).replace(".", ",");
const num = (v) => Math.round(v).toLocaleString("pt-BR");
const clock = (min) => { const t = 17 * 60 + min; return `${String(Math.floor(t / 60) % 24).padStart(2, "0")}:${String(Math.floor(t % 60)).padStart(2, "0")}`; };
const conf = Math.round(PROJ.confidence * 100);
$("conf-l").textContent = conf + "%";
function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }

let N = 0, view = null, ufNames = [], ufSort = { key: "uf", dir: 1 };

/* ---------- Motor (DEV) ---------- */
const worker = DEV ? new Worker(new URL("./worker.js", import.meta.url), { type: "module" }) : null;
let reqId = 0, pending = false, queued = false;
function request() {
  if (pending) { queued = true; return; }
  pending = true;
  worker.postMessage({ id: ++reqId, kind: "live", proj: PROJ, fraction: progress(), points: 300 });
}
if (DEV) worker.onmessage = ({ data }) => {
  if (data.type === "meta") { N = data.N; ufNames = data.ufNames; return; }
  pending = false;
  if (data.type === "error") { showError("Falha na projeção: " + data.message); return; }
  view = { curve: data.curve, snap: data.snap, ufs: data.snap.ufs.map((u, i) => ({ ...u, uf: ufNames[i], counted: u.sections })), updated: null };
  render();
  if (queued) { queued = false; request(); }
};
if (DEV) worker.onerror = (e) => showError("Não foi possível iniciar o motor: " + (e.message || "erro no worker") + ". Sirva a pasta app por HTTP.");
function showError(msg) { const u = $("updated"); u.textContent = ""; u.append(el("span", "err", msg)); }

/* ---------- Barra de progresso (DEV) ---------- */
function progress() { return Math.max(0.001, +$("progress").value / 1000); }
if (DEV) {
  $("dev").hidden = false;
  const show = () => { $("progress-o").textContent = `${pct(progress())} das seções`; };
  show();
  $("progress").addEventListener("input", () => { show(); request(); });
  request();
}

/* ---------- Dados ao vivo (gravados pelo coletor) ---------- */
// Endereço dos arquivos do coletor: <meta name="sibila-live" content="https://..."> no HTML,
// ou a pasta live/ ao lado da página.
const LIVE_BASE = document.querySelector('meta[name="sibila-live"]')?.content || asset("live/");
const liveUrl = (f) => new URL(f, LIVE_BASE.endsWith("/") ? LIVE_BASE : LIVE_BASE + "/").href;
const getJson = (f) => fetch(liveUrl(f), { cache: "no-cache" }).then((r) => { if (!r.ok) throw new Error(`${f}: HTTP ${r.status}`); return r.json(); });
// Na página ao vivo, "% apurado" é sempre a contagem de seções do próprio TSE
const tseFrac = (h) => (h.tse?.ts ? h.tse.st / h.tse.ts : h.sections);
const curvePoint = (h) => ({ done: h.done, sections: tseFrac(h), time: h.t, raw: h.raw });
let lastFull = 0;

// A curva (history.json, em colunas) é baixada ao abrir a página e a cada 5 minutos; nos outros
// ciclos só latest.json (poucos KB), cujo ponto é acrescentado à curva se a apuração andou.
async function loadLive() {
  // status.json: fase e saúde do TSE, publicados pelo servidor (ausente fora do server/main.mjs)
  const statusP = getJson("status.json").catch(() => null);
  try {
    const full = !view || Date.now() - lastFull > FULL_REFRESH;
    const [history, latest, status] = await Promise.all([full ? getJson("history.json").catch(() => null) : null, getJson("latest.json").catch(() => null), statusP]);
    liveStatus = status;
    const p = latest?.point;
    if (!p) { renderWaiting(status); return; }
    let curve = view?.curve ?? [];
    if (full && history) {
      curve = (history.sections ?? []).map((sec, i) => ({ sections: sec, time: history.t[i], raw: history.raw[i], done: history.done[i] }));
      lastFull = Date.now();
    }
    if (curve.at(-1)?.done !== p.done) curve = [...curve, curvePoint(p)];
    N = latest.nSections;
    view = {
      curve,
      snap: { ...p, sections: tseFrac(p), time: p.t, lulaVotes: p.a, bolsoVotes: p.b },
      ufs: latest.ufs,
      updated: latest.updated,
    };
    render();
  } catch (e) {
    if (view) render(); // mantém o último resultado; o aviso de dados parados aparece sozinho
    else showError(`Não foi possível carregar os resultados ao vivo (${e.message}).`);
  }
}
let liveStatus = null;

// Antes da apuração: manchete de espera e, no cabeçalho, se o TSE está respondendo
function renderWaiting(status) {
  document.body.classList.add("waiting");
  $("headline").textContent = "Aguardando o 2º turno";
  $("subline").textContent = status?.dia ? `A apuração começa às 17h de ${status.dia}. Esta página se atualiza sozinha.` : "Esta página se atualiza sozinha quando a apuração começar.";
  setTseIndicator(status);
}
function setTseIndicator(status) {
  if (!status?.tse) return;
  const live = $("live");
  live.classList.toggle("on", false);
  live.classList.toggle("ok", status.tse.ok);
  live.classList.toggle("stale", !status.tse.ok);
  const since = status.tse.lastOk ? ` desde ${new Date(status.tse.lastOk).toLocaleTimeString("pt-BR")}` : "";
  $("updated").textContent = status.tse.ok ? "TSE respondendo" : `TSE sem resposta${since}`;
}
if (!DEV) { loadLive(); setInterval(loadLive, LIVE_REFRESH); }

/* ---------- Renderização ---------- */
function render() {
  const { snap, curve } = view;
  const st = callStatus(snap, CERTAINTY);
  $("live").classList.toggle("on", !DEV && snap.sections < 1);
  const age = DEV ? 0 : Date.now() - new Date(view.updated).getTime();
  const stale = !DEV && snap.sections < 1 && age > STALE_AFTER;
  $("live").classList.toggle("stale", stale);
  $("updated").textContent = DEV ? `Reprodução de ${ELECTION}`
    : stale ? `Sem atualização há ${Math.round(age / 60000)} min (última às ${new Date(view.updated).toLocaleTimeString("pt-BR")})`
    : `Atualizado às ${new Date(view.updated).toLocaleTimeString("pt-BR")}`;
  document.body.classList.remove("waiting");
  if (!DEV && liveStatus?.tse && !liveStatus.tse.ok && !stale) setTseIndicator(liveStatus);
  renderHero(snap, st);
  renderChart(snap, curve);
  renderStates(view.ufs);
  $("note").textContent = `Como lemos a apuração: cada seção ainda não apurada é estimada pelo seu resultado no 1º turno somado à variação entre turnos das seções já apuradas ${DEV ? "da área mais próxima com dados suficientes (local de votação, zona, município ou estado)" : "da zona, do município ou do estado"}. Apontamos um vencedor provável quando a projeção dá ${pct(CERTAINTY)} de chance a um candidato. Eleito significa que a vantagem já supera o número de eleitores que ainda faltam apurar. A margem de erro é a do intervalo de confiança de ${conf}%.`;
}

// Visão de um instante por candidato (% dos votos válidos)
function cand(snap, key) {
  const a = key === "lula";
  return {
    raw: a ? snap.raw : 1 - snap.raw,
    votes: a ? snap.lulaVotes : snap.bolsoVotes,
    share: a ? snap.share : 1 - snap.share,
    lo: a ? snap.lo : 1 - snap.hi,
    hi: a ? snap.hi : 1 - snap.lo,
    pWin: a ? snap.pWin : 1 - snap.pWin,
  };
}
const chance = (p) => (p > 0.99999 ? "mais de 99,999%" : pct(p, p > 0.999 ? 3 : 1));

function renderHero(snap, st) {
  const lead = CANDIDATES[st.winner], lv = cand(snap, st.winner);
  document.body.classList.toggle("won-a", st.stage === "decided" && st.winner === "lula");
  document.body.classList.toggle("won-b", st.stage === "decided" && st.winner === "bolso");
  const projText = `${pct(lv.share)} ± ${pp(lv.hi - lv.share)} na projeção`;
  const nameEl = () => { const n = el("span", "cand-name", lead.name); n.style.color = `var(${lead.color})`; return n; };
  // Veredito, com a projeção do líder logo abaixo
  const h1 = $("headline"), sub = $("subline");
  h1.textContent = "";
  sub.textContent = "";
  if (st.stage === "decided") {
    h1.append(nameEl(), document.createTextNode(" está eleito"), el("span", "confirma", "Confirmado"));
    sub.append(el("strong", "proj-line", projText), el("span", null, `A vantagem de ${num(Math.abs(snap.lulaVotes - snap.bolsoVotes))} votos já supera os ${num(snap.aptosLeft)} eleitores que ainda faltam apurar.`));
  } else if (st.stage === "likely") {
    h1.append(nameEl(), document.createTextNode(" deve vencer"));
    sub.append(el("strong", "proj-line", projText), el("span", null, `${chance(lv.pWin)} de chance de vitória.`));
  } else {
    h1.textContent = "Disputa indefinida";
    const line = el("strong", "proj-line");
    line.append(nameEl(), document.createTextNode(`: ${projText}`));
    sub.append(line, el("span", null, `${chance(lv.pWin)} de chance. Para apontar um vencedor, exigimos ${pct(CERTAINTY)}.`));
  }

  // Duelo: os números grandes são a apuração
  const duel = $("duel"); duel.textContent = "";
  for (const key of ["lula", "bolso"]) {
    const c = CANDIDATES[key], v = cand(snap, key);
    const side = el("div", `side ${key === "lula" ? "a" : "b"}`);
    const who = el("div", "who");
    const keys = el("span", "keys"); keys.setAttribute("aria-label", `número ${c.number}`);
    for (const d of c.number) keys.append(el("kbd", null, d));
    who.append(keys, el("span", "name", c.name));
    const photo = el("img", "photo"); photo.src = c.photo; photo.alt = c.name; photo.width = 88; photo.height = 88;
    side.append(photo, who, el("div", "share", pct(v.raw, 2)), el("div", "counted", `${num(v.votes)} votos`));
    duel.append(side);
  }

  // Dois cabos de guerra na mesma escala: a apuração e, abaixo, a projeção com a margem de erro
  const tug = $("tug"); tug.textContent = "";
  tug.append(tugRow("Apuração", snap.raw, null, "big"));
  tug.append(tugRow("Projeção", snap.share, [snap.lo, snap.hi], "small"));

  // Andamento: ao vivo, a contagem de seções do próprio TSE; na demonstração, a do modelo
  const done = snap.tse?.ts ? snap.tse.st : snap.done, total = snap.tse?.ts || N, frac = done / total;
  const prog = $("prog"); prog.textContent = "";
  const meter = el("div", "meter"), mb = el("b"); mb.style.width = (frac * 100).toFixed(2) + "%"; meter.append(mb);
  const big = el("div", "big", `${pct(frac)} das seções apuradas`);
  const meta = el("div", "meta", `${num(done)} de ${num(total)} seções, ${num(snap.lulaVotes + snap.bolsoVotes)} votos válidos.`);
  prog.append(meter, big, meta);
}

// Uma barra dividida: vermelho até `a` (fração de Lula), azul no resto, linha de 50% no meio.
// Com `ci`, uma faixa branca sobre a divisa mostra a margem de erro.
function tugRow(label, a, ci, size) {
  const row = el("div", `tug-row ${size}`);
  const track = el("div", "track");
  const bar = el("div", "bar");
  const ia = el("i", "a"), ib = el("i", "b");
  ia.style.width = (a * 100).toFixed(3) + "%"; ib.style.width = ((1 - a) * 100).toFixed(3) + "%";
  bar.append(ia, ib);
  track.append(bar);
  if (ci) {
    const band = el("span", "ci");
    const lo = Math.max(0, ci[0]), hi = Math.min(1, ci[1]);
    band.style.left = (lo * 100).toFixed(3) + "%";
    band.style.width = `max(3px, ${((hi - lo) * 100).toFixed(3)}%)`;
    band.title = `Margem de erro: ${pct(ci[0])} a ${pct(ci[1])}`;
    track.append(band);
  }
  track.append(el("span", "mid"));
  row.append(el("span", "lab", label), track);
  return row;
}

function scale(d0, d1, r0, r1) { const k = (r1 - r0) / (d1 - d0 || 1); const f = (v) => r0 + (v - d0) * k; f.inv = (p) => d0 + (p - r0) / k; return f; }
const fmt = (n) => n.toFixed(1);

// Inclinação estável do fim da curva: mínimos quadrados sobre os últimos 20 pontos percentuais
// de seções apuradas, amortecida e limitada, para que o ruído da apuração não dobre o caminho.
function trendSlope(curve, key) {
  const end = curve.at(-1).sections, from = Math.max(0, end - 0.2);
  const pts = curve.filter((p) => p.sections >= from).map((p) => [p.sections, key === "lula" ? p.raw : 1 - p.raw]);
  if (pts.length < 5 || end - from < 0.02) return 0;
  const mx = pts.reduce((a, p) => a + p[0], 0) / pts.length, my = pts.reduce((a, p) => a + p[1], 0) / pts.length;
  let sxy = 0, sxx = 0;
  for (const [x, y] of pts) { sxy += (x - mx) * (y - my); sxx += (x - mx) ** 2; }
  return Math.max(-0.2, Math.min(0.2, 0.5 * (sxx > 0 ? sxy / sxx : 0))); // fração de voto por fração de seções
}

function renderChart(snap, curve) {
  const box = $("chart");
  const w = Math.max(300, box.clientWidth), h = w < 600 ? 300 : 380;
  const m = { l: 44, r: w < 600 ? 104 : 150, t: 14, b: 30 };
  const iw = w - m.l - m.r, ih = h - m.t - m.b;
  const X = scale(0, 100, m.l, m.l + iw);
  const keys = ["lula", "bolso"];
  // Eixo y simétrico em torno de 50%, largo o bastante para as linhas apuradas e o intervalo
  let dev = 0.03;
  for (const c of curve) if (c.sections > 0.01) dev = Math.max(dev, Math.abs(c.raw - 0.5));
  dev = Math.max(dev, Math.abs(snap.raw - 0.5), Math.min(0.2, Math.max(Math.abs(snap.hi - 0.5), Math.abs(snap.lo - 0.5))));
  dev = Math.ceil((dev + 0.01) * 50) / 50;
  const Y = scale(0.5 - dev, 0.5 + dev, m.t + ih, m.t);
  const step = dev > 0.1 ? 0.05 : dev > 0.05 ? 0.02 : 0.01;
  let s = `<svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-label="Apuração e projeção ao longo da noite">`;
  s += `<defs><clipPath id="clip"><rect x="${m.l}" y="${m.t}" width="${iw + m.r}" height="${ih}"/></clipPath></defs>`;
  for (let v = 0.5 - dev; v <= 0.5 + dev + 1e-9; v += step) {
    const y = Y(v);
    s += `<line x1="${m.l}" x2="${m.l + iw}" y1="${y}" y2="${y}" stroke="var(--rule)"/><text x="${m.l - 8}" y="${y + 4}" text-anchor="end">${Math.round(v * 100)}%</text>`;
  }
  for (const v of [0, 25, 50, 75, 100]) s += `<text x="${X(v)}" y="${h - 8}" text-anchor="middle">${v}%</text>`;
  s += `<line x1="${m.l}" x2="${m.l + iw}" y1="${Y(0.5)}" y2="${Y(0.5)}" stroke="var(--ink-3)" stroke-dasharray="2 4"/>`;
  const x0 = X(snap.sections * 100), xe = X(100);
  // Marcador de "agora" e a região ainda não apurada
  s += `<rect x="${x0}" y="${m.t}" width="${xe - x0}" height="${ih}" fill="var(--rule)" fill-opacity="0.35"/>`;
  s += `<line x1="${x0}" x2="${x0}" y1="${m.t}" y2="${m.t + ih}" stroke="var(--ink-2)"/>`;
  const late = snap.sections > 0.8;
  s += `<text x="${late ? x0 - 8 : x0 + 8}" y="${m.t + 16}" text-anchor="${late ? "end" : "start"}">agora, ${pct(snap.sections, 0)} apurado</text>`;
  if (!late) s += `<text x="${X(100) - 6}" y="${m.t + ih - 8}" text-anchor="end">seções apuradas</text>`;
  s += `<g clip-path="url(#clip)">`;
  const labels = [];
  for (const key of keys) {
    const c = CANDIDATES[key], v = cand(snap, key), col = `var(${c.color})`;
    const pts = curve.map((p) => [X(p.sections * 100), Y(key === "lula" ? p.raw : 1 - p.raw)]);
    const y0 = Y(v.raw);
    const dx = xe - x0;
    // inclinação em px por px: (pixels por ponto de voto) / (pixels por ponto de seções); y cresce para baixo
    const slopePx = -trendSlope(curve, key) * (Y(0) - Y(0.01)) / (X(1) - X(0));
    // cúbica do ponto atual até o fim: sai na tendência recente e chega na horizontal
    const c1 = (yEnd) => [x0 + dx * 0.35, Math.min(Math.max(y0 + slopePx * dx * 0.35, Math.min(y0, yEnd) - 16), Math.max(y0, yEnd) + 16)];
    const ctl = (yEnd) => { const [cx, cy] = c1(yEnd); return `C${fmt(cx)},${fmt(cy)} ${fmt(x0 + dx * 0.6)},${fmt(yEnd)} ${fmt(xe)},${fmt(yEnd)}`; };
    const back = (yEnd) => { const [cx, cy] = c1(yEnd); return `C${fmt(x0 + dx * 0.6)},${fmt(yEnd)} ${fmt(cx)},${fmt(cy)} ${fmt(x0)},${fmt(y0)}`; };
    const yLo = Y(v.lo), yHi = Y(v.hi), yP = Y(v.share);
    if (dx > 0.5) {
      s += `<path d="M${fmt(x0)},${fmt(y0)} ${ctl(yHi)} L${fmt(xe)},${fmt(yLo)} ${back(yLo)} Z" fill="${col}" fill-opacity="0.13"/>`;
      s += `<path d="M${fmt(x0)},${fmt(y0)} ${ctl(yP)}" fill="none" stroke="${col}" stroke-width="2" stroke-dasharray="6 5"/>`;
      s += `<line x1="${xe}" x2="${xe}" y1="${yHi}" y2="${yLo}" stroke="${col}" stroke-width="2"/>`;
      s += `<circle cx="${xe}" cy="${yP}" r="5" fill="var(--paper)" stroke="${col}" stroke-width="2.5"/>`;
    }
    s += `<path d="${pts.map(([x, y], i) => `${i ? "L" : "M"}${fmt(x)},${fmt(y)}`).join("")}" fill="none" stroke="${col}" stroke-width="2.5" stroke-linejoin="round"/>`;
    s += `<circle cx="${x0}" cy="${y0}" r="4.5" fill="${col}" stroke="var(--paper)" stroke-width="2"/>`;
    labels.push({ y: yP, name: c.name, val: `${pct(v.share)} projetado` });
  }
  s += `</g>`;
  // rótulos finais, afastados se colidirem
  labels.sort((a, b) => a.y - b.y);
  if (labels[1].y - labels[0].y < 38) { const mid = (labels[0].y + labels[1].y) / 2; labels[0].y = mid - 19; labels[1].y = mid + 19; }
  for (const L of labels) {
    s += `<text class="lab" x="${xe + 12}" y="${L.y - 2}">${L.name}</text>`;
    s += `<text x="${xe + 12}" y="${L.y + 14}">${L.val}</text>`;
  }
  s += `<line id="xh" x1="0" x2="0" y1="${m.t}" y2="${m.t + ih}" stroke="var(--ink-2)" stroke-dasharray="2 2" visibility="hidden"/>`;
  s += `</svg>`;
  box.innerHTML = s;

  const legend = $("legend"); legend.textContent = "";
  for (const key of keys) { const sp = el("span"); const i = el("i"); i.style.borderTopColor = `var(${CANDIDATES[key].color})`; sp.append(i, document.createTextNode(CANDIDATES[key].name)); legend.append(sp); }
  for (const [label, cls] of [["Caminho até a projeção", "dash"], [`Intervalo de ${conf}%`, "box"]]) { const sp = el("span"); const i = el("i", cls); sp.append(i, document.createTextNode(label)); legend.append(sp); }

  hover(box, curve, X, w);
}

function hover(box, curve, X, w) {
  const svg = box.querySelector("svg"), xh = svg.querySelector("#xh");
  const tip = el("div", "tip"); tip.hidden = true; box.append(tip);
  svg.addEventListener("pointermove", (e) => {
    const r = svg.getBoundingClientRect();
    const v = X.inv((e.clientX - r.left) * (w / r.width)) / 100;
    if (v < 0 || v > curve.at(-1).sections) { tip.hidden = true; xh.setAttribute("visibility", "hidden"); return; }
    let p = curve[0];
    for (const c of curve) { if (c.sections > v) break; p = c; }
    xh.setAttribute("x1", X(p.sections * 100)); xh.setAttribute("x2", X(p.sections * 100)); xh.setAttribute("visibility", "visible");
    tip.textContent = "";
    tip.append(el("div", "t", `${pct(p.sections)} apurado, às ${clock(p.time)}`));
    for (const key of ["lula", "bolso"]) {
      const row = el("div", "r"); const i = el("i"); i.style.borderTopColor = `var(${CANDIDATES[key].color})`;
      row.append(i, el("b", null, pct(key === "lula" ? p.raw : 1 - p.raw, 2)), el("span", null, CANDIDATES[key].name));
      tip.append(row);
    }
    tip.hidden = false;
    const left = e.clientX - r.left + 14;
    tip.style.left = (left + tip.offsetWidth > r.width ? e.clientX - r.left - tip.offsetWidth - 14 : left) + "px";
    tip.style.top = Math.max(0, e.clientY - r.top - 20) + "px";
  });
  svg.addEventListener("pointerleave", () => { tip.hidden = true; xh.setAttribute("visibility", "hidden"); });
}

// Tabela por UF: apuração, projeção com margem de erro e quem lidera a projeção
function renderStates(ufs) {
  const z = { 0.8: 1.2816, 0.9: 1.6449, 0.95: 1.96, 0.99: 2.5758 }[PROJ.confidence] ?? 1.96;
  const A = CANDIDATES.lula, B = CANDIDATES.bolso;
  const rows = ufs.map((u) => ({ uf: u.uf, counted: u.counted, raw: u.raw, share: u.share, ci: u.se * z, lead: u.share >= 0.5 ? 0 : 1 }));
  const k = ufSort.key;
  rows.sort((a, b) => (k === "uf" ? a.uf.localeCompare(b.uf) : (a[k] || 0) - (b[k] || 0)) * ufSort.dir);
  // Sim, a gente sabe: isto é a meia-largura do intervalo de confiança de 95%, não uma "margem
  // de erro" de pesquisa. O povo entende "margem de erro". Licença poética, e foda-se.
  const cols = [["uf", "Estado"], ["counted", "Seções apuradas"], ["raw", "Votos apurados"], ["share", "Projeção"], ["ci", "Margem de erro"], ["lead", "Lidera a projeção"]];
  const t = $("ufs"); t.textContent = "";
  const head = t.createTHead().insertRow();
  for (const [key, label] of cols) {
    const th = document.createElement("th");
    th.tabIndex = 0;
    th.textContent = label + (ufSort.key === key ? (ufSort.dir > 0 ? " ↑" : " ↓") : "");
    const sort = () => { ufSort = { key, dir: ufSort.key === key ? -ufSort.dir : 1 }; renderStates(ufs); };
    th.onclick = sort; th.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); sort(); } };
    head.append(th);
  }
  const body = t.createTBody();
  for (const r of rows) {
    const tr = body.insertRow();
    tr.insertCell().textContent = r.uf === "ZZ" ? "Exterior" : r.uf;
    const c = tr.insertCell(); const bar = el("span", "mini"); const bi = el("b"); bi.style.width = (r.counted * 100).toFixed(1) + "%"; bar.append(bi); c.append(bar, document.createTextNode(pct(r.counted, 0)));
    tr.insertCell().append(splitBar(r.raw, A, B));
    tr.insertCell().append(splitBar(r.share, A, B));
    tr.insertCell().textContent = Number.isFinite(r.ci) ? `± ${pp(r.ci, 2)} pp` : "–";
    const lc = tr.insertCell(); lc.className = "lead";
    const who = r.lead === 0 ? A : B, dot = el("span", "dot"); dot.style.background = `var(${who.color})`;
    lc.append(dot, document.createTextNode(Number.isFinite(r.share) ? who.name : "–"));
  }
}

// Barra dividida: A (vermelho) a partir da esquerda, B (azul) a partir da direita, marca em 50%
function splitBar(a, A, B) {
  if (!Number.isFinite(a)) return document.createTextNode("–");
  const wrap = el("span", "split");
  wrap.title = `${A.name} ${pct(a, 2)}, ${B.name} ${pct(1 - a, 2)}`;
  const track = el("span", "track");
  const ia = el("i"), ib = el("i");
  ia.style.width = (a * 100).toFixed(2) + "%"; ia.style.background = `var(${A.color})`;
  ib.style.width = ((1 - a) * 100).toFixed(2) + "%"; ib.style.background = `var(${B.color})`;
  track.append(ia, ib);
  wrap.append(el("span", "pa", pct(a)), track, el("span", "pb", pct(1 - a)));
  return wrap;
}

new ResizeObserver(() => view && render()).observe(document.querySelector(".wrap"));
