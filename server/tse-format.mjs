// Nomes de arquivo e leitura dos JSON da divulgação de resultados do TSE (especificações
// EA16 e EA20 de 2026). Compartilhado pelo coletor (poller.mjs) e pelo servidor de
// reprodução de 2022 (replay-server.mjs).

const pad = (n, k) => String(n).padStart(k, "0");

export function paths({ ciclo, pleito, eleicao }) {
  const e6 = pad(eleicao, 6), p6 = pad(pleito, 6);
  return {
    // EA16: seções de uma UF e o horário em que cada uma chegou
    secoes: (uf) => `/${ciclo}/arquivo-urna/${pleito}/config/${uf}/${uf}-p${p6}-cs.json`,
    // EA20 por UF, por zona e do Brasil, cargo Presidente (c0001)
    uf: (uf) => `/${ciclo}/${eleicao}/dados/${uf}/${uf}-c0001-e${e6}-u.json`,
    zona: (uf, mun, zona) => `/${ciclo}/${eleicao}/dados/${uf}/${uf}${pad(mun, 5)}-z${pad(zona, 4)}-c0001-e${e6}-u.json`,
    brasil: () => `/${ciclo}/${eleicao}/dados/br/br-c0001-e${e6}-u.json`,
    // EA12: municípios da eleição (nomes e zonas)
    municipios: () => `/${ciclo}/${eleicao}/config/mun-e${e6}-cm.json`,
    // EA18: arquivo auxiliar de uma seção, que lista os arquivos da urna (BU, RDV, log)
    aux: (uf, mun, zona, secao) => `/${ciclo}/arquivo-urna/${pleito}/dados/${uf}/${pad(mun, 5)}/${pad(zona, 4)}/${pad(secao, 4)}/p${p6}-${uf}-m${pad(mun, 5)}-z${pad(zona, 4)}-s${pad(secao, 4)}-aux.json`,
    // arquivo da urna citado no aux (por exemplo o BU), dentro da pasta do hash
    urna: (uf, mun, zona, secao, hash, nome) => `/${ciclo}/arquivo-urna/${pleito}/dados/${uf}/${pad(mun, 5)}/${pad(zona, 4)}/${pad(secao, 4)}/${hash}/${nome}`,
  };
}

// Número no formato do TSE ("1234" ou "50,90") para Number
export const num = (s) => Number(String(s ?? "0").replace(",", "."));

// Votos por número de candidato num arquivo EA20
export function candidateVotes(ea20) {
  const out = {};
  for (const cargo of ea20.carg ?? []) {
    for (const agr of cargo.agr ?? []) {
      for (const par of agr.par ?? []) {
        for (const c of par.cand ?? []) out[c.n] = num(c.vap);
      }
    }
  }
  return out;
}

// "30/10/2022" + "18:43:12" -> minutos após as 17:00 daquele dia (passa da meia-noite se preciso)
export function minutesAfter17(da, ha, day) {
  const [h, m, s] = ha.split(":").map(Number);
  const dayShift = da === day ? 0 : 24 * 60;
  return h * 60 + m + s / 60 - 17 * 60 + dayShift;
}
