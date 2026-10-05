// Servidor de produção: serve a página (app/) e roda o coletor no mesmo processo.
//  - Os JSON ao vivo (latest.json, history.json) ficam em memória, já comprimidos, e são
//    trocados a cada ciclo do coletor; nenhum pedido de leitor chega ao TSE.
//  - Todo arquivo tem ETag (304 quando não mudou). JSON ao vivo: cache de 5 s com
//    stale-while-revalidate, para que navegador e CDN absorvam recarregamentos.
//  - Os códigos do 2º turno são descobertos sozinhos no ele-c.json do TSE pela data da eleição.
//
// Variáveis de ambiente (todas opcionais):
//   PORT            porta HTTP (8080)
//   DIA             data da eleição, dd/mm/aaaa (25/10/2026)
//   TURNO           turno a acompanhar (2)
//   PLEITO, ELEICAO códigos do TSE; sem eles, descobertos pela DIA/TURNO
//   DATA_DIR        base do 1º turno por seção (sections.bin, meta.json)
//   BASELINE_URL    endereço de onde baixar sections.bin e meta.json se a base não existir
//   LIVE_DIR        onde gravar o estado do coletor (no Railway, dentro do volume)
//   ZONAS, RPS, INTERVALO  parâmetros do coletor (100, 30, 10)
//   TSE_BASE        endereço da divulgação (https://resultados.tse.jus.br/oficial)
import http from "node:http";
import { readFileSync, readdirSync, statSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, extname, relative, sep } from "node:path";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { runPoller, DEFAULTS } from "./poller.mjs";
import { createClient } from "./tse-client.mjs";

const env = process.env;
const ROOT = new URL("../app/", import.meta.url).pathname;
const VOLUME = env.RAILWAY_VOLUME_MOUNT_PATH;
const PORT = Number(env.PORT ?? 8080);
const DIA = env.DIA ?? "25/10/2026";
const TURNO = env.TURNO ?? "2";
const TSE_BASE = env.TSE_BASE ?? DEFAULTS.base;
const LIVE_DIR = (env.LIVE_DIR ?? (VOLUME ? join(VOLUME, "live") : join(ROOT, "live"))).replace(/\/?$/, "/");

/* ---------- Arquivos estáticos, em memória ---------- */
const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".bin": "application/octet-stream", ".jpg": "image/jpeg",
  ".png": "image/png", ".webp": "image/webp", ".svg": "image/svg+xml",
};
const COMPRESS = new Set([".html", ".js", ".css", ".json", ".bin", ".svg"]);
const CACHE = {
  ".html": "no-cache", // sempre revalida (304 se não mudou)
  ".js": "public, max-age=300", ".css": "public, max-age=300",
  ".json": "public, max-age=3600", ".bin": "public, max-age=3600",
  ".jpg": "public, max-age=86400", ".png": "public, max-age=86400", ".webp": "public, max-age=86400",
};
const LIVE_CACHE = "public, max-age=5, stale-while-revalidate=10";

function entry(body, ext, cache) {
  return {
    body, gz: COMPRESS.has(ext) && body.length > 512 ? gzipSync(body) : null,
    type: TYPES[ext] ?? "application/octet-stream", cache: cache ?? CACHE[ext] ?? "public, max-age=300",
    etag: `"${createHash("sha1").update(body).digest("base64url").slice(0, 16)}"`,
  };
}
const files = new Map();
(function load(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name), rel = "/" + relative(ROOT, p).split(sep).join("/");
    if (statSync(p).isDirectory()) { if (rel !== "/live" && rel !== "/data-2026") load(p); continue; }
    files.set(rel, entry(readFileSync(p), extname(name)));
  }
})(ROOT);
files.set("/", files.get("/index.html"));
files.set("/demo/", files.get("/demo/index.html"));

// JSON ao vivo: começam com o que estiver gravado (retomada após reinício)
function setLive(name, data) { files.set(`/live/${name}`, entry(Buffer.from(JSON.stringify(data)), ".json", LIVE_CACHE)); }
for (const name of ["latest.json", "history.json"]) {
  if (existsSync(LIVE_DIR + name)) setLive(name, JSON.parse(readFileSync(LIVE_DIR + name, "utf8")));
}

/* ---------- HTTP ---------- */
const status = { started: new Date().toISOString(), pleito: null, eleicao: null, base: null, lastUpdate: null, poller: "aguardando" };
// Um só cliente do TSE para tudo: mesmo semáforo e uma medição de saúde só
const client = createClient({ base: TSE_BASE, rps: Number(env.RPS ?? DEFAULTS.rate) });
// O TSE responde se houve resposta nos últimos 10 minutos (sem a eleição publicada, o servidor
// consulta o ele-c.json a cada 5 minutos) e não estamos em pausa por bloqueio
function tseHealth() {
  const h = client.health();
  const ok = h.lastOk && Date.now() - Date.parse(h.lastOk) < 10 * 60000 && !h.pausedSeconds;
  return { ok: !!ok, ...h };
}
http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  let path = decodeURIComponent(url.pathname);
  if (path === "/healthz") { res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify({ ...status, tse: tseHealth() }, null, 2)); return; }
  if (path === "/demo") { res.writeHead(301, { location: "/demo/" }); res.end(); return; }
  const f = files.get(path);
  if (!f || (req.method !== "GET" && req.method !== "HEAD")) {
    res.writeHead(f ? 405 : 404, { "content-type": "text/plain; charset=utf-8" }); res.end(f ? "Método não permitido" : "Não encontrado"); return;
  }
  const headers = { "content-type": f.type, "cache-control": f.cache, etag: f.etag, vary: "Accept-Encoding", "x-content-type-options": "nosniff" };
  if (req.headers["if-none-match"] === f.etag) { res.writeHead(304, headers); res.end(); return; }
  const gz = f.gz && /\bgzip\b/.test(req.headers["accept-encoding"] ?? "");
  const body = gz ? f.gz : f.body;
  res.writeHead(200, { ...headers, ...(gz ? { "content-encoding": "gzip" } : {}), "content-length": body.length });
  res.end(req.method === "HEAD" ? undefined : body);
}).listen(PORT, () => console.log(`Servindo app/ na porta ${PORT}`));

/* ---------- Base do 1º turno ---------- */
async function resolveBaseline() {
  if (env.DATA_DIR) return env.DATA_DIR.replace(/\/?$/, "/");
  const ok = (dir) => existsSync(dir + "sections.bin") && existsSync(dir + "meta.json");
  const vol = VOLUME ? join(VOLUME, "base-2026") + "/" : null;
  if (vol && ok(vol)) return vol;
  if (env.BASELINE_URL) {
    const dest = vol ?? join(ROOT, "data-2026") + "/";
    mkdirSync(dest, { recursive: true });
    const from = env.BASELINE_URL.replace(/\/?$/, "/");
    for (const name of ["meta.json", "sections.bin"]) {
      console.log(`Baixando a base do 1º turno: ${from}${name}`);
      const r = await fetch(from + name);
      if (!r.ok) throw new Error(`BASELINE_URL ${name}: HTTP ${r.status}`);
      writeFileSync(dest + name, Buffer.from(await r.arrayBuffer()));
    }
    return dest;
  }
  const repo = join(ROOT, "data-2026") + "/";
  if (ok(repo)) return repo;
  console.warn("Base do 1º turno de 2026 não encontrada; usando a de 2022 (projeção imprecisa).");
  return join(ROOT, "data") + "/";
}

/* ---------- Códigos do pleito ---------- */
// Procura no ele-c.json do TSE o pleito da data DIA e, nele, a eleição federal do turno TURNO
async function discover(client) {
  const cfg = await client.json("/comum/config/ele-c.json");
  for (const pl of cfg?.pl ?? []) {
    if (pl.dt !== DIA) continue;
    const e = (pl.e ?? []).find((x) => x.t === TURNO && ["8", "9"].includes(x.tp)); // eleição federal (ordinária ou suplementar)
    if (e) return { pleito: Number(pl.cd), eleicao: Number(e.cd), ciclo: pl.c };
  }
  return null;
}

/* ---------- Coletor ---------- */
async function start() {
  let codes = env.PLEITO && env.ELEICAO ? { pleito: Number(env.PLEITO), eleicao: Number(env.ELEICAO), ciclo: env.CICLO ?? DEFAULTS.ciclo } : null;
  while (!codes) {
    codes = await discover(client).catch((e) => { console.warn("ele-c.json:", e.message); return null; });
    publishStatus(); // reflete na hora se o TSE respondeu
    if (codes) break;
    status.poller = `aguardando o TSE publicar a eleição de ${DIA}`;
    status.fase = "aguardando";
    console.log(`Eleição de ${DIA} (${TURNO}º turno) ainda não publicada no TSE; tentando de novo em 5 min.`);
    await new Promise((r) => setTimeout(r, 5 * 60000));
  }
  Object.assign(status, { pleito: codes.pleito, eleicao: codes.eleicao });
  status.base = await resolveBaseline();
  status.poller = "coletando";
  status.fase = "coletando";
  console.log(`Coletando pleito ${codes.pleito}, eleição ${codes.eleicao}, base ${status.base}, saída ${LIVE_DIR}`);
  await runPoller({
    base: TSE_BASE, client, ...codes, dia: DIA, data: status.base, out: LIVE_DIR,
    zonas: Number(env.ZONAS ?? DEFAULTS.zonas), interval: Number(env.INTERVALO ?? DEFAULTS.interval),
    rate: Number(env.RPS ?? DEFAULTS.rate),
  }, ({ latest, history }) => {
    setLive("latest.json", latest); setLive("history.json", history);
    status.lastUpdate = latest.updated;
  });
  status.poller = "apuração completa";
  status.fase = "completa";
}
start().catch((e) => { status.poller = `erro: ${e.message}`; console.error(e); });

// Situação pública para a página (live/status.json): fase, data da eleição e se o TSE responde
function publishStatus() {
  const t = tseHealth();
  setLive("status.json", { fase: status.fase ?? "aguardando", dia: DIA, turno: TURNO, tse: { ok: t.ok, lastOk: t.lastOk }, at: new Date().toISOString() });
}
publishStatus();
setInterval(publishStatus, 15000);
