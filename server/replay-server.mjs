// Servidor que reproduz a apuração do 2º turno de 2022 no formato da divulgação de 2026
// (EA16 por UF; EA20 do Brasil, por UF e por zona), num relógio acelerado. Serve para testar o
// coletor de ponta a ponta antes da eleição.
//
// Uso: node server/replay-server.mjs [--port 8787] [--speed 20] [--start 0]
//   --speed  quantos minutos da apuração passam por minuto real
//   --start  minuto da apuração (após as 17:00) em que a reprodução começa
import http from "node:http";
import { readFileSync } from "node:fs";
import { loadData, realOrder } from "../app/engine.js";
import { paths } from "./tse-format.mjs";

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? Number(process.argv[i + 1]) : d; };
const PORT = arg("port", 8787), SPEED = arg("speed", 20), START = arg("start", 0);
export const REPLAY = { ciclo: "ele2026", pleito: 9999, eleicao: 9998 };
const DAY = "30/10/2022", NEXT_DAY = "31/10/2022";

const root = new URL("../app/data/", import.meta.url);
const buf = readFileSync(new URL("sections.bin", root));
const D = loadData(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), JSON.parse(readFileSync(new URL("meta.json", root), "utf8")));
const { order } = realOrder(D);

// Seções por zona e zonas por UF, na ordem do arquivo
const zoneSecs = Array.from({ length: D.nG[3] }, () => []);
for (let s = 0; s < D.N; s++) zoneSecs[D.anc[3][s]].push(s);
const ufZones = Array.from({ length: D.nG[1] }, () => []);
for (let z = 0; z < D.nG[3]; z++) ufZones[D.anc[1][zoneSecs[z][0]]].push(z);
const ufIndex = Object.fromEntries(D.ufNames.map((u, i) => [u.toLowerCase(), i]));
const zoneKey = new Map();
for (let z = 0; z < D.nG[3]; z++) {
  const m = D.parent[3][z];
  zoneKey.set(`${D.ufNames[D.parent[2][m]].toLowerCase()}|${D.muniCode[m]}|${D.zoneNr[z]}`, z);
}

const t0 = Date.now();
const nowSec = () => (START + ((Date.now() - t0) / 60000) * SPEED) * 60; // segundos após as 17:00
const clock = (sec) => {
  const t = 17 * 3600 + Math.floor(sec);
  const day = t >= 24 * 3600 ? NEXT_DAY : DAY, r = t % (24 * 3600);
  return [day, [r / 3600, (r % 3600) / 60, r % 60].map((v) => String(Math.floor(v)).padStart(2, "0")).join(":")];
};
const pct = (a, b) => (b > 0 ? ((100 * a) / b).toFixed(2) : "0.00").replace(".", ",");

function ea20(tpabr, cdabr, secs, now) {
  let st = 0, l = 0, b = 0, te = 0, last = 0;
  for (const s of secs) {
    te += D.aptos[s];
    if (D.arrival[s] > now) continue;
    st++; l += D.lula[s]; b += D.bolso[s]; last = Math.max(last, D.arrival[s]);
  }
  const [dg, hg] = clock(now), [dt, ht] = clock(last);
  const vv = l + b;
  const cand = (n, nmu, v) => ({ n, nmu, vap: String(v), pvap: pct(v, vv) });
  return {
    ele: String(REPLAY.eleicao), t: "2", f: "o", tpabr, cdabr, dg, hg, dt, ht,
    and: st === 0 ? "n" : st === secs.length ? "f" : "p", tf: st === secs.length ? "s" : "n",
    s: { ts: String(secs.length), st: String(st), pst: pct(st, secs.length) },
    e: { te: String(te) },
    v: { vv: String(vv) },
    carg: [{ cd: "1", agr: [{ par: [{ cand: [cand("13", "LULA", l), cand("22", "JAIR BOLSONARO", b)] }] }] }],
  };
}

function ea16(u, now) {
  const [dg, hg] = clock(now);
  const mus = new Map();
  for (const z of ufZones[u]) {
    const m = D.parent[3][z];
    if (!mus.has(m)) mus.set(m, { cd: D.muniCode[m], zon: [] });
    mus.get(m).zon.push({
      cd: String(D.zoneNr[z]).padStart(4, "0"),
      sec: zoneSecs[z].map((s) => {
        const e = { ns: String(D.secNr[s]).padStart(4, "0") };
        if (D.arrival[s] <= now) [e.da, e.ha] = clock(D.arrival[s]);
        return e;
      }),
    });
  }
  return { dg, hg, f: "o", cdp: String(REPLAY.pleito), abr: [{ cd: D.ufNames[u].toLowerCase(), mu: [...mus.values()] }] };
}

const P = paths(REPLAY);
const routes = [
  [/^\/oficial\/ele2026\/arquivo-urna\/\d+\/config\/([a-z]{2})\/[a-z]{2}-p\d{6}-cs\.json$/, ([, uf], now) => uf in ufIndex && ea16(ufIndex[uf], now)],
  [/^\/oficial\/ele2026\/\d+\/dados\/([a-z]{2})\/[a-z]{2}(\d{5})-z(\d{4})-c0001-e\d{6}-u\.json$/, ([, uf, mun, zona], now) => {
    const z = zoneKey.get(`${uf}|${mun}|${Number(zona)}`);
    return z !== undefined && ea20("zona", zona, zoneSecs[z], now);
  }],
  [/^\/oficial\/ele2026\/\d+\/dados\/br\/br-c0001-e\d{6}-u\.json$/, (_, now) => ea20("br", "br", order, now)],
  [/^\/oficial\/ele2026\/\d+\/dados\/([a-z]{2})\/[a-z]{2}-c0001-e\d{6}-u\.json$/, ([, uf], now) => uf in ufIndex && ea20("uf", uf, ufZones[ufIndex[uf]].flatMap((z) => zoneSecs[z]), now)],
];

http.createServer((req, res) => {
  const now = nowSec();
  for (const [re, fn] of routes) {
    const m = req.url.match(re);
    const body = m && fn(m, now);
    if (body) { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(body)); return; }
  }
  res.writeHead(404); res.end();
}).listen(PORT, () => {
  console.log(`Reprodução de 2022 em http://localhost:${PORT}/oficial  (ciclo ${REPLAY.ciclo}, pleito ${REPLAY.pleito}, eleição ${REPLAY.eleicao})`);
  console.log(`Relógio: ${SPEED}x, começando ${START} min após as 17:00. Exemplo: ${P.brasil()}`);
});
