// Monta a base do 1º turno para o motor a partir do que scripts/fetch_baseline.mjs baixou
// da API do TSE: gera sections.bin e meta.json no mesmo layout de scripts/prepare_data.py,
// com as colunas do 2º turno zeradas (elas só existem no backtest de 2022).
// Uso: node scripts/build_baseline.mjs [--in data/api-p3220/] [--out app/data-2026/]
// Depois: node server/poller.mjs ... --data app/data-2026/
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";

const opt = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const IN = opt("in", new URL("../data/api-p3220/", import.meta.url).pathname);
const OUT = opt("out", new URL("../app/data-2026/", import.meta.url).pathname);
const CAND_A = opt("candA", "13");

// Nomes dos municípios
const names = new Map();
for (const abr of JSON.parse(readFileSync(IN + "municipios.json", "utf8")).abr ?? []) {
  for (const mu of abr.mu ?? []) names.set(`${abr.cd}|${mu.cd}`, mu.nm);
}

// Última linha de cada seção (as tentativas que falharam ficam antes)
const rows = [];
for (const f of readdirSync(IN).filter((f) => f.endsWith(".ndjson")).sort()) {
  const uf = f.slice(0, 2);
  const last = new Map();
  for (const line of readFileSync(IN + f, "utf8").split("\n")) if (line) { const r = JSON.parse(line); last.set(`${r.mun}|${r.zona}|${r.secao}`, r); }
  for (const r of last.values()) if (r.votos) rows.push({ uf, ...r });
}
const key = (r) => [r.uf, r.mun, r.zona.padStart(4, "0"), String(r.local).padStart(5, "0"), r.secao.padStart(4, "0")].join("|");
rows.sort((a, b) => (key(a) < key(b) ? -1 : 1));

const ufs = [], munis = [], zoneMuni = [], zoneNr = [], localZone = [];
const ufIdx = new Map(), muniIdx = new Map(), zoneIdx = new Map(), localIdx = new Map();
const N = rows.length;
const secLocal = new Uint32Array(N), arrival = new Uint32Array(N);
const t1 = new Uint16Array(N), t1a = new Uint16Array(N), lula = new Uint16Array(N), bolso = new Uint16Array(N), aptos = new Uint16Array(N), secNr = new Uint16Array(N);
const clip = (v) => Math.min(65535, v);
rows.forEach((r, s) => {
  const U = r.uf.toUpperCase();
  if (!ufIdx.has(U)) { ufIdx.set(U, ufs.length); ufs.push(U); }
  const mk = `${r.uf}|${r.mun}`;
  if (!muniIdx.has(mk)) { muniIdx.set(mk, munis.length); munis.push([names.get(mk) ?? r.mun, ufIdx.get(U), r.mun]); }
  const zk = `${mk}|${r.zona}`;
  if (!zoneIdx.has(zk)) { zoneIdx.set(zk, zoneMuni.length); zoneMuni.push(muniIdx.get(mk)); zoneNr.push(Number(r.zona)); }
  const lk = `${zk}|${r.local}`;
  if (!localIdx.has(lk)) { localIdx.set(lk, localZone.length); localZone.push(zoneIdx.get(zk)); }
  secLocal[s] = localIdx.get(lk);
  const total = Object.values(r.votos).reduce((a, x) => a + x, 0) + r.branco + r.nulo; // votos do 1º turno para presidente
  t1[s] = clip(total); t1a[s] = clip(r.votos[CAND_A] ?? 0);
  aptos[s] = clip(r.aptos); secNr[s] = Number(r.secao);
});

mkdirSync(OUT, { recursive: true });
const parts = [secLocal, arrival, t1, t1a, lula, bolso, aptos, secNr].map((a) => Buffer.from(a.buffer, a.byteOffset, a.byteLength));
writeFileSync(OUT + "sections.bin", Buffer.concat(parts));
writeFileSync(OUT + "meta.json", JSON.stringify({ nSections: N, ufs, munis, zoneMuni, zoneNr, localZone, final: { lula: 0, bolso: 0 } }));
const votes = rows.reduce((a, r) => a + (r.votos[CAND_A] ?? 0), 0), all = rows.reduce((a, r) => a + Object.values(r.votos).reduce((x, y) => x + y, 0), 0);
console.log(`${N} seções, ${localZone.length} locais, ${zoneMuni.length} zonas, ${munis.length} municípios, ${ufs.length} UFs -> ${OUT}`);
console.log(`Candidato ${CAND_A} no 1º turno: ${votes} votos (${((100 * votes) / all).toFixed(2)}% dos nominais)`);
