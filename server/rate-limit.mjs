// Semáforo de requisições ao TSE. A divulgação bloqueia o IP que passar de 100 requisições
// por segundo, e o bloqueio recomeça a cada nova tentativa feita durante ele. Por isso:
//  - nunca mais que `perSecond` inícios de requisição em qualquer janela de 1 segundo
//    (limitado a HARD_MAX, com folga abaixo de 100, seja qual for o valor pedido);
//  - no máximo `concurrency` requisições em andamento;
//  - pause(ms) suspende todas as requisições, usado quando o servidor sinaliza bloqueio.
export const HARD_MAX = 90;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createLimiter({ perSecond, concurrency = 8 }) {
  const limit = Math.max(1, Math.min(perSecond, HARD_MAX));
  const starts = []; // horários dos inícios no último segundo
  let active = 0, pausedUntil = 0;

  async function acquire() {
    for (;;) {
      const now = Date.now();
      while (starts.length && now - starts[0] >= 1000) starts.shift();
      if (now < pausedUntil) { await sleep(pausedUntil - now); continue; }
      if (active < concurrency && starts.length < limit) {
        starts.push(now); active++;
        return;
      }
      // espera a janela abrir espaço ou uma requisição terminar
      await sleep(starts.length >= limit ? 1000 - (now - starts[0]) + 1 : 5);
    }
  }

  return {
    limit,
    // roda fn() dentro do limite
    async run(fn) {
      await acquire();
      try { return await fn(); } finally { active--; }
    },
    pause(ms) { pausedUntil = Math.max(pausedUntil, Date.now() + ms); },
    get pausedFor() { return Math.max(0, pausedUntil - Date.now()); },
  };
}
