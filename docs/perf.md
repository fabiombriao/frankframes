# Desempenho de captura (EDT-62)

Medição antes de otimizar. Este documento registra a máquina, o método, os comandos e o **baseline**. As
tabelas por hipótese (antes/depois) e o número final entram aqui quando as otimizações forem feitas.

Nada em `packages/` mudou para medir: os scripts usam só API pública.

## Máquina do baseline

| item | valor |
|---|---|
| CPU | AMD Ryzen 5 5600X 6-Core Processor, 12 threads |
| RAM | 15,9 GiB |
| GPU (renderer do Chrome) | ANGLE (NVIDIA GeForce RTX 4060, Direct3D11) — `hardware` |
| SO | Windows 11 Pro 10.0.26200 |
| Node | v24.14.1 |
| Chrome | headless shell 158.0.8127.36 (pinado) |
| FFmpeg | vendor `n8.1.3-39-g660b5aa7db-20261120` (LGPL) |
| Workers (`default`) | 6 = `max(2, min(8, floor(12/2), floor(15,9 GiB / 768 MB)))` |

Medido em 2026-11-23, sem outra carga de CPU/GPU na máquina durante as execuções (o `ci --fast` só rodou depois das medições).

## Método

- **Cenários** (1920×1080, 30 fps, 10 s = 300 frames), em `scripts/bench/`:
  - `motion-1080p.html`: 6 cenas com texto em fontes do catálogo, gradiente, `transform`/`opacity`/`clip-path`/`filter: blur`.
  - `video-1080p.html`: vídeo de 10 s (`testsrc2`, MJPEG, gerado na hora pelo FFmpeg vendorizado) + título por cima.
    `data-has-audio="false"` no `<video>`, porque a origem MJPEG não tem faixa de áudio e o mix falhava alto.
- **Estágios** carimbados pelo `onProgress` de `renderComposition` (compile 5, probe 10, extract 20, capture 25→75,
  audio 78, encode 80→90, assemble 92→100). `s_capture` vai do evento "capture 25" ao "capture 75" e
  **inclui subir o servidor, abrir o Chrome e a prontidão da página**; `captureFps = frames / s_capture`.
  `s/min = s_total / (duração em min)`.
- **Codec** AV1 nos três presets (`draft`, `standard`, `high`). 3 execuções por combinação; tabela em mediana (mín–máx).
- **GPU**: `auto` e `software`. Composição com `<video>` força software em `auto` (contract §9), então para o cenário
  `video` `auto` ≡ `software` e a combinação duplicada é pulada (registrado no log).
- **Cache de frames do vídeo**: execução 1 é fria (a entrada `cache/frames/<frameCacheKey>` é apagada antes; a
  presença do `.complete` no mesmo caminho é conferida, falha alto se a chave não bate). Execuções 2 e 3 são quentes.
  Extração fria ≈ 1,6–1,8 s; quente ≈ 0,04 s.
- **`bench-frame`**: uma sessão Chrome (cenário `motion`), 120 frames, 5 de aquecimento descartados (115 medidos).
  Frames pares medem `seekFrame` (seek + settle em um `evaluate`); frames ímpares medem `seekOnly` e depois
  `settleAfterSeek`; todos medem o segundo `settlePaint`, `captureScreenshot`, base64 + SHA-256 e três variantes de
  screenshot em ordem rotativa (padrão, `optimizeForSpeed: true`, `optimizeForSpeed: false`). Como `Session` não expõe
  CDP, o script abre o Chrome pelas peças públicas (`resolveChrome`, `chromeArgs`, `startServer`, `prepare`) e usa
  `puppeteer-core` direto.
- **Saída fora do Sync**: `--out C:/Users/rober/AppData/Local/Temp/ff-bench` (JSON, HTMLs e MKV de origem não vão
  para a pasta sincronizada nem para o repositório). Os JSON abaixo estão resumidos neste documento.

## Comandos

```powershell
node scripts/bench-capture.ts --label baseline --runs 3 --out C:/Users/rober/AppData/Local/Temp/ff-bench
node scripts/bench-frame.ts --gpu software --out C:/Users/rober/AppData/Local/Temp/ff-bench
node scripts/bench-frame.ts --gpu hardware --out C:/Users/rober/AppData/Local/Temp/ff-bench
```

Verificação rápida: `node scripts/bench-capture.ts --runs 1 --seconds 1 --presets draft --gpu software`.

Arquivos: `baseline-20261123-1828.json`, `frame-software-20261123-1844.json`, `frame-hardware-20261123-1846.json`.

## Baseline — `bench-capture` (workers = 6)

| cenário | GPU efetiva | preset | cache | s_total | s_capture | captureFps | s/min | s_encode |
|---|---|---|---|---|---|---|---|---|
| motion | hardware | draft | — | 26,6 (26,3–27,1) | 22,6 | 13,3 (13,1–13,3) | 159,4 | 3,8 (3,7–4,1) |
| motion | hardware | standard | — | 27,3 (27,1–27,3) | 22,7 | 13,2 | 163,7 | 4,5 (4,4–4,6) |
| motion | hardware | high | — | 27,9 (27,5–28,2) | 22,4 | 13,4 (13,3–13,7) | 167,4 | 5,5 (5,4–5,6) |
| motion | software | draft | — | 35,2 (34,8–36,2) | 31,3 | 9,6 (9,4–9,7) | 211,4 | 3,8 |
| motion | software | standard | — | 36,5 (35,9–43,7) | 31,5 (31,3–39,0) | 9,5 (7,7–9,6) | 218,8 (215,1–262,3) | 4,6 (4,3–5,0) |
| motion | software | high | — | 38,0 (37,3–38,8) | 32,2 | 9,3 (9,2–9,5) | 228,2 | 5,8 |
| video | software | draft | frio (n=1) | 21,4 | 15,4 | 19,4 | 128,3 | 4,3 |
| video | software | draft | quente (n=2) | 20,4 (19,6–21,1) | 16,2 | 18,6 | 122,4 | 4,0 |
| video | software | standard | frio | 22,9 | 15,4 | 19,4 | 137,5 | 5,5 |
| video | software | standard | quente | 21,4 (21,0–21,8) | 15,7 | 19,1 | 128,3 | 5,4 |
| video | software | high | frio | 25,4 | 15,4 | 19,5 | 152,4 | 8,2 |
| video | software | high | quente | 23,7 (23,6–23,7) | 15,4 | 19,5 | 142,0 | 8,1 |

Observações:

- Uma execução de `motion/software/standard` ficou fora da curva (43,7 s total, 7,7 fps); as outras duas ficaram em 36 s.
  Mediana não é afetada; o máximo aparece na tabela.
- `captureFps` do `motion` é ~1,4× maior em hardware (13,3) do que em software (9,6).
- O vídeo captura mais rápido que o `motion` em software (~19 vs ~9,5 fps): a cena de `motion` custa mais por frame
  do que um `<img>` de frame extraído.
- Extração fria do vídeo: 1,55–1,82 s; quente: 0,03–0,06 s (≤ 1% do total nos dois casos).
- `s_encode` por preset: `draft` 3,8–4,3 s, `standard` 4,5–5,5 s, `high` 5,5–8,2 s (12–25% do `s_total`),
  hoje inteiramente **depois** da captura.

## Baseline — `bench-frame` (ms por frame, mediana; 115 frames, `motion` 1080p)

| fase | software | hardware |
|---|---|---|
| `seekFrame` (seek + settle, frames pares) | 12,38 | 9,72 |
| `seekOnly` | 1,06 | 1,09 |
| `settleAfterSeek` | 27,68 | 25,38 |
| `settlePaint` (segundo settle, todos os frames) | 33,28 | 33,27 |
| `captureScreenshot` (PNG padrão) | 362,66 | 257,36 |
| base64 decode | 0,24 | 0,21 |
| SHA-256 | 0,49 | 0,34 |
| variante: padrão | 351,60 | 237,63 |
| variante: `optimizeForSpeed: true` | 112,69 | 97,39 |
| variante: `optimizeForSpeed: false` | 354,09 | 235,54 |

- Settle no teto de 80 ms: **0 de 173 medições** nos dois modos.
- Tamanho mediano do PNG: software padrão 816.222 B vs `optimizeForSpeed: true` 1.565.385 B; hardware padrão
  586.507 B vs 1.315.073 B.
- `optimizeForSpeed: false` é byte a byte igual ao padrão (115/115); `true` nunca é igual (0/115) → os SHA-256 de
  `catalog/goldens.json` mudariam; PSNR contra os PNG antigos precisa ser conferido.

## Leitura das hipóteses (proposta do executor; a ordem final é do planejador)

Ordem a priori do plano: H0, H1, H2, H3, H4, H5, H6.

| hipótese | veredito dos números | peso medido |
|---|---|---|
| **H0** rAF não dispara, settle no teto de 80 ms | **Falsa.** `settlePaint` ≈ 33 ms, 0 de 173 no teto. | — |
| **H1** settle duplicado | Real, mas pequeno: o 2º settle custa ~33 ms de ~410 ms/frame (software) e ~290 ms (hardware), ≈ 8–11%. Juntar seek + settle num `evaluate` ganha ~1 ms. | ~8–11% do frame |
| **H4** `optimizeForSpeed: true` | **Dominante.** `captureScreenshot` é 85–90% do custo por frame (363 ms software, 257 ms hardware) e a variante rápida cai para 113 / 97 ms (3,2× / 2,6×). Preço: PNG ~1,9–2,2× maior e bytes diferentes (goldens regenerados; checar PSNR ≥ 50 dB). | até ~65% do frame |
| **H2** encode em série | Moderada: `s_encode` = 12–25% do `s_total` (3,8–8,2 s). Sobrepor captura e encode tende a `max(captura, encode)`; o ganho é o `s_encode` quase inteiro no `high`. | 12–25% do total |
| **H3** PNG em disco | Não medido isoladamente; depende de H2. Com H4 o PNG fica maior, o que aumenta o peso do I/O. | a medir |
| **H5** workers | **Não medido** (só `default` = 6). Precisa de varredura 2/4/6/8/12 por modo de GPU. Como a captura é CPU/GPU-bound no screenshot, a curva pode mudar depois de H4. | a medir |
| **H6** BeginFrame | Fora de escopo: o settle não é o gargalo (H0 falsa). | — |

Ordem fixada pelo planejador: **H4 → H1 → (EDT-61) → H2 + H3 → H5**; H6 fica fora da 1.0.

## H4 — `optimizeForSpeed: true` (entregue)

Mudança: `packages/engine/src/capture.ts` (`SCREENSHOT_PARAMS`, usado na captura descartada de abertura e em todo frame).
Medido com `--label h4` (mesmos parâmetros do baseline, `--out` fora do Sync, máquina parada) e `bench-frame`.

**Pixels e determinismo**
- Os 240 frames dos goldens (48 blocos × 5), decodificados, têm **diferença zero** contra os PNG antigos (RGBA, todos os
  canais); nenhum é igual byte a byte (esperado). Goldens regenerados com `scripts/generate-goldens.ts`.
- `determinism.test.ts` verde em `auto` (→ hardware) e `software`: 2 execuções + ordem invertida, 60 frames,
  mesmo SHA-256 por frame.
- `meta.json` dos blocos: o `sha256` é do `index.html` (instalação remota), não do PNG; não muda. `thumb.png` só é exigido como PNG
  real (> 10 KB); não foi regenerado.

**Velocidade** (3 execuções, workers = 6, mediana; `motion` 300 frames)

| GPU | preset | captureFps antes → depois | s_total antes → depois | s/min antes → depois |
|---|---|---|---|---|
| hardware | draft | 13,3 → 21,7 (1,63×) | 26,6 → 17,6 s | 159 → 106 |
| hardware | standard | 13,2 → 21,6 | 27,3 → 18,8 s | 164 → 113 |
| hardware | high | 13,4 → 22,6 | 27,9 → 19,4 s | 167 → 116 |
| software | draft | 9,6 → 16,8 (1,75×) | 35,2 → 22,1 s | 211 → 132 |
| software | standard | 9,5 → 16,6 | 36,5 → 22,8 s | 219 → 137 |
| software | high | 9,3 → 15,8 | 38,0 → 25,4 s | 228 → 153 |
| video (software), quente | draft | 18,6 → 23,8 | 20,4 → 16,4 s | 122 → 98 |
| video (software), quente | standard | 19,1 → 22,7 | 21,4 → 18,3 s | 128 → 110 |
| video (software), quente | high | 19,5 → 24,1 | 23,7 → 19,7 s | 142 → 119 |
| video (software), frio | draft / standard / high | 19,4 / 19,4 / 19,5 → 23,1 / 24,0 / 24,2 | 21,4 / 22,9 / 25,4 → 18,5 / 19,2 / 21,4 s | 128 / 138 / 152 → 111 / 115 / 128 |

`s_encode` não mudou (3,6–7,3 s): o encode lê PNG maior, mas continua limitado pelo AV1.

**`bench-frame`** (ms por frame, mediana; `captureScreenshot` agora é o screenshot do produto)

| fase | software antes → depois | hardware antes → depois |
|---|---|---|
| `captureScreenshot` | 362,7 → 108,2 | 257,4 → 93,6 |
| `seekFrame` | 12,4 → 13,0 | 9,7 → 10,0 |
| `settlePaint` (2º settle) | 33,3 → 33,2 | 33,3 → 33,2 |
| base64 + SHA-256 | 0,7 → 1,3 | 0,6 → 1,1 |

Custo por frame ≈ 155 ms (software) e ≈ 138 ms (hardware); o 2º settle passou a ~21–24% do frame (era 8–11%) e o
screenshot caiu de 85–90% para ~70%. O decode base64 + hash ficou ~2× maior (PNG ~2× maior), ainda ~1 ms.

**Disco** (pico do `workDir` no fim do render: frames PNG + vídeo + áudio; `motion` 1080p, 300 frames, draft)

| GPU | antes | depois | por frame depois |
|---|---|---|---|
| hardware | 162 MB | 382 MB (2,36×) | ~1,27 MB |
| software | 230 MB | 453 MB (1,97×) | ~1,51 MB |

Os frames ficam no disco até o fim do encode, então o pico é o total. Extrapolação linear para ~2000 frames 1080p
(aceite do EDT-64): **~2,5 GB (hardware) a ~3 GB (software)** com este conteúdo; conteúdo com mais detalhe fotográfico
pesa mais por frame. H2/H3 (pipe em ordem, sem PNG em disco) reduzem isso.

## H1 — uma espera de paint por frame, só em software (entregue)

Mudança: `packages/engine/src/capture.ts`. Em software, `capture()` não repete o `settle` que o `seekFrame` já fez; em
**hardware as duas esperas continuam** (decisão do planejador: o H1 vale só para software por causa do EDT-77 —
hardware com vários workers já não reproduz hash na mesma máquina, e tirar a espera piorou). Contador de teste:
`FRANKFRAMES_CAPTURE_PROFILE=1` expõe `__ff.settleCount`; `determinism.test.ts` exige 1 espera por frame não-primeiro
em software e 2 em hardware.

**Pixels e determinismo** (`examples/cena-dupla`, 240 frames, `render` com hashes por frame)
- Software: **240/240 hashes iguais** antes e depois (e estável entre rodadas).
- Hardware (`auto`, 6 workers): comportamento já instável antes do H1 (95 frames com 2 variantes em 5 rodadas);
  a primeira versão do H1 (sem espera em hardware) subiu para 207 frames instáveis, por isso hardware manteve as duas
  esperas. Versão final: 37 frames instáveis em 5 rodadas (≤ baseline; ruído do EDT-77, caminho de código idêntico ao antigo).
  Com `--workers 1` hardware é estável e idêntico antes/depois.
- `determinism.test.ts` verde em `auto` e `software` (várias execuções).

**Velocidade** (3 execuções, workers = 6, mediana; `motion` 300 frames; só as linhas de software mudam)

| GPU | preset | captureFps h4 → h1 | s_total h4 → h1 | s/min h4 → h1 |
|---|---|---|---|---|
| software | draft | 16,8 → 18,8 (1,12×) | 22,1 → 19,9 s | 132 → 119,5 |
| software | standard | 16,6 → 18,8 | 22,8 → 20,4 s | 137 → 122 |
| software | high | 15,8 → 18,9 | 25,4 → 21,7 s | 153 → 130 |
| video (software), quente | draft | 23,8 → 25,1 | 16,4 → 15,9 s | 98 → 95,5 |
| video (software), quente | standard | 22,7 → 24,8 | 18,3 → 16,9 s | 110 → 102 |
| video (software), quente | high | 24,1 → 25,5 | 19,7 → 19,3 s | 119 → 116 |
| hardware | draft / standard / high | 21,7 / 21,6 / 22,6 → 22,1 / 22,4 / 22,8 | — | 106 / 113 / 116 → 104 / 106 / 112 (ruído, caminho igual) |

`bench-frame` mede as fases isoladas (não o produto): em software o `settlePaint` de ~33 ms (mediana 33,0) deixou de
fazer parte do frame; o resto não mudou (seekFrame 17,1 incl. settle, captureScreenshot 122, base64 0,5, sha256 0,8).
O ganho medido no render (~12% em captureFps) é menor que os ~21% do frame porque o frame inclui custo fora dessas fases
(abrir Chrome, prontidão, workers disputando CPU).

JSON: `h1-20261123-1938.json`, `frame-software-20261123-1949.json`, `frame-hardware-20261123-1950.json`.

## Tabela por hipótese (antes/depois)

| hipótese | rótulo | captureFps motion (hw / sw) | s/min draft/standard/high | observação |
|---|---|---|---|---|
| baseline | `baseline` | 13,3 / 9,6 | 159 / 164 / 167 (hw); 211 / 219 / 228 (sw) | este documento |
| H4 | `h4` | 21,7 / 16,8 | 106 / 113 / 116 (hw); 132 / 137 / 153 (sw) | pixels idênticos; PNG ~2× maior |
| H1 | `h1` | 22,1 / 18,8 | 104 / 106 / 112 (hw, igual); 119,5 / 122 / 130 (sw) | só software (EDT-77: hardware mantém 2 esperas) |

Comandos do `h4`: os mesmos do baseline com `--label h4` e `bench-frame` nos dois modos (JSON
`h4-20261123-1855.json`, `frame-software-20261123-1906.json`, `frame-hardware-20261123-1907.json`).

Número final: a preencher ao fim do EDT-62 (passos 4–5).
