// Estima, na apuração completa de 2022, como o swing entre turnos varia em cada nível da
// hierarquia. É a variância a priori usada quando a divulgação ao vivo só traz votos
// agregados (projectFeed): os níveis abaixo do observado entram com estes valores.
// Uso: node scripts/estimate_prior.mjs
import { readFileSync } from "node:fs";
import { loadData, realOrder, project, DEFAULT_PROJ, LEVELS } from "../app/engine.js";

const root = new URL("../app/data/", import.meta.url);
const buf = readFileSync(new URL("sections.bin", root));
const D = loadData(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), JSON.parse(readFileSync(new URL("meta.json", root), "utf8")));
const [full] = project(D, realOrder(D), { ...DEFAULT_PROJ, targets: [D.N] });
const v = (sd) => +(sd * sd).toPrecision(3);
console.log("prior: {");
console.log(`  sec: ${v(full.sigSec)}, // entre seções de um mesmo local (dp ${(full.sigSec * 100).toFixed(2)} pp)`);
console.log(`  tau: [0, ${full.tau.slice(1).map(v).join(", ")}], // ${LEVELS.slice(1).map((n, i) => `${n} ${(full.tau[i + 1] * 100).toFixed(2)} pp`).join(", ")}`);
console.log("}");
