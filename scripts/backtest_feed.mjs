// Backtest do que a divulgação ao vivo publica, simulando o coletor na noite de 2022.
// A cada ciclo de `ciclo` segundos o coletor vê as seções que já chegaram, os totais por UF
// (sempre atuais) e, conforme o modo, baixa arquivos de zona:
//   uf       nenhum arquivo de zona
//   zona     todas as zonas que mudaram, no limite de `rps` requisições por segundo
//   hibrido  até `zonas` arquivos por ciclo, das zonas com mais seções ainda não cobertas
// Uso: node scripts/backtest_feed.mjs '{"modo":"hibrido","ciclo":10,"zonas":300}'
// Outras eleições e variâncias a priori: '{"data":"data/2018/base-full","prior":"2014"}'
// (prior: "2014", "2018", "2022" ou um objeto { sec, tau })
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { loadData, realOrder, projectFeed, callStatus, DEFAULT_PROJ } from "../app/engine.js";

// Variância a priori do swing por nível, estimada por scripts/estimate_prior.mjs em cada eleição
const PRIORS = {
  2014: { sec: 0.000836, tau: [0, 0.00306, 0.00219, 0.000488, 0.000561] },
  2018: { sec: 0.00102, tau: [0, 0.00345, 0.00175, 0.000165, 0.000475] },
  2022: DEFAULT_PROJ.prior,
};

const O = { modo: "hibrido", ciclo: 10, zonas: 300, rps: 50, avaliar: 60, ...JSON.parse(process.argv[2] ?? "{}") };
const root = O.data ? pathToFileURL(resolve(O.data) + "/") : new URL("../app/data/", import.meta.url);
const buf = readFileSync(new URL("sections.bin", root));
const D = loadData(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), JSON.parse(readFileSync(new URL("meta.json", root), "utf8")));
const { order } = realOrder(D);
const P = { ...DEFAULT_PROJ, ...(O.biasCorr != null ? { biasCorr: O.biasCorr } : {}), prior: typeof O.prior === "object" ? O.prior : PRIORS[O.prior ?? "2022"] };
const winner = D.final >= 0.5 ? "lula" : "bolso"; // "lula" = candidato A (13), "bolso" = candidato B

// Seções de cada zona na ordem de chegada
const nz = D.nG[3], nu = D.nG[1];
const zoneOrder = Array.from({ length: nz }, () => []);
for (const s of order) zoneOrder[D.anc[3][s]].push(s);

const counted = new Uint8Array(D.N), covered = new Uint8Array(D.N);
const ufVotes = new Float64Array(2 * nu), zoneVotes = new Float64Array(2 * nz);
const arrived = new Int32Array(nz), coveredN = new Int32Array(nz);
const end = D.arrival[order[D.N - 1]];
let next = 0, requests = 0, maxCycle = 0, nextEval = 0;
const snaps = [];

for (let t = 0; t <= end + O.ciclo; ) {
  for (; next < D.N && D.arrival[order[next]] <= t; next++) {
    const s = order[next], u = D.anc[1][s];
    counted[s] = 1; arrived[D.anc[3][s]]++;
    ufVotes[2 * u] += D.lula[s]; ufVotes[2 * u + 1] += D.bolso[s];
  }
  // zonas a baixar neste ciclo
  let pick = [];
  if (O.modo !== "uf") {
    for (let z = 0; z < nz; z++) if (arrived[z] > coveredN[z]) pick.push(z);
    if (O.modo === "hibrido") pick = pick.sort((a, b) => (arrived[b] - coveredN[b]) - (arrived[a] - coveredN[a])).slice(0, O.zonas);
  }
  for (const z of pick) {
    for (let i = coveredN[z]; i < arrived[z]; i++) {
      const s = zoneOrder[z][i];
      covered[s] = 1; zoneVotes[2 * z] += D.lula[s]; zoneVotes[2 * z + 1] += D.bolso[s];
    }
    coveredN[z] = arrived[z];
  }
  const reqs = 2 * nu + pick.length;
  requests += reqs;
  const dur = Math.max(O.ciclo, reqs / O.rps); // um ciclo não termina antes de baixar tudo
  maxCycle = Math.max(maxCycle, dur);
  if (t >= nextEval && next > 0) {
    snaps.push(projectFeed(D, P, counted, { ufVotes, zoneVotes: O.modo === "uf" ? null : zoneVotes, covered }, t / 60));
    nextEval = t + O.avaliar;
  }
  // sem seção nova por um tempo (algumas são totalizadas dias depois), pula até a próxima
  const nextArrival = next < D.N ? D.arrival[order[next]] : Infinity;
  t = Math.max(t + dur, Number.isFinite(nextArrival) && nextArrival > t + dur + O.avaliar ? nextArrival - O.ciclo : t + dur);
}

const pct = (v) => (v * 100).toFixed(2) + "%";
const clock = (m) => { const t = 17 * 60 + m; return `${String(Math.floor(t / 60) % 24).padStart(2, "0")}:${String(Math.floor(t % 60)).padStart(2, "0")}`; };
const final = D.final;
// Cobertura até 99,9% apurado: depois disso o erro e o intervalo ficam abaixo de 0,0001 pp
const evalSnaps = snaps.filter((s) => s.sections < 0.999);
const inside = evalSnaps.filter((s) => s.lo <= final && final <= s.hi).length;
const first = snaps.find((s) => callStatus(s).stage !== "open");
const wrong = snaps.filter((s) => callStatus(s).stage !== "open" && callStatus(s).winner !== winner).length;
const at = (f) => snaps.find((s) => s.sections >= f);
console.log(`${O.data ?? "app/data"} prior=${O.prior ?? "2022"} ρ=${P.biasCorr} final=${pct(final)} vencedor=${winner === "lula" ? "A (13)" : "B"}  modo=${O.modo} ciclo=${O.ciclo}s${O.modo === "hibrido" ? ` zonas=${O.zonas}` : ""}  ciclo mais longo ${maxCycle.toFixed(0)}s  média ${(requests / D.arrival[order[Math.floor(D.N * 0.999)]]).toFixed(1)} req/s`);
console.log(`  cobertura ${((100 * inside) / evalSnaps.length).toFixed(0)}% de ${evalSnaps.length} (até 99,9%)  |  1ª definição ${first ? `${pct(first.sections)} (${clock(first.time)}, ${callStatus(first).winner === winner ? "certa" : "ERRADA"})` : "—"}  |  erradas ${wrong}`);
console.log("  " + [0.1, 0.25, 0.5, 0.75].map((f) => { const s = at(f); return `${f * 100}%: ${((s.share - final) * 100).toFixed(2)} ± ${((s.hi - s.share) * 100).toFixed(2)}`; }).join("  |  "));
if (O.diag) {
  const miss = snaps.filter((s) => !(s.lo <= final && final <= s.hi));
  console.log(`  fora do intervalo: ${miss.length}; por faixa de apuração:`);
  for (const [a, b] of [[0, 0.5], [0.5, 0.9], [0.9, 0.99], [0.99, 0.999], [0.999, 1.01]]) {
    const m = miss.filter((s) => s.sections >= a && s.sections < b), all = snaps.filter((s) => s.sections >= a && s.sections < b);
    const worst = m.reduce((w, s) => Math.max(w, Math.abs(s.share - final) / Math.max(s.se, 1e-12)), 0);
    console.log(`    ${(a * 100).toFixed(1)}–${(b * 100).toFixed(1)}%: ${m.length}/${all.length}${m.length ? `  pior |erro|/dp ${worst.toFixed(1)}, ex.: erro ${((m[0].share - final) * 100).toFixed(4)} pp ± ${((m[0].hi - m[0].share) * 100).toFixed(4)}` : ""}`);
  }
}
