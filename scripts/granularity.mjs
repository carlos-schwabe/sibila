// Mede quanto a projeção piora com menos granularidade, na reprodução de 2022.
//  - dados ao vivo: nível mais fino observado durante a apuração (maxLevel)
//  - base do 1º turno: nível em que o % de Lula no 1º turno é conhecido; cada seção
//    recebe a média da sua área
// As estimativas pontuais são emuladas com exatidão (só usam totais por área). Os
// intervalos continuam usando a variância entre seções, que um dado mais agregado não
// observa; a cobertura nas linhas agregadas é, portanto, otimista.
import { readFileSync } from "node:fs";
import { loadData, realOrder, project, callStatus, DEFAULT_PROJ, LEVELS } from "../app/engine.js";

const root = new URL("../app/data/", import.meta.url);
const buf = readFileSync(new URL("sections.bin", root));
const meta = JSON.parse(readFileSync(new URL("meta.json", root), "utf8"));
const D = loadData(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), meta);
const order = realOrder(D);
const t1lulaSection = D.t1lula;

// Base do 1º turno no nível `lv`: cada seção recebe o % de Lula da sua área
function baselineAt(lv) {
  if (lv === 5) return t1lulaSection;
  const lula = new Float64Array(D.nG[lv]), tot = new Float64Array(D.nG[lv]);
  for (let s = 0; s < D.N; s++) { lula[D.anc[lv][s]] += t1lulaSection[s]; tot[D.anc[lv][s]] += D.t1[s]; }
  const out = new Float64Array(D.N);
  for (let s = 0; s < D.N; s++) { const g = D.anc[lv][s]; out[s] = tot[g] > 0 ? (D.t1[s] * lula[g]) / tot[g] : 0; }
  return out;
}

const NAME = { 5: "Seção", 4: "Local", 3: "Zona", 2: "Município", 1: "UF", 0: "Brasil" };
const clock = (m) => { const t = 17 * 60 + m; return `${String(Math.floor(t / 60) % 24).padStart(2, "0")}:${String(Math.floor(t % 60)).padStart(2, "0")}`; };
const scenarios = [
  [4, 5], [3, 5], [2, 5], [1, 5],
  [3, 3], [2, 2], [1, 1],
];
console.log("| Ao vivo | Base 1º turno | Erro 10% | Erro 25% | Erro 50% | Erro médio | 1ª definição | Definições erradas | Cobertura* |");
console.log("|---|---|---|---|---|---|---|---|---|");
for (const [live, base] of scenarios) {
  D.t1lula = baselineAt(base);
  const snaps = project(D, order, { ...DEFAULT_PROJ, maxLevel: live, snapshots: 400 });
  const at = (f) => snaps.find((x) => x.sections >= f);
  const err = (f) => ((at(f).share - D.final) * 100).toFixed(2);
  const mae = (snaps.reduce((a, s) => a + Math.abs(s.share - D.final), 0) / snaps.length * 100).toFixed(2);
  const first = snaps.find((s) => callStatus(s).stage !== "open");
  const wrong = snaps.filter((s) => callStatus(s).stage === "likely" && callStatus(s).winner !== "lula").length;
  const cover = snaps.filter((s) => s.lo <= D.final && D.final <= s.hi).length / snaps.length;
  const liveName = live === 4 ? "Seção" : NAME[live];
  console.log(`| ${liveName} | ${NAME[base]} | ${err(0.1)} | ${err(0.25)} | ${err(0.5)} | ${mae} | ${first ? `${(first.sections * 100).toFixed(1)}% (${clock(first.time)})` : "—"} | ${wrong} | ${(cover * 100).toFixed(0)}% |`);
}
