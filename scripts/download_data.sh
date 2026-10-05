#!/usr/bin/env bash
# Baixa para data/ os arquivos brutos do TSE lidos por scripts/prepare_data.py.
# Cerca de 500 MB de download e 3,7 GB descompactados. Arquivos já presentes são pulados.
set -euo pipefail

DATA="$(cd "$(dirname "$0")/.." && pwd)/data"
BASE="https://cdn.tse.jus.br/estatistica/sead/odsele"
mkdir -p "$DATA"

fetch() { # url, pasta de destino, arquivo que indica que já foi feito
  local url="$1" dest="$2" done="$3" zip
  if compgen -G "$done" > /dev/null; then echo "✓ $(basename "$url") já descompactado"; return; fi
  zip="$DATA/$(basename "$url")"
  echo "↓ $url"
  # A CDN do TSE às vezes derruba downloads longos: retoma de onde parou
  local try
  for try in 1 2 3 4 5; do
    curl -fL --progress-bar -C - -o "$zip" "$url" && break
    [ "$try" = 5 ] && { echo "✗ falha no download: $url" >&2; exit 1; }
    echo "  conexão caiu, retomando ($try/5)…"; sleep 2
  done
  unzip -oq "$zip" -d "$dest"
  rm "$zip"
}

# Votos por seção, 1º e 2º turno (presidente)
fetch "$BASE/votacao_secao/votacao_secao_2022_BR.zip" "$DATA" "$DATA/votacao_secao_2022_BR.csv"
# Detalhe por seção: eleitores aptos e horário de entrada de cada seção na totalização
fetch "$BASE/detalhe_votacao_secao/detalhe_votacao_secao_2022.zip" "$DATA/detalhe_secao" "$DATA/detalhe_secao/*.csv"

echo "Pronto. Próximo passo: uv run scripts/prepare_data.py"
