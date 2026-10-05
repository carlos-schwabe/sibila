# Sibila

Acompanhamento e projeção ao vivo do 2º turno presidencial a partir da apuração parcial do TSE.

A apuração parcial é uma amostra viesada: regiões menos desenvolvidas demoram mais para apurar. A Sibila projeta cada seção ainda não apurada a partir do seu próprio resultado no 1º turno e da variação entre turnos das seções já apuradas perto dela, e mostra o resultado final com intervalo de confiança e a situação da disputa: indefinida, provável vencedor ou eleito.

## Páginas

- `/`: acompanhamento ao vivo, com o que o coletor grava durante a apuração. Antes da eleição, mostra a espera e se a API do TSE está respondendo.
- `/demo/`: reproduz o 2º turno de 2022 na ordem real de apuração, com um controle que define até onde a apuração chegou.
- `/backtest.html`: o backtest de 2022 com todos os parâmetros ajustáveis.

## Como rodar

Node 20 ou mais novo, sem dependências.

```sh
npm start                          # página + coletor em http://localhost:8080 (ver "Deploy")
cd app && python3 -m http.server   # só a página, lendo o que estiver em app/live/
```

## Como funciona

**Estimador swing.** Para cada seção ainda não apurada, a projeção é o % de Lula da própria seção no 1º turno somado à variação média entre turnos (o *swing*) das seções já apuradas da área mais próxima com dados suficientes. A ordem de apuração não é aleatória, mas quase tudo o que a distingue já está no resultado do 1º turno; o swing varia muito menos entre seções do que o voto. O tamanho esperado da seção é o número de votos do 1º turno vezes a razão entre votos válidos do 2º turno e votos do 1º turno na mesma área, o que absorve mudanças de abstenção, brancos e nulos.

**Hierarquia.** A área usada é a mais fina que passa os limiares (local de votação → zona → município → UF), com o Brasil como último recurso. Os limiares são um % mínimo dos votos esperados já apurados e um número mínimo de seções (`DEFAULT_PROJ` em `app/engine.js`).

**Intervalo.** A variância soma o ruído entre seções, o erro amostral da média da área usada e a variância entre áreas de cada nível que a projeção pula (um município projetado pelo seu estado carrega a variação entre municípios do estado, e assim por diante). Os desvios de um nível são estimados nos dados apurados, descontado o ruído amostral. Como a ordem de apuração não é aleatória, metade da variância dos níveis pulados é tratada como um viés comum a tudo o que foi projetado a partir da mesma área (`biasCorr = 0.5`). O intervalo usa a aproximação normal.

**Situação da disputa.** *Indefinida* enquanto nenhum candidato tiver 99,9% de probabilidade de vitória pela projeção; *provável vencedor* a partir daí; *eleito* quando a vantagem em votos supera o número de eleitores aptos que ainda faltam apurar, o que não depende do modelo.

**"Margem de erro".** Na tabela por estado, a meia-largura do intervalo de 95% aparece como "margem de erro". Sabemos que não é a margem de erro de uma pesquisa; é licença poética, porque é o termo que todo mundo entende.

## Backtest de 2022

Reprodução do 2º turno de 30/10/2022 na ordem real em que as seções entraram na totalização do TSE (`DT_PRIM_TOT_PARCIAL_HOR_TSE`), com os parâmetros padrão. Resultado final: Lula com 50,90% dos votos válidos.

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
- Projetar direto o % de votos da área, sem o 1º turno (`estimator: "share"`), é bem pior: cobertura de 70% e primeira definição só com 76,9% apurado.

`node scripts/backtest.mjs` reproduz a tabela (aceita um JSON com parâmetros, por exemplo `'{"estimator":"share"}'`).

## Noite da eleição

A API de divulgação do TSE (`resultados.tse.jus.br`) só publica o estado atual da apuração, então o coletor (`server/poller.mjs`) grava a evolução da noite. Os votos por seção só existem dentro dos boletins de urna; ao vivo, o coletor trabalha com o que os arquivos JSON trazem: totais por UF e por zona, e a lista de seções que já chegaram. A cada ciclo de 10 s ele:

1. baixa até 100 arquivos de zona, das zonas com mais seções que o último arquivo baixado ainda não incluía;
2. baixa os totais de cada UF;
3. baixa a lista de seções de cada UF. Vem por último: uma seção aparece na lista antes de ser totalizada, então a lista mais nova contém todas as seções que os arquivos de resultado já somaram;
4. roda a projeção e publica `latest.json` (o ponto atual e a tabela por UF) e `history.json` (a curva da noite, em colunas, com no máximo 600 pontos).

Os votos de cada UF que nenhuma zona baixada cobre entram como um resíduo da UF, comparado ao 1º turno exatamente das seções que contém. Antes da primeira seção apurada, o coletor só consulta o arquivo do Brasil a cada 30 s, para não gerar 404 (o TSE bloqueia IPs com muitos). Todas as requisições passam por um semáforo (`server/rate-limit.mjs`): no máximo 90 por segundo em qualquer janela de 1 s, o TSE bloqueia acima de 100, e pausa geral se o TSE sinalizar bloqueio.

Simulação do coletor na noite de 2022 (`node scripts/backtest_feed.mjs`); em todos os modos o intervalo cobriu o resultado em 100% dos instantes até 99,9% apurado, sem nenhuma definição errada:

| Votos baixados | Requisições/s (média) | Primeira definição | Intervalo com 50% apurado |
|---|---|---|---|
| Só UF (`ZONAS=0`) | 5,6 | 35,4% apurado, 18:10 | ± 0,44 pp |
| Híbrido, 10 zonas por ciclo | 6,2 | 20,8% apurado, 17:50 | ± 0,25 pp |
| **Híbrido, 100 zonas por ciclo (padrão)** | 8,7 | 20,8% apurado, 17:50 | ± 0,19 pp |
| Todas as zonas que mudaram | 9,7 | 20,8% apurado, 17:50 | ± 0,19 pp |

Para testar de ponta a ponta, `server/replay-server.mjs` reproduz 2022 no formato da divulgação de 2026, num relógio acelerado e com o mesmo limite de requisições do TSE:

```sh
node server/replay-server.mjs --speed 30
TSE_BASE=http://localhost:8787/oficial PLEITO=9999 ELEICAO=9998 DIA=30/10/2022 DATA_DIR=app/data/ INTERVALO=2 npm start
```

## Variância a priori

Com votos só por UF ou por zona, a variação do swing dentro das áreas não é observada ao vivo; ela vem de uma eleição anterior com os dois turnos (`node scripts/estimate_prior.mjs <base>`). Desvio-padrão do swing em cada nível, em pontos percentuais:

| Nível | 2014 | 2018 | 2022 |
|---|---|---|---|
| UF | 5,54 | 5,88 | 1,39 |
| Município | 4,68 | 4,18 | 1,49 |
| Zona | 2,21 | 1,28 | 0,38 |
| Local de votação | 2,37 | 2,18 | 0,69 |
| Seção | 2,89 | 3,19 | 2,07 |
| *Votos dos dois finalistas no 1º turno* | *75,1%* | *75,3%* | *91,6%* |

O swing é a redistribuição dos votos dos candidatos eliminados, e varia muito mais quando eles somavam um quarto do eleitorado (2014, 2018). Em 2026 os dois finalistas tiveram 92,2% no 1º turno, como em 2022, e por isso a priori padrão é a de 2022. No modo híbrido ela só pesa dentro das zonas; da zona para cima tudo é medido ao vivo.

## Base do 1º turno

A projeção precisa do resultado do 1º turno por seção. Também testamos qual medida do 1º turno torna o swing mais estável (desvio-padrão do swing entre seções, em pp):

| Base do 1º turno | 2014 | 2018 | 2022 |
|---|---|---|---|
| Lula / todos os votos, com brancos e nulos (atual) | 8,45 | 8,50 | 3,15 |
| Lula / votos válidos | 7,98 | 8,41 | 2,82 |
| Lula / (Lula + adversário) | 5,95 | 6,40 | 2,20 |

Medir o 1º turno só entre os dois finalistas reduz a variação em cerca de 30% nas três eleições. A troca ainda não foi feita: precisa guardar os votos do adversário no 1º turno por seção e confirmar no backtest.

## Dados

**2022 (backtest e demonstração).** `app/data/` guarda os dados preparados, uma linha por seção, e está no repositório. Para recriá-los a partir do [portal de dados abertos do TSE](https://dadosabertos.tse.jus.br/dataset/resultados-2022):

```sh
scripts/download_data.sh          # votacao_secao_2022_BR e detalhe_votacao_secao_2022 em data/
uv run scripts/prepare_data.py    # gera app/data/
```

`prepare_data.py` também prepara outros anos (`--csv`, `--cand-b`, `--out`, `--sem-detalhe`), como 2018 e 2014 para a variância a priori.

**2026 (base do 2º turno).** Enquanto os dados abertos consolidados do 1º turno não saem, a base vem da própria API de divulgação: para cada seção, o arquivo auxiliar aponta o boletim de urna, que `server/bu.mjs` decodifica (ASN.1). São ~1 milhão de requisições, ~3,5 horas a 80 por segundo, e o download pode ser retomado. No Acre, a soma dos boletins bateu exatamente com o total oficial do TSE.

```sh
node scripts/fetch_baseline.mjs --rps 80   # boletins do 1º turno em data/api-p3220/
node scripts/build_baseline.mjs            # gera app/data-2026/ (sections.bin, meta.json)
```

## Deploy (Railway)

Um único serviço Node (`npm start`, que roda `server/main.mjs`) serve a página e roda o coletor no mesmo processo. Os leitores nunca chegam à API do TSE:

- os arquivos ficam em memória, comprimidos, com ETag (304 quando não mudaram);
- `latest.json` e `history.json` são trocados a cada ciclo e têm cache de 5 s com `stale-while-revalidate`; a página baixa a curva ao abrir e depois só `latest.json`;
- os códigos do pleito do 2º turno são descobertos sozinhos no `ele-c.json` do TSE pela data da eleição; até lá a página mostra a espera;
- `/healthz` informa a fase, a base usada, a última atualização e a saúde da conexão com o TSE.

Passos:

1. Crie um projeto no Railway a partir deste repositório. `railway.json` define o comando, o health check (`/healthz`) e o reinício automático.
2. Adicione um volume ao serviço (por exemplo em `/data`). O coletor grava ali o histórico da noite e retoma de onde parou se o serviço reiniciar; sem volume, um reinício perde a curva.
3. Disponibilize a base do 1º turno de 2026: publique `app/data-2026/sections.bin` e `meta.json` em algum endereço (por exemplo como arquivos de um release do GitHub) e defina `BASELINE_URL`, ou deixe `app/data-2026/` no repositório. Sem base de 2026, o serviço usa a de 2022 e avisa no log.
4. Gere um domínio público para o serviço e confira `/healthz`: `tse.ok` deve ser `true`.
5. Antes da eleição, coloque o Cloudflare na frente: com o cache de 5 s dos JSON, recarregamentos em massa são respondidos pela CDN.

Variáveis de ambiente, todas opcionais:

| Variável | Padrão | Para quê |
|---|---|---|
| `DIA` | `25/10/2026` | data da eleição; com ela o serviço descobre os códigos do pleito |
| `TURNO` | `2` | turno a acompanhar |
| `PLEITO`, `ELEICAO` | descobertos | códigos do TSE, se preferir fixar |
| `BASELINE_URL` | — | endereço com `sections.bin` e `meta.json` da base do 1º turno |
| `DATA_DIR` | — | pasta da base, se já estiver no disco |
| `LIVE_DIR` | volume ou `app/live/` | onde o coletor grava o estado |
| `ZONAS`, `RPS`, `INTERVALO` | `100`, `30`, `10` | arquivos de zona por ciclo, requisições por segundo (teto de 90), segundos por ciclo |
| `TSE_BASE` | `https://resultados.tse.jus.br/oficial` | endereço da divulgação (para testes com o servidor de reprodução) |

## Estrutura

```
app/                 página (estática)
  index.html, demo/  acompanhamento ao vivo e demonstração
  app.js, style.css  interface
  engine.js          motor de projeção, usado pela página e pelo servidor
  worker.js          roda o motor fora da thread principal na demonstração e no backtest
  backtest.html      backtest interativo de 2022
  data/              base de 2022 por seção
server/
  main.mjs           servidor de produção: página + coletor
  poller.mjs         coletor da divulgação do TSE
  tse-client.mjs     cliente do TSE com semáforo e medição de saúde
  rate-limit.mjs     semáforo de requisições
  tse-format.mjs     nomes de arquivo e leitura dos JSON do TSE
  bu.mjs             leitura dos boletins de urna
  replay-server.mjs  reprodução de 2022 no formato de 2026, para testes
scripts/             preparo de dados, backtests e estimativas
```

---

Desenvolvido por [Carlos Schwabe](https://github.com/carlos-schwabe).
