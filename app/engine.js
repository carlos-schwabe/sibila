// Motor de projeção da noite de apuração do 2º turno presidencial.
//
// A ordem de apuração é a real: o horário em que cada seção entrou na totalização do TSE
// (detalhe_votacao_secao). A cada instante, cada seção ainda não apurada é estimada a
// partir do nível mais fino da hierarquia (local de votação > zona > município > UF >
// Brasil) cuja parcela apurada passa os limiares configurados. A incerteza vem da
// variância entre grupos de cada nível que a estimativa pula, da variância entre seções
// e do erro amostral da média do grupo.

export const LEVELS = ["Brazil", "State", "City", "Zone", "Polling place"];

export const DEFAULT_PROJ = {
  // fração mínima apurada (dos votos esperados) e mínimo de seções apuradas para que
  // um grupo sirva de população para as suas seções não apuradas
  minFrac: [0, 0.05, 0.2, 0.3, 0.5], // índice = nível (0, Brasil, é sempre permitido)
  minSec: [1, 30, 10, 8, 2],
  estimator: "swing", // "swing": % do 1º turno da seção + variação média da população entre turnos; "share": % média da população
  biasCorr: 0.5, // correlação dos desvios não observados dentro do grupo usado na projeção
  maxLevel: 4, // nível mais fino observável ao vivo (4 local, 3 zona, 2 município, 1 UF)
  // Variância a priori do swing em cada nível, usada quando a divulgação só traz votos
  // agregados (projectFeed): os níveis abaixo do observado entram com estes valores.
  // Estimada na apuração completa de 2022 (scripts/estimate_prior.mjs).
  prior: {
    sec: 0.000429, // entre seções de um mesmo local (dp 2,07 pp)
    tau: [0, 0.000194, 0.000223, 0.0000144, 0.0000482], // UF 1,39 pp, município 1,49 pp, zona 0,38 pp, local 0,69 pp
  },
  confidence: 0.95,
  snapshots: 240,
};

export function loadData(buf, meta) {
  const N = meta.nSections;
  let o = 0;
  const secLocal = new Uint32Array(buf, o, N); o += 4 * N;
  const arrival = new Uint32Array(buf, o, N); o += 4 * N; // segundos após as 17:00
  const t1 = new Uint16Array(buf, o, N); o += 2 * N;
  const t1lula = new Uint16Array(buf, o, N); o += 2 * N;
  const lula = new Uint16Array(buf, o, N); o += 2 * N;
  const bolso = new Uint16Array(buf, o, N); o += 2 * N;
  const aptos = new Uint16Array(buf, o, N); o += 2 * N; // eleitores aptos
  const secNr = new Uint16Array(buf, o, N); // número da seção
  const localZone = Int32Array.from(meta.localZone);
  const zoneMuni = Int32Array.from(meta.zoneMuni);
  const muniUf = Int32Array.from(meta.munis.map((m) => m[1]));
  const nG = [1, meta.ufs.length, meta.munis.length, zoneMuni.length, localZone.length];

  // anc[nível][seção] = índice do grupo da seção naquele nível
  const anc = [new Int32Array(N), new Int32Array(N), new Int32Array(N), new Int32Array(N), new Int32Array(N)];
  for (let s = 0; s < N; s++) {
    const l = secLocal[s], z = localZone[l], m = zoneMuni[z];
    anc[4][s] = l; anc[3][s] = z; anc[2][s] = m; anc[1][s] = muniUf[m];
  }
  // parent[nível][g] = índice do grupo no nível acima
  const parent = [null, new Int32Array(nG[1]), muniUf, zoneMuni, localZone];
  // Tamanho esperado de cada grupo: soma dos votos do 1º turno
  const t1Tot = nG.map((n) => new Float64Array(n));
  const secTot = nG.map((n) => new Int32Array(n));
  for (let s = 0; s < N; s++) {
    for (let k = 0; k < 5; k++) { t1Tot[k][anc[k][s]] += t1[s]; secTot[k][anc[k][s]]++; }
  }
  // Resultado final real por UF (para a tabela do backtest)
  const ufFinal = Array.from({ length: nG[1] }, () => [0, 0]);
  for (let s = 0; s < N; s++) { ufFinal[anc[1][s]][0] += lula[s]; ufFinal[anc[1][s]][1] += bolso[s]; }

  return {
    N, arrival, t1, t1lula, lula, bolso, aptos, secNr, anc, parent, nG, t1Tot, secTot, ufFinal,
    ufNames: meta.ufs,
    muniCode: meta.munis.map((m) => m[2]),
    zoneNr: Int32Array.from(meta.zoneNr),
    final: meta.final.lula / (meta.final.lula + meta.final.bolso),
  };
}

// Seções ordenadas pelo horário de entrada na totalização do TSE; tempo em minutos após as 17:00
export function realOrder(D) {
  const { N, arrival } = D;
  const order = new Uint32Array(N), time = new Float64Array(N);
  for (let s = 0; s < N; s++) { order[s] = s; time[s] = arrival[s] / 60; }
  order.sort((a, b) => arrival[a] - arrival[b] || a - b);
  return { order, time };
}

// Inversa da CDF normal padrão (Acklam)
export function normInv(p) {
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155922525];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const q = p < 0.5 ? p : 1 - p;
  let x;
  if (q < 0.02425) {
    const r = Math.sqrt(-2 * Math.log(q));
    x = (((((c[0] * r + c[1]) * r + c[2]) * r + c[3]) * r + c[4]) * r + c[5]) / ((((d[0] * r + d[1]) * r + d[2]) * r + d[3]) * r + 1);
  } else {
    const r = q - 0.5, r2 = r * r;
    x = ((((((a[0] * r2 + a[1]) * r2 + a[2]) * r2 + a[3]) * r2 + a[4]) * r2 + a[5]) * r) / (((((b[0] * r2 + b[1]) * r2 + b[2]) * r2 + b[3]) * r2 + b[4]) * r2 + 1);
    return p < 0.5 ? x : -x;
  }
  return p < 0.5 ? -x : x;
}
// Apuração bruta (% de Lula nos votos válidos) após cada quantidade de seções indicada
export function rawCurve(D, sim, targets) {
  const out = [];
  let l = 0, v = 0, next = 0;
  for (const target of targets) {
    for (; next < target; next++) { const s = sim.order[next]; l += D.lula[s]; v += D.lula[s] + D.bolso[s]; }
    if (next > 0) out.push({ sections: next / D.N, time: sim.time[sim.order[next - 1]], raw: l / v, lulaVotes: l, bolsoVotes: v - l });
  }
  return out;
}

// Situação da disputa em um instante:
//  "decided": a vantagem do líder supera todos os eleitores aptos ainda não apurados
//  "likely":  a projeção dá a um candidato pelo menos `certainty` de chance de vencer
//  "open":    caso contrário
export function callStatus(snap, certainty = 0.999) {
  const lead = snap.lulaVotes - snap.bolsoVotes;
  if (Math.abs(lead) > snap.aptosLeft) return { stage: "decided", winner: lead > 0 ? "lula" : "bolso" };
  if (snap.pWin >= certainty) return { stage: "likely", winner: "lula" };
  if (1 - snap.pWin >= certainty) return { stage: "likely", winner: "bolso" };
  return { stage: "open", winner: snap.pWin >= 0.5 ? "lula" : "bolso" };
}

export function normCdf(x) {
  // Abramowitz-Stegun 7.1.26 via erf
  const t = 1 / (1 + 0.3275911 * Math.abs(x) / Math.SQRT2);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x / 2);
  return x >= 0 ? (1 + y) / 2 : (1 - y) / 2;
}

// Estado da apuração: agregados das seções apuradas por nível/grupo e o que falta por local.
// O valor modelado por seção, y, é o % de Lula no 2º turno (estimador "share") ou esse %
// menos o % de Lula da própria seção no 1º turno, x (estimador "swing"). A estimativa de
// uma seção é x + a média de y da população usada para projetá-la.
function newState(D, P) {
  const { N, anc, nG, t1, t1lula, aptos } = D;
  const x = new Float64Array(N);
  if (P.estimator === "swing") {
    let a = 0, b = 0;
    for (let s = 0; s < N; s++) { a += t1lula[s]; b += t1[s]; }
    for (let s = 0; s < N; s++) x[s] = t1[s] > 0 ? t1lula[s] / t1[s] : a / b;
  }
  const A = {
    x,
    cnt: nG.map((n) => new Int32Array(n)),
    W: nG.map((n) => new Float64Array(n)), // votos válidos (Lula + Bolsonaro)
    L: nG.map((n) => new Float64Array(n)), // votos de Lula
    Y: nG.map((n) => new Float64Array(n)), // soma de w * y
    Y2: nG.map((n) => new Float64Array(n)), // soma de w * y^2
    C1: nG.map((n) => new Float64Array(n)), // soma dos votos do 1º turno das seções apuradas
    // Não apurado por local de votação: votos do 1º turno, seus quadrados e soma de t1 * x
    U1: new Float64Array(nG[4]), U2: new Float64Array(nG[4]), UX: new Float64Array(nG[4]),
    aptosLeft: 0, // eleitores aptos nas seções não apuradas: teto para os votos que ainda faltam
    done: 0,
    prior: null, // variâncias a priori (modo agregado), senão estimadas das seções apuradas
  };
  for (let s = 0; s < N; s++) {
    const l = anc[4][s];
    A.U1[l] += t1[s]; A.U2[l] += t1[s] * t1[s]; A.UX[l] += t1[s] * x[s];
    A.aptosLeft += aptos[s];
  }
  return A;
}

// Marca a seção s como apurada (sem votos: os votos entram por addVotes)
// `top` é o nível mais fino em que os votos da seção são observados: abaixo dele a seção não
// entra na contagem dos grupos, porque os votos desses grupos não a incluem.
function markCounted(D, A, s, top = 4) {
  const t = D.t1[s], l = D.anc[4][s];
  A.cnt[0][0]++; A.C1[0][0] += t;
  for (let lv = 1; lv <= top; lv++) { const g = D.anc[lv][s]; A.cnt[lv][g]++; A.C1[lv][g] += t; }
  A.U1[l] -= t; A.U2[l] -= t * t; A.UX[l] -= t * A.x[s];
  A.aptosLeft -= D.aptos[s];
  A.done++;
}

// Soma votos a um grupo do nível `top` e a todos os seus ancestrais
function addVotes(D, A, top, g, w, lv, y, y2) {
  for (let k = top; k >= 0; k--) {
    A.W[k][g] += w; A.L[k][g] += lv; A.Y[k][g] += y; A.Y2[k][g] += y2;
    if (k > 0) g = k === 1 ? 0 : D.parent[k][g];
  }
}

// Roda a projeção sobre uma ordem de apuração com votos por seção. Retorna uma linha por
// instante: P.snapshots igualmente espaçados em seções apuradas, ou as quantidades de seções
// listadas em P.targets.
export function project(D, sim, P) {
  const { N, lula, bolso } = D;
  const A = newState(D, P);
  const snaps = [];
  const targets = P.targets ?? Array.from({ length: P.snapshots }, (_, k) => Math.round((N * (k + 1)) / P.snapshots));
  let next = 0;
  for (const target of targets) {
    for (; next < target; next++) {
      const s = sim.order[next];
      const w = lula[s] + bolso[s];
      const y = w > 0 ? lula[s] / w - A.x[s] : 0;
      markCounted(D, A, s);
      addVotes(D, A, 4, D.anc[4][s], w, lula[s], w * y, w * y * y);
    }
    if (next === 0) continue;
    snaps.push(snapshot(D, A, P, sim.time[sim.order[next - 1]]));
  }
  return snaps;
}

// Projeção a partir do que a divulgação do TSE publica ao vivo. `counted` (Uint8Array por
// seção) marca as seções que já chegaram. `feed` traz os votos apurados, em pares
// [Lula, Bolsonaro] por índice de grupo:
//   ufVotes    totais por UF, sempre atuais;
//   zoneVotes  totais por zona (opcional), cada um do momento em que o arquivo da zona foi
//              baixado; `covered` marca as seções incluídas nesses totais.
// Os votos de cada UF que nenhuma zona baixada cobre formam um resíduo da UF. Sem votos por
// seção, a parte de um grupo atribuída a cada seção é proporcional aos votos do 1º turno, e a
// variância dos níveis abaixo do observado vem de P.prior.
export function projectFeed(D, P, counted, feed, time) {
  const { N, anc, nG, t1 } = D;
  const { ufVotes, zoneVotes, covered } = feed;
  const A = newState(D, P);
  A.prior = P.prior;
  const zC1 = new Float64Array(nG[3]), zX = new Float64Array(nG[3]);
  const rC1 = new Float64Array(nG[1]), rX = new Float64Array(nG[1]);
  for (let s = 0; s < N; s++) {
    const cov = zoneVotes && covered[s];
    if (!counted[s] && !cov) continue;
    if (cov) {
      markCounted(D, A, s, 4);
      const z = anc[3][s]; zC1[z] += t1[s]; zX[z] += t1[s] * A.x[s];
    } else {
      markCounted(D, A, s, 1);
      const u = anc[1][s]; rC1[u] += t1[s]; rX[u] += t1[s] * A.x[s];
    }
  }
  // variância do swing entre as seções de um grupo, dado o nível observado
  const inner = (level) => { let v = P.prior.sec; for (let k = level + 1; k < 5; k++) v += P.prior.tau[k]; return v; };
  const resid = Float64Array.from(ufVotes);
  if (zoneVotes) {
    const vz = inner(3);
    for (let z = 0; z < nG[3]; z++) {
      const l = zoneVotes[2 * z], w = l + zoneVotes[2 * z + 1];
      if (w <= 0 || zC1[z] <= 0) continue;
      const ybar = l / w - zX[z] / zC1[z]; // swing médio das seções apuradas da zona
      addVotes(D, A, 3, z, w, l, w * ybar, w * (ybar * ybar + vz));
      const u = D.parent[2][D.parent[3][z]];
      resid[2 * u] -= l; resid[2 * u + 1] -= zoneVotes[2 * z + 1];
    }
  }
  const vu = inner(1);
  for (let u = 0; u < nG[1]; u++) {
    const l = resid[2 * u], w = l + resid[2 * u + 1];
    if (w <= 0 || l < 0 || rC1[u] <= 0) continue;
    const ybar = l / w - rX[u] / rC1[u]; // swing médio das seções da UF sem zona baixada
    addVotes(D, A, 1, u, w, l, w * ybar, w * (ybar * ybar + vu));
  }
  return snapshot(D, A, { ...P, maxLevel: Math.min(P.maxLevel, zoneVotes ? 3 : 1) }, time);
}

// Calcula a projeção e o intervalo a partir do estado da apuração
function snapshot(D, A, P, time) {
  const { N, parent, nG, t1Tot, secTot } = D;
  const { cnt, W, L, Y, Y2, C1, U1, U2, UX } = A;
  const z = normInv(0.5 + P.confidence / 2);
  const pick = (lv, g) => cnt[lv][g] >= P.minSec[lv] && C1[lv][g] >= P.minFrac[lv] * t1Tot[lv][g] && W[lv][g] > 0;
  const within = (lv, g) => { // variância ponderada não viesada de y entre as seções do grupo
    const m = cnt[lv][g];
    if (m < 2 || W[lv][g] <= 0) return NaN;
    const p = Y[lv][g] / W[lv][g];
    return Math.max(0, Y2[lv][g] / W[lv][g] - p * p) * (m / (m - 1));
  };
  const natWithin = within(0, 0);
  // Variância entre seções: a priori, ou agregada sobre os locais de votação
  let sigSec = A.prior?.sec;
  if (sigSec == null) {
    let num = 0, den = 0;
    for (let g = 0; g < nG[4]; g++) {
      const v = within(4, g);
      if (!isNaN(v)) { num += v * W[4][g]; den += W[4][g]; }
    }
    sigSec = den > 0 ? num / den : natWithin;
  }
  // Variância entre grupos tau^2 em cada nível k>=1 (média do grupo em torno da média do
  // grupo pai), descontado o ruído amostral da média do grupo. Níveis abaixo do mais fino
  // observado usam a priori.
  const tau = [0, 0, 0, 0, 0];
  for (let lv = P.maxLevel + 1; lv < 5; lv++) tau[lv] = A.prior ? A.prior.tau[lv] : 0;
  for (let lv = 1; lv <= P.maxLevel; lv++) {
    let n2 = 0, d2 = 0;
    for (let g = 0; g < nG[lv]; g++) {
      if (cnt[lv][g] < 2 || W[lv][g] <= 0) continue;
      const pg = lv === 1 ? 0 : parent[lv][g];
      const pp = Y[lv - 1][pg] / W[lv - 1][pg];
      const p = Y[lv][g] / W[lv][g];
      const noise = within(lv, g) / cnt[lv][g];
      n2 += W[lv][g] * ((p - pp) * (p - pp) - noise); d2 += W[lv][g];
    }
    tau[lv] = d2 > 0 ? Math.max(0, n2 / d2) : natWithin;
  }

  const useAcc = nG.map((n) => new Float64Array(n)); // votos estimados a partir do grupo g (erro da média)
  const devAcc = nG.map((n) => new Float64Array(n)); // votos cujo desvio no nível k não foi observado
  const ufLrem = new Float64Array(nG[1]), ufVrem = new Float64Array(nG[1]), ufVar = new Float64Array(nG[1]);
  const ufNat = new Float64Array(nG[1]);
  const levelVotes = [0, 0, 0, 0, 0];
  let Lrem = 0, Vrem = 0, varSec = 0;
  const ancL = [0, 0, 0, 0, 0];
  for (let l = 0; l < nG[4]; l++) {
    if (U1[l] <= 0) continue;
    ancL[4] = l; ancL[3] = parent[4][l]; ancL[2] = parent[3][ancL[3]]; ancL[1] = parent[2][ancL[2]];
    let lv = 4;
    while (lv > 0 && (lv > P.maxLevel || !pick(lv, ancL[lv]))) lv--;
    const g = ancL[lv];
    const r = W[lv][g] / C1[lv][g]; // votos válidos do 2º turno por voto do 1º turno
    const nh = r * U1[l];
    const lh = r * (UX[l] + (Y[lv][g] / W[lv][g]) * U1[l]); // votos estimados de Lula
    Lrem += lh; Vrem += nh; levelVotes[lv] += nh;
    const vs = r * r * U2[l] * sigSec;
    varSec += vs;
    const uf = ancL[1];
    ufLrem[uf] += lh; ufVrem[uf] += nh; ufVar[uf] += vs;
    useAcc[lv][g] += nh;
    if (lv === 0) ufNat[uf] += nh;
    for (let k = lv + 1; k < 5; k++) devAcc[k][ancL[k]] += nh;
  }
  // Variância total: ruído das seções + erro da média dos grupos usados + desvios não observados.
  // Os desvios não observados se dividem em uma parte independente (1 - rho) e uma parte
  // comum a tudo o que foi projetado a partir do mesmo grupo (rho): a ordem de apuração não
  // é aleatória, então os filhos não apurados de um grupo tendem a desviar no mesmo sentido.
  const rho = P.biasCorr;
  const tauBelow = [0, 0, 0, 0, 0];
  for (let lv = 3; lv >= 0; lv--) tauBelow[lv] = tauBelow[lv + 1] + tau[lv + 1];
  let varTot = varSec;
  const meanVar = (lv, g) => { const v = within(lv, g); return isNaN(v) ? natWithin : v / cnt[lv][g]; };
  const ufOf = (lv, g) => { for (; lv > 1; lv--) g = parent[lv][g]; return g; };
  for (let lv = 1; lv < 5; lv++) {
    const ua = useAcc[lv], da = devAcc[lv];
    for (let g = 0; g < nG[lv]; g++) {
      let add = 0;
      if (ua[g] > 0) add += ua[g] * ua[g] * (meanVar(lv, g) + rho * tauBelow[lv]);
      if (da[g] > 0) add += da[g] * da[g] * (1 - rho) * tau[lv];
      if (!add) continue;
      varTot += add;
      ufVar[ufOf(lv, g)] += add;
    }
  }
  const natU = useAcc[0][0], natV = meanVar(0, 0) + rho * tauBelow[0];
  varTot += natU * natU * natV;
  for (let u = 0; u < nG[1]; u++) ufVar[u] += ufNat[u] * ufNat[u] * natV;

  const Lc = L[0][0], Vc = W[0][0];
  const Vt = Vc + Vrem;
  const share = (Lc + Lrem) / Vt;
  const se = Math.sqrt(varTot) / Vt;
  const ufs = [];
  for (let u = 0; u < nG[1]; u++) {
    const vt = W[1][u] + ufVrem[u];
    ufs.push({
      counted: C1[1][u] / t1Tot[1][u],
      sections: cnt[1][u] / secTot[1][u],
      raw: W[1][u] > 0 ? L[1][u] / W[1][u] : NaN,
      share: vt > 0 ? (L[1][u] + ufLrem[u]) / vt : NaN,
      se: vt > 0 ? Math.sqrt(ufVar[u]) / vt : NaN,
    });
  }
  return {
    time,
    done: A.done,
    sections: A.done / N,
    lulaVotes: Lc, bolsoVotes: Vc - Lc,
    aptosLeft: A.aptosLeft,
    votesFrac: C1[0][0] / t1Tot[0][0],
    raw: Lc / Vc,
    share, se, lo: share - z * se, hi: share + z * se,
    pWin: normCdf((share - 0.5) / Math.max(se, 1e-9)),
    levelMix: levelVotes.map((v) => (Vrem > 0 ? v / Vrem : 0)),
    remaining: Vrem / Vt,
    tau: tau.map(Math.sqrt), sigSec: Math.sqrt(sigSec),
    ufs,
  };
}
