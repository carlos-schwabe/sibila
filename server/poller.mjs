// Coletor da noite de apuração. A cada ciclo:
//  1. baixa até `zonas` arquivos de zona (EA20), das zonas com mais seções chegadas que o
//     último arquivo baixado da zona ainda não incluía;
//  2. baixa os resultados de cada UF (EA20);
//  3. baixa a lista de seções de cada UF (EA16) e vê quais já chegaram. Vem por último para
//     conter todas as seções que os arquivos de resultado já somaram;
//  4. roda a projeção (projectFeed) e publica o resultado.
// Com zonas = 0 o coletor usa só os totais por UF. A API do TSE só publica o estado atual,
// então a evolução da noite é o histórico gravado aqui.
//
// Arquivos em `out`:
//   latest.json   o último ponto, com o detalhe por UF (lido pela página)
//   history.json  a curva da noite em colunas, com no máximo HISTORY_MAX pontos (lido pela página)
//   state.json    histórico completo e totais de zona já baixados, para retomar após reinício
//
// Uso direto (server/main.mjs roda o coletor junto com o site):
//   node server/poller.mjs --pleito <cd> --eleicao <cd> --dia 25/10/2026
// Teste com a reprodução de 2022 (node server/replay-server.mjs):
//   node server/poller.mjs --base http://localhost:8787/oficial --pleito 9999 --eleicao 9998 --dia 30/10/2022
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { loadData, projectFeed, callStatus, DEFAULT_PROJ } from "../app/engine.js";
import { paths, candidateVotes, minutesAfter17, num } from "./tse-format.mjs";
import { createClient } from "./tse-client.mjs";

export const HISTORY_MAX = 600;

export const DEFAULTS = {
  base: "https://resultados.tse.jus.br/oficial",
  ciclo: "ele2026",
  dia: "25/10/2026", // data da eleição (dd/mm/aaaa), para o relógio da apuração
  data: new URL("../app/data/", import.meta.url).pathname, // base do 1º turno por seção
  out: new URL("../app/live/", import.meta.url).pathname,
  zonas: 100, // arquivos de zona por ciclo (0: só UF)
  interval: 10, // segundos entre o início de dois ciclos
  ciclos: Infinity, // para depois de N ciclos (testes)
  rate: 30, // requisições por segundo, no máximo HARD_MAX (o TSE bloqueia acima de 100)
  penalty: 60, // segundos de espera quando o TSE sinaliza bloqueio
  candA: "13", candB: "22",
};

// Curva publicada: colunas, com no máximo `max` pontos (o último sempre incluído)
export function compactHistory(points, max = HISTORY_MAX) {
  let keep = points;
  if (points.length > max) {
    const bucket = new Map();
    for (const p of points) bucket.set(Math.min(max - 1, Math.floor(frac(p) * max)), p);
    keep = [...bucket.values()];
    if (keep.at(-1) !== points.at(-1)) keep.push(points.at(-1));
  }
  return { v: 1, sections: keep.map((p) => +frac(p).toFixed(5)), t: keep.map((p) => p.t), raw: keep.map((p) => p.raw), done: keep.map((p) => p.done) };
}
// fração de seções apuradas segundo o TSE (ou do modelo, se o TSE não informou)
const frac = (p) => (p.tse?.ts ? p.tse.st / p.tse.ts : p.sections);

// Roda o coletor. `onUpdate({ latest, history })` é chamado a cada ciclo com os mesmos
// objetos gravados em latest.json e history.json.
export async function runPoller(options, onUpdate = () => {}) {
  const CFG = { ...DEFAULTS, ...options };
  if (!CFG.pleito || !CFG.eleicao) throw new Error("Informe o código do pleito e da eleição do TSE.");
  const buf = readFileSync(CFG.data + "sections.bin");
  const D = loadData(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), JSON.parse(readFileSync(CFG.data + "meta.json", "utf8")));
  const P = { ...DEFAULT_PROJ };
  const URLS = paths(CFG);
  const nu = D.nG[1], nz = D.nG[3];
  const ufs = D.ufNames.map((u) => u.toLowerCase());
  mkdirSync(CFG.out, { recursive: true });

  // Índices: (uf, município, zona, seção) -> seção; seções de cada zona e de cada UF
  const ufOfZone = (z) => ufs[D.parent[2][D.parent[3][z]]];
  const secIndex = new Map();
  for (let s = 0; s < D.N; s++) {
    const z = D.anc[3][s], m = D.parent[3][z];
    secIndex.set(`${ufOfZone(z)}|${D.muniCode[m]}|${D.zoneNr[z]}|${D.secNr[s]}`, s);
  }
  const zoneSecs = Array.from({ length: nz }, () => []), ufSecs = Array.from({ length: nu }, () => []);
  for (let s = 0; s < D.N; s++) { zoneSecs[D.anc[3][s]].push(s); ufSecs[D.anc[1][s]].push(s); }

  // Estado da coleta
  const arrivedAt = new Float64Array(D.N).fill(NaN); // minuto de chegada de cada seção
  const ufVotes = new Float64Array(2 * nu), ufSt = new Int32Array(nu); // totais por UF e seções totalizadas
  const ufTs = new Int32Array(nu); // total de seções da UF segundo o TSE
  const zoneVotes = new Float64Array(2 * nz), zoneSt = new Int32Array(nz); // último arquivo baixado de cada zona
  const statePath = CFG.out + "state.json";
  let history = [];
  if (existsSync(statePath)) {
    const st = JSON.parse(readFileSync(statePath, "utf8"));
    if (st.pleito === CFG.pleito && st.zoneVotes?.length === 2 * nz) {
      zoneVotes.set(st.zoneVotes); zoneSt.set(st.zoneSt); history = st.history ?? [];
      console.log(`Retomando: ${history.length} pontos no histórico.`);
    }
  }

  // `client` permite compartilhar o semáforo (e a medição de saúde) com quem chamou
  const client = CFG.client ?? createClient({ base: CFG.base, rps: CFG.rate, penalty: CFG.penalty });
  const get = client.json;
  const pool = async (items, n, fn) => { let i = 0; await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) await fn(items[i++]); })); };
  const writeJson = (path, data) => { writeFileSync(path + ".tmp", JSON.stringify(data)); renameSync(path + ".tmp", path); };
  const byArrival = (secs) => secs.filter((s) => !Number.isNaN(arrivedAt[s])).sort((a, b) => arrivedAt[a] - arrivedAt[b]);

  async function cycle() {
    const started = Date.now();
    // Ordem do ciclo: primeiro os resultados (zonas, depois UFs), por último as listas de seções.
    // Uma seção aparece na lista antes de ser totalizada, então a lista mais nova sempre contém
    // todas as seções que os arquivos de resultado, mais velhos, já somaram.
    // 1. Zonas com mais seções chegadas (até o ciclo anterior) que o último arquivo baixado não incluía
    const arrivedIn = new Int32Array(nz);
    for (let s = 0; s < D.N; s++) if (!Number.isNaN(arrivedAt[s])) arrivedIn[D.anc[3][s]]++;
    const gap = (z) => arrivedIn[z] - zoneSt[z];
    const pick = [];
    for (let z = 0; z < nz; z++) if (gap(z) > 0) pick.push(z);
    pick.sort((a, b) => gap(b) - gap(a)).splice(CFG.zonas);
    await pool(pick, 8, async (z) => {
      const f = await get(URLS.zona(ufOfZone(z), D.muniCode[D.parent[3][z]], D.zoneNr[z]));
      if (!f) return;
      const v = candidateVotes(f);
      zoneVotes[2 * z] = v[CFG.candA] ?? 0; zoneVotes[2 * z + 1] = v[CFG.candB] ?? 0;
      zoneSt[z] = num(f.s?.st);
    });
    // 2. Totais por UF
    await pool([...ufs.keys()], 4, async (u) => {
      const f = await get(URLS.uf(ufs[u]));
      if (!f) return;
      const v = candidateVotes(f);
      ufVotes[2 * u] = v[CFG.candA] ?? 0; ufVotes[2 * u + 1] = v[CFG.candB] ?? 0;
      ufSt[u] = num(f.s?.st); ufTs[u] = num(f.s?.ts);
    });
    // 3. Seções que chegaram, por UF
    let unknown = 0;
    await pool(ufs, 4, async (uf) => {
      const cs = await get(URLS.secoes(uf));
      for (const abr of cs?.abr ?? []) for (const mu of abr.mu ?? []) for (const zon of mu.zon ?? []) for (const sec of zon.sec ?? []) {
        if (!sec.ha) continue;
        const s = secIndex.get(`${uf}|${mu.cd}|${Number(zon.cd)}|${Number(sec.ns)}`);
        if (s === undefined) { unknown++; continue; }
        if (Number.isNaN(arrivedAt[s])) arrivedAt[s] = minutesAfter17(sec.da, sec.ha, CFG.dia);
      }
    });
    // 4. Seções apuradas e cobertas: as primeiras a chegar, até o total que cada arquivo informa
    const counted = new Uint8Array(D.N), covered = new Uint8Array(D.N);
    let last = 0, mismatch = 0;
    for (let u = 0; u < nu; u++) {
      const arr = byArrival(ufSecs[u]);
      if (ufSt[u] > arr.length) mismatch++;
      for (const s of arr.slice(0, ufSt[u])) { counted[s] = 1; last = Math.max(last, arrivedAt[s]); }
    }
    let zonesWithData = 0;
    for (let z = 0; z < nz; z++) {
      if (!zoneSt[z]) continue;
      zonesWithData++;
      for (const s of byArrival(zoneSecs[z]).slice(0, zoneSt[z])) covered[s] = 1;
    }
    if (!counted.some(Boolean)) { console.log("Nenhuma seção da base apurada ainda; nada a publicar."); return null; }
    const snap = projectFeed(D, P, counted, { ufVotes, zoneVotes: CFG.zonas > 0 ? zoneVotes : null, covered }, last);
    const st = callStatus(snap);
    const point = {
      t: +last.toFixed(2), done: snap.done, sections: +snap.sections.toFixed(5),
      a: snap.lulaVotes, b: snap.bolsoVotes, raw: +snap.raw.toFixed(6),
      share: +snap.share.toFixed(6), lo: +snap.lo.toFixed(6), hi: +snap.hi.toFixed(6),
      pWin: snap.pWin, aptosLeft: snap.aptosLeft, stage: st.stage, winner: st.winner,
      // seções totalizadas segundo o próprio TSE (inclui seções fora da base do modelo)
      tse: { st: ufSt.reduce((a, x) => a + x, 0), ts: ufTs.reduce((a, x) => a + x, 0) },
    };
    if (snap.done > 0 && (history.length === 0 || history.at(-1).done !== snap.done)) history.push(point);
    const latest = {
      updated: new Date().toISOString(), nSections: D.N, candidates: [CFG.candA, CFG.candB], point,
      // seções apuradas por UF segundo o próprio TSE; sem o arquivo da UF, a contagem do modelo
      ufs: snap.ufs.map((u, i) => ({ uf: D.ufNames[i], counted: ufTs[i] ? ufSt[i] / ufTs[i] : u.sections, raw: u.raw, share: u.share, se: u.se })),
    };
    const curve = compactHistory(history);
    writeJson(CFG.out + "latest.json", latest);
    writeJson(CFG.out + "history.json", curve);
    writeJson(statePath, { pleito: CFG.pleito, zoneVotes: [...zoneVotes], zoneSt: [...zoneSt], history });
    onUpdate({ latest, history: curve });
    console.log(`${new Date().toLocaleTimeString("pt-BR")}  ${(snap.sections * 100).toFixed(1)}% apurado  A ${(snap.raw * 100).toFixed(2)}% → ${(snap.share * 100).toFixed(2)}% ± ${((snap.hi - snap.share) * 100).toFixed(2)}  ${st.stage}  (${pick.length} zonas baixadas, ${zonesWithData} com dados, ${((Date.now() - started) / 1000).toFixed(1)}s${unknown ? `, ${unknown} seções fora da base` : ""}${mismatch ? `, ${mismatch} UFs à frente da lista de seções` : ""})`);
    return snap;
  }

  // Antes da apuração começar, só o arquivo do Brasil, a cada 30 s, até haver seção
  // totalizada. Ciclos completos agora gerariam dezenas de 404 por ciclo, e o TSE bloqueia
  // IPs com muitos 404.
  for (let waited = false; history.length === 0; waited = true) {
    const br = await get(URLS.brasil());
    if (br && num(br.s?.st) > 0) break;
    if (!waited) console.log("Apuração ainda não começou; consultando o arquivo do Brasil a cada 30 s.");
    await new Promise((r) => setTimeout(r, 30000));
  }

  for (let n = 1; n <= CFG.ciclos; n++) {
    const t = Date.now();
    const snap = await cycle().catch((e) => { console.error("Erro no ciclo:", e); return null; });
    if (snap && snap.done === D.N) { console.log("Apuração completa."); break; }
    await new Promise((r) => setTimeout(r, Math.max(0, CFG.interval * 1000 - (Date.now() - t))));
  }
}

// Linha de comando
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const opt = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
  await runPoller({
    base: opt("base", DEFAULTS.base), ciclo: opt("ciclo", DEFAULTS.ciclo),
    pleito: Number(opt("pleito")), eleicao: Number(opt("eleicao")), dia: opt("dia", DEFAULTS.dia),
    data: opt("data", DEFAULTS.data), out: opt("out", DEFAULTS.out),
    zonas: Number(opt("zonas", DEFAULTS.zonas)), interval: Number(opt("intervalo", DEFAULTS.interval)),
    ciclos: Number(opt("ciclos", DEFAULTS.ciclos)), rate: Number(opt("rps", DEFAULTS.rate)),
    penalty: Number(opt("penalidade", DEFAULTS.penalty)), candA: opt("candA", DEFAULTS.candA), candB: opt("candB", DEFAULTS.candB),
  }).catch((e) => { console.error(e.message); process.exit(1); });
}
