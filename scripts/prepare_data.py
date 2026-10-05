# /// script
# requires-python = ">=3.11"
# dependencies = ["duckdb"]
# ///
"""Compacta os CSVs por seção do TSE em um arquivo binário para o app de projeção.

Uma linha por seção que votou no 2º turno (presidente), ordenada por
UF > município > zona > local de votação > seção.

Layout de sections.bin (little-endian, N = número de seções):
  Uint32[N] índice do local de votação
  Uint32[N] segundos após as 17:00 em que a seção entrou na totalização (ordem real de apuração)
  Uint16[N] total de votos no 1º turno   (tamanho esperado, conhecido antes do 2º turno)
  Uint16[N] votos de Lula no 1º turno    (base do estimador swing)
  Uint16[N] votos de Lula no 2º turno
  Uint16[N] votos de Bolsonaro no 2º turno
  Uint16[N] eleitores aptos (teto para os votos que ainda faltam)
  Uint16[N] número da seção
meta.json guarda a hierarquia (local -> zona -> município -> UF), os nomes e os códigos do TSE
(município com 5 dígitos e número da zona), usados para casar com os arquivos ao vivo.
"""
import json
import struct
from pathlib import Path

import duckdb

ROOT = Path(__file__).resolve().parent.parent
CSV = ROOT / "data" / "votacao_secao_2022_BR.csv"
# Detalhe por seção: eleitores aptos e horários de totalização (detalhe_votacao_secao_2022.zip)
DETAIL = ROOT / "data" / "detalhe_secao" / "*.csv"
OUT = ROOT / "app" / "data"

def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    con = duckdb.connect()
    con.execute(f"""
        create table raw as
        select NR_TURNO::int turno, SG_UF uf, CD_MUNICIPIO::int muni, NM_MUNICIPIO muni_name,
               NR_ZONA::int zona, NR_SECAO::int secao, NR_LOCAL_VOTACAO::int lv,
               NR_VOTAVEL::int votavel, QT_VOTOS::int votos
        from read_csv('{CSV}', delim=';', header=true, encoding='latin-1', all_varchar=true)
        where CD_CARGO = '1'
    """)
    rows = con.execute(f"""
        with t2 as (
            select uf, muni, any_value(muni_name) muni_name, zona, any_value(lv) lv, secao,
                   sum(votos) filter (votavel = 13) lula, sum(votos) filter (votavel = 22) bolso
            from raw where turno = 2 group by uf, muni, zona, secao
        ), det as (
            -- cada seção aparece duas vezes, com linhas idênticas
            select distinct SG_UF uf, CD_MUNICIPIO::int muni, NR_ZONA::int zona, NR_SECAO::int secao, QT_APTOS::int aptos,
                   epoch(strptime(DT_PRIM_TOT_PARCIAL_HOR_TSE, '%d/%m/%Y %H:%M:%S') - timestamp '2022-10-30 17:00:00')::int sec
            from read_csv('{DETAIL}', delim=';', header=true, encoding='latin-1', all_varchar=true, union_by_name=true)
            where NR_TURNO = '2' and CD_CARGO = '1'
        ), t1 as (
            select uf, muni, zona, secao, sum(votos) total, sum(votos) filter (votavel = 13) lula
            from raw where turno = 1 group by uf, muni, zona, secao
        )
        select t2.uf, t2.muni, t2.muni_name, t2.zona, t2.lv, t2.secao,
               coalesce(t1.total, 0), coalesce(t1.lula, 0), coalesce(t2.lula, 0), coalesce(t2.bolso, 0),
               det.aptos, det.sec
        from t2 left join t1 using (uf, muni, zona, secao) join det using (uf, muni, zona, secao)
        order by t2.uf, t2.muni, t2.zona, t2.lv, t2.secao
    """).fetchall()

    ufs, munis, zones, locals_ = [], [], [], []
    uf_idx, muni_idx, zone_idx, local_idx = {}, {}, {}, {}
    sec_local, arrival, t1tot, t1lula, lula, bolso, aptos, secnr = [], [], [], [], [], [], [], []
    zone_nr = []
    for uf, muni, muni_name, zona, local, secao, tt, tl, l, b, ap, sec in rows:
        if uf not in uf_idx:
            uf_idx[uf] = len(ufs)
            ufs.append(uf)
        mk = (uf, muni)
        if mk not in muni_idx:
            muni_idx[mk] = len(munis)
            munis.append([muni_name, uf_idx[uf], f"{muni:05d}"])
        zk = (uf, muni, zona)
        if zk not in zone_idx:
            zone_idx[zk] = len(zones)
            zones.append(muni_idx[mk])
            zone_nr.append(zona)
        lk = (uf, muni, zona, local)
        if lk not in local_idx:
            local_idx[lk] = len(locals_)
            locals_.append(zone_idx[zk])
        sec_local.append(local_idx[lk])
        t1tot.append(min(tt, 65535)); t1lula.append(min(tl, 65535))
        lula.append(l); bolso.append(b); aptos.append(min(ap, 65535)); arrival.append(sec)
        secnr.append(secao)

    n = len(sec_local)
    with open(OUT / "sections.bin", "wb") as f:
        f.write(struct.pack(f"<{n}I", *sec_local))
        f.write(struct.pack(f"<{n}I", *arrival))
        for arr in (t1tot, t1lula, lula, bolso, aptos, secnr):
            f.write(struct.pack(f"<{n}H", *arr))
    meta = {
        "nSections": n,
        "ufs": ufs,
        "munis": munis,
        "zoneMuni": zones,
        "zoneNr": zone_nr,
        "localZone": locals_,
        "final": {"lula": sum(lula), "bolso": sum(bolso)},
    }
    (OUT / "meta.json").write_text(json.dumps(meta, ensure_ascii=False, separators=(",", ":")))
    print(f"{n} sections, {len(locals_)} places, {len(zones)} zones, {len(munis)} munis, {len(ufs)} UFs")
    print(f"Lula {sum(lula)}  Bolsonaro {sum(bolso)}  share {sum(lula)/(sum(lula)+sum(bolso)):.4%}")


if __name__ == "__main__":
    main()
