# Determinismo entre plataformas (EDT-13)

Medido em 2026-11-24, modo `software` (SwiftShader), Chrome headless shell 158.0.8127.36 e FFmpeg
`n8.1.3-39-g660b5aa7db` nos dois lados, **na mesma CPU** (AMD Ryzen 5 5600X): o Linux é um contêiner Docker
(`node:24-bookworm`, WSL2) nesta máquina Windows. A limitação declarada é essa: o contêiner não prova nada sobre
outra CPU. Reproduzir: `node scripts/compare-goldens.ts` (Windows) e `node scripts/linux/gate.ts --goldens` (Linux).

## Resultado

Referência: `catalog/goldens/win64/` (gerado no Windows) e `catalog/goldens/linux64/` (gerado no contêiner), 48 blocos × 5 frames = 240 frames cada. As duas primeiras linhas comparam o Linux com o conjunto do Windows (o que motivou um conjunto por plataforma); a conferência de verdade usa o conjunto da própria plataforma.

| plataforma | hash idêntico | só PSNR ≥ 50 dB | falha (PSNR < 50 dB) |
|---|---|---|---|
| Windows x64 | 240 | 0 | 0 |
| Linux x64 (Docker/WSL2) contra `win64` | 0 | 18 | 222 |
| Linux x64 (Docker/WSL2) contra `linux64` (conjunto próprio) | 240 | 0 | 0 |

No Linux, nenhum frame tem o mesmo hash do Windows; 18 passam por PSNR e 222 ficam entre 34,6 e 50 dB
(mediana 42,6 dB). 47 dos 48 blocos têm ao menos um frame reprovado; o único bloco que passa em todos os frames é
`image-frame` (sem texto). Nenhum golden foi regenerado.

## Leitura (hipótese, não medida)

A diferença acompanha texto: o bloco sem texto passa, os blocos de texto ficam em 35–45 dB. O padrão é o de
rasterização de glifos diferente entre o Skia/DirectWrite do Windows e o Skia/FreeType do Linux, mesmo com
`--font-render-hinting=none`, `--disable-lcd-text` e as mesmas fontes (`vendor/fonts` é copiado do checkout, os
mesmos bytes). **Isto é hipótese: não foi medida.** Falta o mapa de diferença por bloco (onde o pixel difere).

## O Linux reproduz a si mesmo? (auto-prova, `scripts/goldens-self-check.ts`)

Captura os 240 frames duas vezes, em processos separados, e compara o hash de cada frame entre as rodadas
(`node scripts/linux/gate.ts --only "node scripts/goldens-self-check.ts"`; sem ler nem gravar goldens).

| configuração (antes da correção abaixo) | rodadas | frames idênticos | divergentes |
|---|---|---|---|
| Linux, concorrência padrão (4 blocos em paralelo), execução A | 2 | 238 de 240 | `subtitles` frames 13 e 40 |
| Linux, concorrência padrão, execução B | 2 | 240 de 240 | — |
| Linux, concorrência 1 (`FRANKFRAMES_GOLDENS_CONCURRENCY=1`) | 2 | 240 de 240 | — |

A divergência de `subtitles` era um defeito do determinismo em `software` (invariante 3), não ruído de plataforma:
mesma máquina, mesmo browser, mesmo bloco, hash diferente conforme a carga. Está investigada e corrigida na seção
seguinte; os números depois da correção estão na seção "Auto-prova depois da correção".

## `subtitles` sob carga (investigação e correção)

**Reprodução.** `node scripts/bench/subtitles-load-lab.ts` captura o bloco N vezes, `--parallel` ao mesmo tempo, sob
`--load` laços de CPU (`for(;;){}`, o mesmo cenário do laboratório do EDT-77) e guarda um PNG por hash distinto.
Sem a correção, no Windows (12 CPUs): paralelo 4 + 10 laços, **29 de 40** capturas divergem da primeira; paralelo 8 + 12
laços, 12 de 32; sem carga e sequencial, 2 de 24. No Linux (contêiner, 8 CPUs), paralelo 4 + 10 laços, 40 capturas: 10 de 40
fora do estado majoritário (7 e 3 em dois outros hashes; 33 de 40 diferem da *primeira* captura, que caiu num estado
minoritário). No Windows aparecem quase só dois estados: A (frame 13 `894eeb1b`,
frame 40 `6e37f698`; é o dos goldens `win64`) e B (13 `0d3a3d42`, 40 `5fd48e5a`).

**Localização.** Os frames são 13 (0,433 s) e 40 (1,333 s) a 30 fps. O DOM e o layout são idênticos nos dois
estados (retângulo de `.c1 .line` 481,6875 × 807,53125, 1018,234 × 104,469, `transform: none`, `opacity: 1`, mesmas 9
animações, todas as fontes carregadas). O mapa de diferença cobre só poucos glifos da legenda `.c1`
(x 718–1391, y 836–876, em três aglomerados): a assinatura de uma fase de subpixel de 1/4 de pixel trocada nos mesmos glifos
(deslocamento de ~1/32 px que cruza a fronteira do bin). Não é palavra acesa contra apagada: o layout é o mesmo e `opacity` é 1 nos dois estados. A entrada `subir` (0,36 s) já
terminou no frame 13 (0,433 s) e `legenda1` (0 a 1,35 s) ainda está no ar no 40 (1,333 s); a diferença não acompanha
nenhuma transição em curso. Os frames 0, 41 e 50 não diferem entre A e B; 5 a 40
diferem.

**Causa medida.** O estado é da **sessão**: uma sessão cai em A ou em B e fica assim até fechar, qualquer que seja a
ordem do seek, o número de capturas e o tempo de espera. Não depende de relógio na página (o relógio é virtual) nem de
`word.start`: depende de como a carga ordenou o primeiro commit do compositor ao criar a camada do elemento animado.
Prova indireta: habilitar o domínio `LayerTree` do CDP, ou tirar e devolver o `display` do `body` depois do `ready`,
leva a sessão sempre para A, o que aponta estado de camada velho no compositor. O mecanismo exato dentro do Chrome não
foi isolado (um frame pintado antes de `DOMContentLoaded` não se mostrou a causa); a correção abaixo é o que se
provou, não uma explicação do Chromium.

**Descartado.** `--disable-partial-raster` e `--disable-threaded-animation` não mudam a taxa (9/40 e 27/40);
`--disable-threaded-compositing` derruba o browser (`E_BROWSER_TIMEOUT`); `will-change` no bloco troca A/B por um
terceiro estado, sem resolver; esperar mais, repetir a captura e mais leituras estáveis não desfazem (o estado é fixo
na sessão). Nenhum retry, nenhuma espera maior.

**Correção** (`packages/engine/src/capture.ts`, em `startSession`, vale para todo bloco e para o Windows e o Linux):
depois do `ready` e da mídia, antes de qualquer medição, o `body` sai do layout e volta (`display: none`, paint,
`display` de volta, paint), com `syncAnimations` entre os dois para as animações CSS (que nascem de novo ao voltar) irem
ao tempo do relógio. As camadas do compositor são destruídas e recriadas do mesmo estado, e o pixel deixa de depender
de como a carga ordenou o primeiro commit. Medido depois: 48 de 48 e 32 de 32 sessões em A sob carga, contra ~31–37 % em B
antes. Os 240 hashes de `win64` seguem idênticos (`node scripts/compare-goldens.ts`: 240/240, nenhum golden regenerado).

**Teste.** `packages/producer/test/subtitles-load.test.ts`: 16 sessões de `subtitles` em `software`, 8 em paralelo,
com um laço de CPU por núcleo, exige um único conjunto de hashes. Sem o bloco da correção falhou (2 conjuntos, 5 de 16
sessões em B); com ele passa.

## Auto-prova depois da correção (carga de CPU, concorrência padrão)

`node scripts/bench/with-load.ts 10 node scripts/goldens-self-check.ts`: 10 laços de CPU, 4 blocos em paralelo, 240 frames
em 2 processos separados, comparados frame a frame; 3 execuções por SO.

| plataforma | execuções | frames idênticos entre rodadas |
|---|---|---|
| Windows x64 (12 CPUs) | 3 | 240 de 240 nas 3 |
| Linux x64 (contêiner, 8 CPUs) | 3 | 240 de 240 nas 3 |

Em `subtitles` isolado, sob carga (`subtitles-load-lab.ts`, 40 capturas, paralelo 4, 10 laços): Linux 0 de 40 divergentes
depois da correção (10 de 40 fora do estado majoritário antes); Windows 48 de 48 e 32 de 32 em A (29 de 40 e ~31–37 % em
B antes). `node scripts/compare-goldens.ts` no Windows depois da correção: 240 de 240 com o hash do conjunto `win64`
de antes (nenhum golden do Windows foi regenerado).

## Decisão (planejamento, 2026-11-24): goldens por plataforma

Os goldens são **um conjunto por plataforma**, `catalog/goldens/<win64|linux64>/`; a conferência usa o conjunto da
plataforma em que roda e nunca o de outra; plataforma sem conjunto falha alto com `E_GOLDENS_PLATFORM_MISSING`.
O conjunto `win64` é o de antes, byte a byte (hashes e PNGs inalterados). O conjunto `linux64` foi gerado no contêiner
(`node scripts/generate-goldens.ts`, concorrência padrão) **só depois** da auto-prova acima e conferido ali mesmo logo
em seguida: 240 de 240 idênticos.

A promessa de `docs/contract.md` §9 vale para o **mesmo SO, a mesma arquitetura e o browser pinado**; entre SOs
não é prometida.

## Contêiner do gate

`scripts/linux/gate.ts` sobe o contêiner com `--security-opt seccomp=unconfined` **somente nele**: o seccomp padrão
do Docker bloqueia `clone(CLONE_NEWUSER)`, que o sandbox do Chrome usa, e o Chrome não abre ("No usable sandbox!").
O sandbox do Chrome continua ligado; o produto nunca passa `--no-sandbox`. `--default-seccomp` volta ao padrão do Docker.
O contêiner também sobe com `--init`: sem ele o PID 1 (`sleep infinity`) não colhe órfãos e todo processo morto pelo
gate fica zumbi (o `kill(pid, 0)` ainda o acha).

## Testes que não eram portáveis (corrigidos neste item)

- `captions-exit` ×2: o teste subia o servidor em `localhost` e o filho conectava em `localhost`; no contêiner o
  servidor bindava `::1` e o `fetch` do filho recebia `ECONNREFUSED` em `127.0.0.1` sem tentar `::1`. Os dois lados
  usam `127.0.0.1` literal agora (o produto não é afetado: só fala com hosts remotos).
- `ci-stage`: o `killTree` (grupo de processos) já matava o neto; o que falhava era o zumbi sob `sleep infinity`.
  Corrigido no gate (`--init`) e o teste trata estado `Z` como morto.
- `generate-codex` "(Windows)" ×2: dependiam de arquivos reais com caminhos do host; agora usam um disco virtual
  com `path.win32`.

## Por bloco (Linux contra os goldens do Windows)

| bloco | PSNR mín. (dB) | PSNR máx. (dB) | frames ≥ 50 dB |
|---|---|---|---|
| `pull-quote` | 34.6 | 35.6 | 0/5 |
| `vertical-captions` | 35.2 | 40.8 | 0/5 |
| `testimonial` | 35.8 | 38.5 | 0/5 |
| `vertical-testimonial` | 35.8 | 40.4 | 0/5 |
| `vertical-process` | 36.0 | 41.0 | 0/5 |
| `vertical-toc` | 36.1 | 48.8 | 0/5 |
| `vertical-quote` | 36.6 | 40.9 | 0/5 |
| `list-reveal` | 37.3 | 46.5 | 0/5 |
| `news-ticker` | 37.5 | 38.9 | 0/5 |
| `progress-bar` | 37.5 | 39.9 | 0/5 |
| `credits-roll` | 37.6 | 40.8 | 0/5 |
| `title-card` | 37.8 | 40.7 | 0/5 |
| `vertical-credits` | 37.9 | 41.9 | 0/5 |
| `code-snippet` | 38.0 | 47.0 | 0/5 |
| `vertical-chart` | 38.3 | 41.1 | 0/5 |
| `vertical-line-chart` | 38.3 | 48.6 | 0/5 |
| `vertical-outro` | 38.6 | 49.4 | 0/5 |
| `comparison` | 38.6 | 45.0 | 0/5 |
| `vertical-callout` | 38.8 | 42.5 | 0/5 |
| `vertical-lower-third` | 39.0 | 45.2 | 0/5 |
| `subtitles` | 40.2 | 40.7 | 0/5 |
| `timeline` | 41.0 | 49.5 | 0/5 |
| `outro` | 41.8 | 51.2 | 1/5 |
| `vertical-list` | 41.8 | 47.3 | 0/5 |
| `chart-bars` | 41.9 | 46.8 | 0/5 |
| `callout-box` | 42.1 | 53.2 | 1/5 |
| `pie-chart` | 42.1 | 49.3 | 0/5 |
| `vertical-cta` | 42.3 | 48.5 | 0/5 |
| `cta` | 42.6 | 46.7 | 0/5 |
| `quote` | 42.9 | 48.1 | 0/5 |
| `section-header` | 43.1 | 47.6 | 0/5 |
| `line-chart` | 43.4 | 52.9 | 1/5 |
| `stat-counter` | 43.4 | 48.9 | 0/5 |
| `vertical-title` | 43.4 | 46.4 | 0/5 |
| `scene-wipe` | 43.9 | 49.7 | 0/5 |
| `vertical-stat` | 44.3 | 54.9 | 1/5 |
| `vertical-image` | 44.3 | 59.5 | 1/5 |
| `lower-third` | 44.5 | 52.2 | 1/5 |
| `countdown` | 44.6 | 46.4 | 0/5 |
| `vertical-gallery` | 44.7 | 48.9 | 0/5 |
| `vertical-countdown` | 45.8 | 47.4 | 0/5 |
| `chapter-transition` | 45.9 | 66.8 | 2/5 |
| `vertical-map-pin` | 46.4 | 56.1 | 1/5 |
| `vertical-scene-wipe` | 46.4 | 49.0 | 0/5 |
| `photo-grid` | 46.9 | 54.3 | 1/5 |
| `logo-lockup` | 47.0 | 55.3 | 1/5 |
| `scene-iris` | 47.8 | 55.1 | 2/5 |
| `image-frame` | 50.2 | 61.4 | 5/5 |
