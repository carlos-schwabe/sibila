// Cliente da divulgação do TSE: toda requisição, inclusive novas tentativas, passa pelo
// semáforo (rate-limit.mjs). Se o TSE sinalizar bloqueio (429 ou 403), todas as requisições
// param pelo tempo da penalidade, porque tentar de novo durante o bloqueio o reinicia.
import { createLimiter, HARD_MAX } from "./rate-limit.mjs";

export function createClient({ base, rps, penalty = 60, concurrency = 8 }) {
  const limiter = createLimiter({ perSecond: rps, concurrency });
  // Saúde da conexão com o TSE, exposta em /healthz
  const stats = { requests: 0, failures: 0, lastOk: null, lastError: null, lastErrorAt: null };
  const fail = (path, msg) => { stats.failures++; stats.lastError = `${msg} em ${path}`; stats.lastErrorAt = new Date().toISOString(); };
  if (rps > HARD_MAX) console.warn(`--rps ${rps} acima do teto; usando ${HARD_MAX}.`);
  // Retorna a resposta, null para 404 e undefined se falhar três vezes
  async function get(path, read) {
    for (let attempt = 1; ; attempt++) {
      try {
        stats.requests++;
        const r = await limiter.run(() => fetch(base + path, { signal: AbortSignal.timeout(20000) }));
        if (r.status === 404) { stats.lastOk = new Date().toISOString(); return null; }
        if (r.status === 429 || r.status === 403) {
          console.warn(`  TSE sinalizou bloqueio (HTTP ${r.status}); pausando ${penalty}s.`);
          limiter.pause(penalty * 1000);
          throw new Error(`HTTP ${r.status}`);
        }
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const data = await read(r);
        stats.lastOk = new Date().toISOString();
        return data;
      } catch (e) {
        fail(path, e.message);
        if (attempt >= 3) { console.warn(`  falhou ${path}: ${e.message}`); return undefined; }
        await new Promise((r) => setTimeout(r, 1000 * attempt));
      }
    }
  }
  return {
    limit: limiter.limit,
    // estado para monitoramento: última resposta, último erro e pausa por bloqueio
    health: () => ({ ...stats, pausedSeconds: Math.round(limiter.pausedFor / 1000) }),
    json: (path) => get(path, (r) => r.json()),
    bytes: (path) => get(path, async (r) => new Uint8Array(await r.arrayBuffer())),
  };
}
