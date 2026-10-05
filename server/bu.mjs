// Leitura do Boletim de Urna (BU) publicado pelo TSE (arquivo -bu.dat, BER/DER).
// O arquivo é um envelope cuja última parte é um OCTET STRING com o BU em si. Sem o esquema
// ASN.1 oficial à mão, a leitura segue a estrutura observada nos BUs de 2026:
//   envelope.identificacao [0] { { município, zona }, local, seção }
//   BU.resultadosVotacaoPorEleicao: { idEleicao, qtdEleitoresAptos, ..., resultadosVotacao }
//   resultadosVotacao: { tipoCargo, qtdComparecimento, totaisVotosCargo }
//   totaisVotosCargo: { [1] códigoCargo, ordem, votosVotaveis }
//   voto: { [1] tipoVoto, [2] quantidade, [3] { partido, número }?, ... }
// tipoVoto: 1 nominal, 2 branco, 3 nulo, 4 legenda (este último não existe para presidente).

function tlv(b, i) {
  const t = b[i++];
  const cls = t >> 6, cons = (t >> 5) & 1;
  let tag = t & 31;
  if (tag === 31) { tag = 0; let x; do { x = b[i++]; tag = (tag << 7) | (x & 127); } while (x & 128); }
  let len = b[i++];
  if (len & 128) { const n = len & 127; len = 0; for (let k = 0; k < n; k++) len = len * 256 + b[i++]; }
  return { cls, cons, tag, v: b.subarray(i, i + len), end: i + len };
}
function children(b) {
  const out = [];
  for (let i = 0; i < b.length; ) { const c = tlv(b, i); out.push(c); i = c.end; }
  return out;
}
const int = (v) => { let n = v[0] & 128 ? -1 : 0; for (const x of v) n = n * 256 + x; return n; };
const isInt = (c) => c.cls === 0 && c.tag === 2;
const ctx = (c, tag) => c.cls === 2 && c.tag === tag;

// Busca em profundidade o primeiro nó construído que satisfaz `pred(filhos)`
function find(nodes, pred) {
  for (const n of nodes) {
    if (!n.cons) continue;
    const ks = children(n.v);
    if (pred(ks)) return ks;
    const r = find(ks, pred);
    if (r) return r;
  }
  return null;
}

// Retorna { municipio, zona, local, secao, aptos, comparecimento, votos: { "13": n, ... }, branco, nulo }
// para o cargo `cargo` (1 = Presidente) da eleição `eleicao`.
export function readBU(buf, { eleicao, cargo = 1 }) {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const env = children(children(b)[0].v);
  const id = env.find((c) => ctx(c, 0) && c.cons);
  const inner = env.find((c) => c.cls === 0 && c.tag === 4);
  if (!inner) throw new Error("BU sem conteúdo");
  const idk = children(id.v);
  const munZona = children(idk[0].v);
  const out = {
    municipio: int(munZona[0].v), zona: int(munZona[1].v),
    local: int(idk[1].v), secao: int(idk[2].v),
    aptos: null, comparecimento: null, votos: {}, branco: 0, nulo: 0,
  };
  const bu = children(inner.v);
  // Resultado da eleição: SEQUENCE que começa com INTEGER idEleicao seguido de INTEGER aptos
  const porEleicao = find(bu, (ks) => ks.length >= 3 && isInt(ks[0]) && int(ks[0].v) === eleicao && isInt(ks[1]));
  if (!porEleicao) throw new Error(`eleição ${eleicao} ausente no BU`);
  out.aptos = int(porEleicao[1].v);
  // Totais do cargo: SEQUENCE { [1] códigoCargo == cargo, INTEGER ordem, SEQUENCE votos }
  const totais = find(porEleicao, (ks) => {
    const ok = ks.length >= 3 && ctx(ks[0], 1) && !ks[0].cons && int(ks[0].v) === cargo && isInt(ks[1]) && ks[2].cons;
    return ok;
  });
  if (!totais) throw new Error(`cargo ${cargo} ausente no BU`);
  // Comparecimento: bloco { ENUMERATED tipoCargo, INTEGER qtdComparecimento, ... } da eleição;
  // é o mesmo para todos os cargos de uma eleição
  const resultado = find(porEleicao, (ks) => ks.length >= 3 && ks[0].cls === 0 && ks[0].tag === 10 && isInt(ks[1]));
  for (const voto of children(totais[2].v)) {
    const ks = children(voto.v);
    const tipo = ks.find((k) => ctx(k, 1)), qtd = ks.find((k) => ctx(k, 2)), ident = ks.find((k) => ctx(k, 3) && k.cons);
    const n = int(qtd.v), t = int(tipo.v);
    if (t === 1 && ident) { const num = String(int(children(ident.v)[1].v)); out.votos[num] = (out.votos[num] ?? 0) + n; }
    else if (t === 2) out.branco += n;
    else if (t === 3) out.nulo += n;
  }
  out.comparecimento = resultado ? int(resultado[1].v) : Object.values(out.votos).reduce((a, x) => a + x, out.branco + out.nulo);
  return out;
}
