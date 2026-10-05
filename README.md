# Sibila

Projeção ao vivo do 2º turno presidencial a partir da apuração parcial. Regiões menos desenvolvidas demoram mais para apurar, então a contagem parcial é uma amostra viesada. A Sibila projeta cada seção ainda não apurada a partir da área mais específica com dados suficientes e mostra o resultado final com intervalo de confiança e a situação da disputa.

## Como rodar

```sh
cd app && python3 -m http.server
```

- `http://localhost:8000/`: visão ao vivo. Em modo DEV reproduz 2022, com um controle que define até onde a apuração chegou.
- `http://localhost:8000/backtest.html`: backtest completo de 2022, com todos os parâmetros ajustáveis.

## Como funciona

- **Hierarquia.** Para cada local de votação com seções não apuradas, o motor usa a população mais fina que passa os limiares (local de votação → zona → município → UF), com o Brasil como último recurso. Os limiares são um % mínimo dos votos esperados já apurados e um número mínimo de seções (`DEFAULT_PROJ` em `app/engine.js`).
- **Estimador swing (padrão).** O % de Lula numa seção não apurada = o % de Lula da própria seção no 1º turno + a variação média da população entre os turnos. O tamanho esperado = votos do 1º turno × a taxa de comparecimento da população.
- **Intervalo.** Ruído entre seções + erro amostral da média de cada população + a variância entre áreas de cada nível que a projeção pula. Metade dessa variância é tratada como um viés comum a cada população (`biasCorr = 0.5`), porque a ordem de apuração não é aleatória.
- **"Margem de erro".** Na tabela por estado, a meia-largura do intervalo de 95% aparece como "margem de erro". Sabemos que não é a mesma coisa que a margem de erro de uma pesquisa; é licença poética, porque é o termo que todo mundo entende.
- **Situação da disputa.** *Indefinida* até um candidato chegar a 99,9% de probabilidade. *Provável vencedor* a partir daí. *Eleito* quando a vantagem supera o número de eleitores aptos ainda não apurados.

## Backtest de 2022

O backtest reproduz o 2º turno de 30/10/2022 na ordem real em que as seções entraram na totalização do TSE (`DT_PRIM_TOT_PARCIAL_HOR_TSE`), com os parâmetros padrão. Resultado final: Lula com 50,90% dos votos válidos.

| Apurado | Horário | Apuração (Lula) | Projeção (IC 95%) | Erro |
|---|---|---|---|---|
| 5% | 17:25 | 46,97% | 50,68% ± 2,02 | −0,22 pp |
| 10% | 17:33 | 47,98% | 50,50% ± 1,64 | −0,40 pp |
| 25% | 17:55 | 48,74% | 50,89% ± 0,49 | −0,01 pp |
| 50% | 18:26 | 49,70% | 50,99% ± 0,19 | +0,09 pp |
| 75% | 18:51 | 50,17% | 50,94% ± 0,05 | +0,04 pp |
| 90% | 19:10 | 50,53% | 50,92% ± 0,02 | +0,01 pp |

- O intervalo de 95% conteve o resultado final em **100%** dos 1.000 instantes avaliados.
- **Primeira definição (99,9%): Lula com 19,4% apurado, às 17:48.** A apuração só virou de vez para Lula com 67,6% (18:43). Em nenhum instante a projeção apontou o vencedor errado.
- Matematicamente definido com 98,8% apurado, às 19:56.
- O estimador simples por % de votos (`estimator: "share"`) é bem mais fraco: cobertura de 70% e primeira definição só com 76,9% apurado.

Para reproduzir: `node scripts/backtest.mjs` (aceita um JSON para sobrescrever parâmetros, por exemplo `'{"estimator":"share"}'`).

## Dados

`app/data/` guarda os dados de 2022 já preparados (uma linha por seção) e está no repositório. Para recriá-los a partir do [portal de dados abertos do TSE](https://dadosabertos.tse.jus.br/dataset/resultados-2022):

```sh
scripts/download_data.sh          # votacao_secao_2022_BR e detalhe_votacao_secao_2022 em data/
uv run scripts/prepare_data.py    # gera app/data/
```

## Situação para 2026

A visão ao vivo roda sobre a reprodução de 2022 (`DEV = true` em `app/index.html`). Para a noite do 2º turno ainda faltam:

- os resultados do 1º turno de 2026 por seção, que são a base do swing;
- um adaptador que alimente o motor com os resultados ao vivo do TSE.
