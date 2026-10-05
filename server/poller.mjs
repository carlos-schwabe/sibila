// Coletor da noite de apuração. A cada ciclo:
//  1. baixa a lista de seções de cada UF (EA16) e vê quais já chegaram;
//  2. baixa os resultados (EA20) de cada UF (padrão, 28 arquivos) ou das zonas que mudaram;
//  3. roda a projeção (projectFeed) e acrescenta um ponto ao histórico.
// A API do TSE só publica o estado atual, então a evolução da noite é este histórico.
//
// Saída em --out (padrão app/live/):
//   history.json  um ponto por ciclo em que a apuração andou
//   latest.json   o último ponto, com o detalhe por UF
//   state.json    votos por grupo já baixados, para retomar após reinício
//
// Uso (2º turno de 2026; o código do pleito sai no ele-c.json do TSE):
//   node server/poller.mjs --pleito <cd> --eleicao 6258 --dia 25/10/2026
// Teste com a reprodução de 2022 (node server/replay-server.mjs):
//   node server/poller.mjs --base http://localhost:8787/oficial --pleito 9999 --eleicao 9998 --dia 30/10/2022
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from "node:fs";
import { loadData, projectFeed, callStatus, DEFAULT_PROJ } from "../app/engine.js";
import { paths, candidateVotes, minutesAfter17, num } from "./tse-format.mjs";

const opt = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const CFG = {
  base: opt("base", "https://resultados.tse.jus.br/oficial"),
  ciclo: opt("ciclo", "ele2026"),
  pleito: Number(opt("pleito")),
  eleicao: Number(opt("eleicao", 6258)),
  dia: opt("dia", "25/10/2026"), // data da eleição (dd/mm/aaaa), para o relógio da apuração
  data: opt("data", new URL("../app/data/", import.meta.url).pathname), // base do 1º turno por seção
  out: opt("out", new URL("../app/live/", import.meta.url).pathname),
  nivel: opt("nivel", "uf"), // nível dos votos baixados: "uf" (28 arquivos por ciclo) ou "zona"
  interval: Number(opt("intervalo", 15)), // segundos entre ciclos
  ciclos: Number(opt("ciclos", Infinity)), // para depois de N ciclos (testes)
  rate: Number(opt("rps", 20)), // requisições por segundo (o TSE bloqueia acima de 100)
  candA: opt("candA", "13"), candB: opt("candB", "22"),
};
if (!CFG.pleito) { console.error("Informe --pleito (código do pleito do 2º turno no ele-c.json do TSE)."); process.exit(1); }

const buf = readFileSync(CFG.data + "sections.bin");
const D = loadData(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), JSON.parse(readFileSync(CFG.data + "meta.json", "utf8")));
const P = { ...DEFAULT_PROJ };
const URLS = paths(CFG);
mkdirSync(CFG.out, { recursive: true });

// Índices: (uf, município, zona, seção) -> seção; zona -> UF/município/número
const ufOfZone = (z) => D.ufNames[D.parent[2][D.parent[3][z]]].toLowerCase();
const secIndex = new Map();
for (let s = 0; s < D.N; s++) {
  const z = D.anc[3][s], m = D.parent[3][z];
  secIndex.set(`${ufOfZone(z)}|${D.muniCode[m]}|${D.zoneNr[z]}|${D.secNr[s]}`, s);
}
const LEVEL = CFG.nivel === "zona" ? 3 : 1;
const nGroups = D.nG[LEVEL];
const groupSecs = Array.from({ length: nGroups }, () => []);
for (let s = 0; s < D.N; s++) groupSecs[D.anc[LEVEL][s]].push(s);
const groupPath = LEVEL === 1
  ? (g) => URLS.uf(D.ufNames[g].toLowerCase())
  : (z) => URLS.zona(ufOfZone(z), D.muniCode[D.parent[3][z]], D.zoneNr[z]);

// Estado da coleta
const arrivedAt = new Float64Array(D.N).fill(NaN); // minuto de chegada de cada seção
const groupVotes = new Float64Array(2 * nGroups); // [A, B] apurados por grupo
const groupSt = new Int32Array(nGroups); // seções totalizadas segundo o arquivo do grupo
const groupSeen = new Int32Array(nGroups); // seções chegadas quando o grupo foi baixado
const statePath = CFG.out + "state.json", historyPath = CFG.out + "history.json";
const history = existsSync(historyPath) ? JSON.parse(readFileSync(historyPath, "utf8")) : [];
if (existsSync(statePath)) {
  const st = JSON.parse(readFileSync(statePath, "utf8"));
  if (st.nivel === CFG.nivel) { groupVotes.set(st.votes); groupSt.set(st.st); groupSeen.set(st.seen); }
  console.log(`Retomando: ${history.length} pontos no histórico.`);
}

// Requisições com limite de taxa e novas tentativas
let nextSlot = 0;
async function get(path) {
  for (let attempt = 1; ; attempt++) {
    const wait = Math.max(0, nextSlot - Date.now());
    nextSlot = Math.max(nextSlot, Date.now()) + 1000 / CFG.rate;
    if (wait) await new Promise((r) => setTimeout(r, wait));
    try {
      const r = await fetch(CFG.base + path, { signal: AbortSignal.timeout(15000) });
      if (r.status === 404) return null;
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } catch (e) {
      if (attempt >= 3) { console.warn(`  falhou ${path}: ${e.message}`); return undefined; }
      await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }
}
const pool = async (items, n, fn) => { let i = 0; await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) await fn(items[i++]); })); };

const writeJson = (path, data) => { writeFileSync(path + ".tmp", JSON.stringify(data)); renameSync(path + ".tmp", path); };

async function cycle() {
  const started = Date.now();
  // 1. Seções que chegaram, por UF
  let unknown = 0;
  await pool(D.ufNames.map((u) => u.toLowerCase()), 4, async (uf) => {
    const cs = await get(URLS.secoes(uf));
    for (const abr of cs?.abr ?? []) for (const mu of abr.mu ?? []) for (const zon of mu.zon ?? []) for (const sec of zon.sec ?? []) {
      if (!sec.ha) continue;
      const s = secIndex.get(`${uf}|${mu.cd}|${Number(zon.cd)}|${Number(sec.ns)}`);
      if (s === undefined) { unknown++; continue; }
      if (Number.isNaN(arrivedAt[s])) arrivedAt[s] = minutesAfter17(sec.da, sec.ha, CFG.dia);
    }
  });
  // 2. Grupos com seções novas, ou cujo arquivo ainda não refletia todas as que chegaram
  const arrivedIn = new Int32Array(nGroups);
  for (let s = 0; s < D.N; s++) if (!Number.isNaN(arrivedAt[s])) arrivedIn[D.anc[LEVEL][s]]++;
  const stale = [];
  for (let g = 0; g < nGroups; g++) if (arrivedIn[g] > 0 && (arrivedIn[g] !== groupSeen[g] || groupSt[g] < arrivedIn[g])) stale.push(g);
  await pool(stale, 8, async (g) => {
    const f = await get(groupPath(g));
    if (!f) return;
    const v = candidateVotes(f);
    groupVotes[2 * g] = v[CFG.candA] ?? 0; groupVotes[2 * g + 1] = v[CFG.candB] ?? 0;
    groupSt[g] = num(f.s?.st); groupSeen[g] = arrivedIn[g];
  });
  // 3. Seções apuradas: em cada grupo, as primeiras a chegar, até o total que o arquivo informa
  const counted = new Uint8Array(D.N);
  let last = 0, mismatch = 0;
  for (let g = 0; g < nGroups; g++) {
    if (!arrivedIn[g]) continue;
    const arr = groupSecs[g].filter((s) => !Number.isNaN(arrivedAt[s])).sort((a, b) => arrivedAt[a] - arrivedAt[b]);
    if (groupSt[g] > arr.length) mismatch++;
    for (const s of arr.slice(0, groupSt[g])) { counted[s] = 1; last = Math.max(last, arrivedAt[s]); }
  }
  const snap = projectFeed(D, P, counted, groupVotes, LEVEL, last);
  const st = callStatus(snap);
  const point = {
    t: +last.toFixed(2), done: snap.done, sections: +snap.sections.toFixed(5),
    a: snap.lulaVotes, b: snap.bolsoVotes, raw: +snap.raw.toFixed(6),
    share: +snap.share.toFixed(6), lo: +snap.lo.toFixed(6), hi: +snap.hi.toFixed(6),
    pWin: snap.pWin, aptosLeft: snap.aptosLeft, stage: st.stage, winner: st.winner,
  };
  if (snap.done > 0 && (history.length === 0 || history.at(-1).done !== snap.done)) history.push(point);
  writeJson(historyPath, history);
  writeJson(CFG.out + "latest.json", {
    updated: new Date().toISOString(), nSections: D.N, candidates: [CFG.candA, CFG.candB], point,
    ufs: snap.ufs.map((u, i) => ({ uf: D.ufNames[i], counted: u.sections, raw: u.raw, share: u.share, se: u.se })),
  });
  writeJson(statePath, { nivel: CFG.nivel, votes: [...groupVotes], st: [...groupSt], seen: [...groupSeen] });
  console.log(`${new Date().toLocaleTimeString("pt-BR")}  ${(snap.sections * 100).toFixed(1)}% apurado  A ${(snap.raw * 100).toFixed(2)}% → ${(snap.share * 100).toFixed(2)}% ± ${((snap.hi - snap.share) * 100).toFixed(2)}  ${st.stage}  (${stale.length} arquivos de ${CFG.nivel} em ${((Date.now() - started) / 1000).toFixed(1)}s${unknown ? `, ${unknown} seções fora da base` : ""}${mismatch ? `, ${mismatch} grupos à frente da lista de seções` : ""})`);
  return snap;
}

for (let n = 1; n <= CFG.ciclos; n++) {
  const t = Date.now();
  const snap = await cycle().catch((e) => { console.error("Erro no ciclo:", e); return null; });
  if (snap && snap.done === D.N) { console.log("Apuração completa."); break; }
  await new Promise((r) => setTimeout(r, Math.max(0, CFG.interval * 1000 - (Date.now() - t))));
}
