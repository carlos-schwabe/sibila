// Baixa da API de divulgação do TSE o resultado do 1º turno por seção, a base do estimador
// swing, enquanto os dados abertos consolidados não saem. Para cada seção que já chegou:
// arquivo auxiliar (EA18) -> boletim de urna (BU) -> votos para presidente, comparecimento
// e eleitores aptos. São ~2 requisições por seção (~950 mil no Brasil, 6 a 7 horas a 40/s).
//
// Saída: um NDJSON por UF em --out, uma linha por seção. Pode ser interrompido e retomado:
// seções já gravadas são puladas. Depois, scripts/build_baseline.mjs gera os arquivos do motor.
//
// Uso:
//   node scripts/fetch_baseline.mjs                      # todas as UFs, 1º turno de 2026
//   node scripts/fetch_baseline.mjs --ufs ac,rr --rps 80
import { mkdirSync, existsSync, readFileSync, appendFileSync, writeFileSync } from "node:fs";
import { createClient } from "../server/tse-client.mjs";
import { paths } from "../server/tse-format.mjs";
import { readBU } from "../server/bu.mjs";

const opt = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const CFG = {
  base: opt("base", "https://resultados.tse.jus.br/oficial"),
  ciclo: opt("ciclo", "ele2026"),
  pleito: Number(opt("pleito", 3220)),
  eleicao: Number(opt("eleicao", 6257)), // eleição federal do 1º turno (presidente)
  ufs: opt("ufs", "ac,al,am,ap,ba,ce,df,es,go,ma,mg,ms,mt,pa,pb,pe,pi,pr,rj,rn,ro,rr,rs,sc,se,sp,to,zz").split(","),
  out: opt("out", new URL(`../data/api-p${opt("pleito", 3220)}/`, import.meta.url).pathname),
  rps: Number(opt("rps", 40)),
  concorrencia: Number(opt("concorrencia", 24)), // requisições simultâneas (latência ~0,2 s: 24 permite ~100/s)
};
const URLS = paths(CFG);
const client = createClient({ base: CFG.base, rps: CFG.rps, concurrency: CFG.concorrencia });
mkdirSync(CFG.out, { recursive: true });

// Municípios (nomes) da eleição, usados ao montar a base
const munPath = CFG.out + "municipios.json";
if (!existsSync(munPath)) {
  const cm = await client.json(URLS.municipios());
  if (!cm) { console.error("Não foi possível baixar a lista de municípios."); process.exit(1); }
  writeFileSync(munPath, JSON.stringify(cm));
}

const pool = async (items, n, fn) => { let i = 0; await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) await fn(items[i++]); })); };

for (const uf of CFG.ufs) {
  const file = CFG.out + `${uf}.ndjson`;
  const done = new Set();
  // Seções resolvidas: com votos, ou em situação definitiva sem votos (não instalada, anulada).
  // Falhas ficam de fora e são tentadas de novo; ao montar a base vale a última linha da seção.
  const final = (r) => r.votos || ["Não instalada", "Anulada"].includes(r.status);
  if (existsSync(file)) for (const line of readFileSync(file, "utf8").split("\n")) if (line) { const r = JSON.parse(line); if (final(r)) done.add(`${r.mun}|${r.zona}|${r.secao}`); }
  const cs = await client.json(URLS.secoes(uf));
  if (!cs) { console.warn(`${uf}: lista de seções indisponível`); continue; }
  // Seções principais que já chegaram (as agregadas votam na urna da principal, em `nsa`)
  const todo = [];
  for (const abr of cs.abr ?? []) for (const mu of abr.mu ?? []) for (const zon of mu.zon ?? []) for (const sec of zon.sec ?? []) {
    if (sec.nsp || !sec.ha) continue;
    if (done.has(`${mu.cd}|${zon.cd}|${sec.ns}`)) continue;
    todo.push({ mun: mu.cd, zona: zon.cd, secao: sec.ns, agregadas: sec.nsa ?? [] });
  }
  console.log(`${uf}: ${done.size} já gravadas, ${todo.length} a baixar`);
  let ok = 0, fail = 0;
  const t0 = Date.now();
  await pool(todo, CFG.concorrencia, async (s) => {
    const aux = await client.json(URLS.aux(uf, s.mun, s.zona, s.secao));
    const base = { mun: s.mun, zona: s.zona, secao: s.secao, agregadas: s.agregadas, status: aux?.st ?? null };
    let row = base;
    const hashes = aux?.hashes ?? [];
    const h = hashes.find((x) => x.st === "Totalizado") ?? hashes.at(-1);
    const bu = h?.arq?.find((a) => a.tp === "bu");
    if (bu) {
      const bytes = await client.bytes(URLS.urna(uf, s.mun, s.zona, s.secao, h.hash, bu.nm));
      if (bytes) {
        try {
          const r = readBU(bytes, { eleicao: CFG.eleicao, cargo: 1 });
          row = { ...base, local: r.local, aptos: r.aptos, comparecimento: r.comparecimento, votos: r.votos, branco: r.branco, nulo: r.nulo };
        } catch (e) { row = { ...base, erro: e.message }; }
      }
    }
    if (row.votos) ok++; else fail++;
    appendFileSync(file, JSON.stringify(row) + "\n");
    const n = ok + fail;
    if (n % 500 === 0) console.log(`  ${uf}: ${n}/${todo.length} (${(n / ((Date.now() - t0) / 1000)).toFixed(1)} seções/s)`);
  });
  console.log(`${uf}: ${ok} seções com BU, ${fail} sem (não instaladas, anuladas ou falha)`);
}
