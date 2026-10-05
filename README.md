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

## Noite da eleição

A API de divulgação do TSE (`resultados.tse.jus.br`) só publica o estado atual da apuração, então o coletor grava a evolução da noite. A cada ciclo (10 s) ele:

1. baixa a lista de seções de cada UF e vê quais já chegaram;
2. baixa até 100 arquivos de zona, das zonas com mais seções que o último arquivo baixado ainda não incluía;
3. baixa os totais de cada UF;
4. roda a projeção e grava `app/live/history.json` e `app/live/latest.json`, que a página lê em `/#live`.

Os votos de cada UF que nenhuma zona baixada cobre entram como um resíduo da UF, comparado ao 1º turno exatamente das seções que contém. Todas as requisições passam por um semáforo: no máximo 90 por segundo em qualquer janela de 1 s (o TSE bloqueia acima de 100) e pausa geral se o TSE sinalizar bloqueio.

```sh
node server/poller.mjs --pleito <código do 2º turno> --eleicao 6258 --dia 25/10/2026
```

Simulação do coletor na noite de 2022 (`node scripts/backtest_feed.mjs`), com o intervalo cobrindo o resultado em 100% dos instantes até 99,9% apurado em todos os modos:

| Votos baixados | Requisições/s (média) | Primeira definição | Intervalo com 50% apurado |
|---|---|---|---|
| Só UF (`--zonas 0`) | 5,6 | 35,4% apurado, 18:10 | ± 0,44 pp |
| Híbrido, 10 zonas por ciclo | 6,2 | 20,8% apurado, 17:50 | ± 0,25 pp |
| Híbrido, 100 zonas por ciclo (padrão) | 8,7 | 20,8% apurado, 17:50 | ± 0,19 pp |
| Todas as zonas que mudaram | 9,7 | 20,8% apurado, 17:50 | ± 0,19 pp |

Para testar de ponta a ponta, `server/replay-server.mjs` reproduz 2022 no formato de 2026, num relógio acelerado e com o mesmo limite de requisições do TSE:

```sh
node server/replay-server.mjs --speed 30
node server/poller.mjs --base http://localhost:8787/oficial --pleito 9999 --eleicao 9998 --dia 30/10/2022 --intervalo 2
```

## Situação para 2026

A visão ao vivo e o coletor estão prontos e foram testados contra a API real (1º turno de 2026). Para a noite do 2º turno ainda faltam:

- os resultados do 1º turno de 2026 por seção (dados abertos do TSE), que são a base do swing e cobrem as ~38 mil seções de 2026 que não existiam em 2022;
- o código do pleito do 2º turno, que o TSE publica em `ele-c.json`;
- onde rodar o coletor e servir `app/`.
