// Reproduz a apuração real do 2º turno de 2022 e imprime o resumo do backtest usado no README.
// Uso: node scripts/backtest.mjs ['{"estimator":"swing","biasCorr":0.3}']
// Com '{"feed":1}' (UF), 2 (município) ou 3 (zona) usa só o que a divulgação ao vivo publica:
// as seções que chegaram e os votos somados naquele nível (projectFeed).
import { readFileSync } from "node:fs";
import { loadData, realOrder, project, projectFeed, callStatus, DEFAULT_PROJ } from "../app/engine.js";

const root = new URL("../app/data/", import.meta.url);
const buf = readFileSync(new URL("sections.bin", root));
const meta = JSON.parse(readFileSync(new URL("meta.json", root), "utf8"));
const D = loadData(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), meta);
const sim = realOrder(D);
const P = { ...DEFAULT_PROJ, snapshots: 1000, ...JSON.parse(process.argv[2] ?? "{}") };
const snaps = P.feed ? feed(P, P.feed) : project(D, sim, P);

// Reproduz a divulgação agregada: a cada instante, as seções que chegaram e os votos somados
// por grupo do nível `level`
function feed(P, level) {
  const counted = new Uint8Array(D.N), votes = new Float64Array(2 * D.nG[level]);
  const out = [];
  let next = 0;
  for (let k = 1; k <= P.snapshots; k++) {
    const target = Math.round((D.N * k) / P.snapshots);
    for (; next < target; next++) {
      const s = sim.order[next], g = D.anc[level][s];
      counted[s] = 1; votes[2 * g] += D.lula[s]; votes[2 * g + 1] += D.bolso[s];
    }
    out.push(projectFeed(D, P, counted, votes, level, sim.time[sim.order[next - 1]]));
  }
  return out;
}

const pct = (v) => (v * 100).toFixed(2) + "%";
const clock = (m) => { const t = 17 * 60 + m; return `${String(Math.floor(t / 60) % 24).padStart(2, "0")}:${String(Math.floor(t % 60)).padStart(2, "0")}`; };
const final = D.final;
const inside = snaps.filter((s) => s.lo <= final && final <= s.hi).length;
console.log(`feed=${["Brasil", "UF", "município", "zona"][P.feed] ?? "seção"} estimator=${P.estimator} biasCorr=${P.biasCorr} confidence=${P.confidence} final=${pct(final)}`);
console.log(`CI covers the final result in ${((100 * inside) / snaps.length).toFixed(0)}% of ${snaps.length} snapshots\n`);
console.log("| Counted | Clock | Raw count | Projection | Error |");
console.log("|---|---|---|---|---|");
for (const f of [0.05, 0.1, 0.25, 0.5, 0.75, 0.9]) {
  const s = snaps.find((x) => x.sections >= f);
  console.log(`| ${(f * 100).toFixed(0)}% | ${clock(s.time)} | ${pct(s.raw)} | ${pct(s.share)} ± ${((s.hi - s.share) * 100).toFixed(2)} | ${((s.share - final) * 100).toFixed(2)} pp |`);
}
const first = (pred) => snaps.find(pred);
const fmt = (s) => (s ? `${pct(s.sections)} counted, ${clock(s.time)}` : "never");
const lastBehind = snaps.findLastIndex((s) => s.raw < 0.5);
const lead = snaps[lastBehind + 1];
const likely = first((s) => callStatus(s).stage !== "open");
const wrong = snaps.filter((s) => callStatus(s).stage !== "open" && callStatus(s).winner !== "lula").length;
const decided = first((s) => callStatus(s).stage === "decided");
console.log(`\nRaw count turns to Lula for good: ${fmt(lead)}`);
console.log(`First 99.9% call: ${fmt(likely)}${likely ? ` (${callStatus(likely).winner})` : ""}; snapshots calling the wrong winner: ${wrong}`);
console.log(`Mathematically decided: ${fmt(decided)}`);
