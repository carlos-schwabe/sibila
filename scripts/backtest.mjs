// Reproduz a apuração real do 2º turno de 2022 e imprime o resumo do backtest usado no README.
// Uso: node scripts/backtest.mjs ['{"estimator":"swing","biasCorr":0.3}']
// Para o que a divulgação ao vivo publica (votos por UF e/ou zona), ver scripts/backtest_feed.mjs.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { loadData, realOrder, project, callStatus, DEFAULT_PROJ } from "../app/engine.js";

const ARGS = JSON.parse(process.argv[2] ?? "{}");
const root = ARGS.data ? pathToFileURL(resolve(ARGS.data) + "/") : new URL("../app/data/", import.meta.url);
const buf = readFileSync(new URL("sections.bin", root));
const meta = JSON.parse(readFileSync(new URL("meta.json", root), "utf8"));
const D = loadData(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), meta);
const sim = realOrder(D);
const { data: _data, ...overrides } = ARGS;
const P = { ...DEFAULT_PROJ, snapshots: 1000, ...overrides };
const winner = D.final >= 0.5 ? "lula" : "bolso"; // candidato A (13) ou B
const snaps = project(D, sim, P);

const pct = (v) => (v * 100).toFixed(2) + "%";
const clock = (m) => { const t = 17 * 60 + m; return `${String(Math.floor(t / 60) % 24).padStart(2, "0")}:${String(Math.floor(t % 60)).padStart(2, "0")}`; };
const final = D.final;
const inside = snaps.filter((s) => s.lo <= final && final <= s.hi).length;
console.log(`estimator=${P.estimator} biasCorr=${P.biasCorr} confidence=${P.confidence} final=${pct(final)}`);
console.log(`CI covers the final result in ${((100 * inside) / snaps.length).toFixed(0)}% of ${snaps.length} snapshots\n`);
console.log("| Counted | Clock | Raw count | Projection | Error |");
console.log("|---|---|---|---|---|");
for (const f of [0.05, 0.1, 0.25, 0.5, 0.75, 0.9]) {
  const s = snaps.find((x) => x.sections >= f);
  console.log(`| ${(f * 100).toFixed(0)}% | ${clock(s.time)} | ${pct(s.raw)} | ${pct(s.share)} ± ${((s.hi - s.share) * 100).toFixed(2)} | ${((s.share - final) * 100).toFixed(2)} pp |`);
}
const first = (pred) => snaps.find(pred);
const fmt = (s) => (s ? `${pct(s.sections)} counted, ${clock(s.time)}` : "never");
const lastBehind = snaps.findLastIndex((s) => (winner === "lula" ? s.raw < 0.5 : s.raw > 0.5));
const lead = snaps[lastBehind + 1];
const likely = first((s) => callStatus(s).stage !== "open");
const wrong = snaps.filter((s) => callStatus(s).stage !== "open" && callStatus(s).winner !== winner).length;
const decided = first((s) => callStatus(s).stage === "decided");
console.log(`\nRaw count favors the winner for good: ${fmt(lead)}`);
console.log(`First 99.9% call: ${fmt(likely)}${likely ? ` (${callStatus(likely).winner})` : ""}; snapshots calling the wrong winner: ${wrong}`);
console.log(`Mathematically decided: ${fmt(decided)}`);
