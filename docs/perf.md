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
| Workers (`default`) | 6 = `max(2, min(8, floor(12/2), floor(15,9 GiB / 768 MB)))`, a fórmula da época. Desde o EDT-91 o padrão conta a memória livre ([contrato](contract.md)) |

Medido em 2026-11-23, sem outra carga de CPU/GPU na máquina durante as execuções (o `ci --fast` só rodou depois das medições).

## Método

- **Cenários** (1920×1080, 30 fps, 10 s = 300 frames), em `scripts/bench/`:
  - `motion-1080p.html`: 6 cenas com texto em fontes do catálogo, gradiente, `transform`/`opacity`/`clip-path`/`filter: blur`.
  - `video-1080p.html`: vídeo de 10 s (`testsrc2`, MJPEG, gerado na hora pelo FFmpeg vendorizado) + título por cima.
    `data-has-audio="false"` no `<video>`, porque a origem MJPEG não tem faixa de áudio e o mix falhava alto.
- **Estágios** carimbados pelo `onProgress` de `renderComposition` (compile 5, probe 10, extract 20, capture 25→75,
  audio 78, encode 80→90, assemble 92→100). `s_capture` vai do evento "capture 25" ao "capture 75" e
  **inclui subir o servidor, abrir o Chrome e a prontidão da página**; `captureFps = frames / s_capture`.
  `s/min = s_total / (duração em min)`. **Desde o H2+H3 (`h23`)** captura e encode andam juntos: `s_capture`/`captureFps`
  incluem o encode em andamento e `s_encode` é só a cauda depois do último frame; as tabelas anteriores ao `h23` têm o
  encode inteiro depois da captura. O pico de disco passou a ser amostrado a cada 100 ms durante o render.
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
  hoje inteiramente **depois** da captura (até o H1; desde o H2+H3 ele é só a cauda, veja a seção "H2 + H3").

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
  `catalog/goldens/<plataforma>/goldens.json` mudariam; PSNR contra os PNG antigos precisa ser conferido.

## Leitura das hipóteses (proposta do executor; a ordem final é do planejador)

Ordem a priori do plano: H0, H1, H2, H3, H4, H5, H6.

| hipótese | veredito dos números | peso medido |
|---|---|---|
| **H0** rAF não dispara, settle no teto de 80 ms | **Falsa.** `settlePaint` ≈ 33 ms, 0 de 173 no teto. | — |
| **H1** settle duplicado | Real, mas pequeno: o 2º settle custa ~33 ms de ~410 ms/frame (software) e ~290 ms (hardware), ≈ 8–11%. Juntar seek + settle num `evaluate` ganha ~1 ms. | ~8–11% do frame |
| **H4** `optimizeForSpeed: true` | **Dominante.** `captureScreenshot` é 85–90% do custo por frame (363 ms software, 257 ms hardware) e a variante rápida cai para 113 / 97 ms (3,2× / 2,6×). Preço: PNG ~1,9–2,2× maior e bytes diferentes (goldens regenerados; checar PSNR ≥ 50 dB). | até ~65% do frame |
| **H2** encode em série | Moderada: `s_encode` = 12–25% do `s_total` (3,8–8,2 s). Sobrepor captura e encode tende a `max(captura, encode)`; o ganho é o `s_encode` quase inteiro no `high`. | 12–25% do total |
| **H3** PNG em disco | Medido junto com H2 (seção "H2 + H3"): o pico de disco cai de 382/453 MB para < 1 MB e deixa de crescer com os frames. | disco, não tempo |
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

## H1 — uma espera de paint por frame (entregue em software; em hardware desde o EDT-77, opção D)

Mudança: `packages/engine/src/capture.ts`. Em software, `capture()` não repete o `settle` que o `seekFrame` já fez; em
**hardware as duas esperas continuaram na entrega do H1** (decisão do planejador: hardware com vários workers já não reproduzia hash
na mesma máquina, e tirar a espera piorou). **Atualização (EDT-77, opção D):** hardware passou a rodar com `--disable-gpu-compositing`
e a segunda espera saiu; hoje é uma espera por frame em hardware e em software (0/240 instáveis em 5 rodadas, ~55 fps contra ~46). Contador de teste:
`FRANKFRAMES_CAPTURE_PROFILE=1` expõe `__ff.settleCount`; `determinism.test.ts` exigia 1 espera por frame não-primeiro
em software e 2 em hardware; hoje exige 1 nos dois.

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
| H1 | `h1` | 22,1 / 18,8 | 104 / 106 / 112 (hw, igual); 119,5 / 122 / 130 (sw) | software na entrega; hardware desde o EDT-77/D (1 espera) |
| H2+H3 | `h23` | 22,2 / 16,6² | 83,3 / 87,5 / 89,6 (hw); 110,5 / 109,4 / 120,5 (sw) | encode junto da captura, sem PNG em disco; disco 382/453 MB → < 1 MB; vídeo sem ganho claro |
| H5 | `h5` / `h5d` | 20,2 / 15,9 (6 workers, standard) | 92,5 (hw) / 116,1 (sw) com 6 workers, standard; 81,9 / 113,4 em draft | sem mudança: 6 workers é o joelho em hardware (6 ≈ 8, 4 e 12 pioram 10–22%); em software 4 ≈ 6 (≤ 4%); `defaultWorkerCount` mantido |

² `captureFps` do `h23` inclui o encode rodando junto: não é comparável com as linhas anteriores (use `s/min`).

Comandos do `h4`: os mesmos do baseline com `--label h4` e `bench-frame` nos dois modos (JSON
`h4-20261123-1855.json`, `frame-software-20261123-1906.json`, `frame-hardware-20261123-1907.json`).

## H2 + H3 — encode enquanto captura, sem PNG em disco (entregue)

Mudança: `packages/engine/src/parallel.ts` (fila dinâmica de lotes de 8 frames no lugar de `splitIntoChunks`;
`orderedFeeder` com buffer de reordenação limitado e backpressure), `packages/encode/src/policy.ts`
(`buildFramePipeArgs`, entrada `-f image2pipe -c:v png -i -`), `packages/producer/src/pipe-encode.ts` (FFmpeg vivo
durante a captura, falha alta nos dois sentidos) e `packages/producer/src/render.ts`. Com `--keep` os PNG também são
gravados em `frames/`. Spec em `docs/contract.md` §8 ("Captura e encode andam juntos").

**Mudança de significado das colunas (leia antes de comparar com as tabelas acima).** Até o H1, `s_capture` era só a
captura e `s_encode` o encode inteiro, depois dela. Agora os dois andam juntos: `s_capture` (e `captureFps`) é a captura
**com o encode em andamento**, e `s_encode` é só a **cauda** depois do último frame (o FFmpeg fechando o vídeo).
`s_encode` de 0,2–3,1 s não é mais "o custo do encode"; compare `s_total` e `s/min`, que continuam significando a
mesma coisa. O estágio `capture 75` do `onProgress` passa a querer dizer "todos os frames entregues", e `encode 80→90`
é a cauda.

**Pixels e determinismo** (`examples/cena-dupla`, 240 frames, hash por frame; mesma sonda do H1)
- Software: **240/240 hashes iguais** ao antes do H2+H3 (3 rodadas, 0 instáveis).
- Hardware (`auto`, 6 workers): 24 frames instáveis em 5 rodadas, contra 74 na medição de referência feita logo antes
  (37 no H1, 95 antes do H1). **Não piorou**; o ruído do EDT-77 continua e varia de uma medição para outra.
- Vídeo decodificado: `pipe-encode.test.ts` compara `framemd5` do encode por pipe com o da sequência em disco, entregando
  os frames fora de ordem: igual.
- `determinism.test.ts` verde em `auto` e em `software`.

**Velocidade** (3 execuções, workers = 6, mediana; `motion` 300 frames; "antes" = `h1`/`h4` das tabelas acima)

| GPU | preset | captureFps antes → depois¹ | s_total antes → depois | s/min antes → depois | s_encode antes → depois |
|---|---|---|---|---|---|
| hardware | draft | 22,1 → 22,2 | 17,3 → 13,9 s | 104 → 83,3 | 3,8 → 0,2 |
| hardware | standard | 22,4 → 21,2 | 17,7 → 14,6 s | 106 → 87,5 | 4,5 → 0,4 |
| hardware | high | 22,8 → 21,5 | 18,7 → 14,9 s | 112 → 89,6 | 5,5 → 0,9 |
| software | draft | 18,8 → 16,6 | 19,9 → 18,4 s | 119,5 → 110,5 | 3,8 → 0,2 |
| software | standard | 18,8 → 16,8 | 20,4 → 18,2 s | 122 → 109,4 | 4,6 → 0,3 |
| software | high | 18,9 → 15,9 | 21,7 → 20,1 s | 130 → 120,5 | 5,8 → 1,0 |
| video (software), quente | draft | 25,1 → 19,5 | 15,9 → 15,9 s | 95,5 → 95,5 | 4,0 → 0,4 |
| video (software), quente | standard | 24,8 → 17,2 | 16,9 → 18,5 s | 102 → 110,7 | 5,4 → 0,8 |
| video (software), quente | high | 25,5 → 19,0 | 19,3 → 18,7 s | 116 → 112,4 | 8,1 → 2,7 |

¹ `captureFps` agora inclui o encode rodando junto (ver acima); não é comparável linha a linha.

Leitura:
- **Hardware: −20% no `s_total`** nos três presets (a cauda de 3,8–5,5 s some; a captura em si não desacelera).
- **Software: ganho de 8–11%**, bem menor que a cauda eliminada: a captura em software é CPU-bound com 6 workers e o
  AV1 do FFmpeg disputa os mesmos núcleos enquanto ela roda (`s_capture` subiu de ~15,9 s para 17,8–18,9 s). O encode
  deixou de ser serial, mas não deixou de custar CPU.
- **Vídeo (software): sem ganho claro** (±: 15,9 → 15,9 s no `draft`, 16,9 → 18,5 s no `standard`, 19,3 → 18,7 s no
  `high`; as faixas mín–máx das duas medições se sobrepõem). A captura desse cenário já era a mais rápida e o encode
  compete com ela do mesmo jeito.
- Esse é o ponto de partida do H5: com o encode no mesmo conjunto de núcleos, o número ótimo de workers pode ser
  menor que 6 em software. Não foi mexido aqui.
- Medição feita com a máquina de uso normal do titular ligada (CPU ~20–40% em amostras de 2 s antes de começar, sem
  nenhum Chrome/FFmpeg meu rodando); trate diferenças de poucos por cento como ruído.

**Disco** (pico do `workDir`, `motion` 1080p, 300 frames, draft; antes = frames PNG + vídeo + áudio lidos no fim do render
com `keepWorkDir`; agora amostrado a cada 100 ms durante o render, sem `keepWorkDir`)

| GPU | antes (H4) | depois | frames em disco |
|---|---|---|---|
| hardware | 382 MB | < 1 MB (vídeo + áudio) | nenhum |
| software | 453 MB | < 1 MB | nenhum |
| `motion` `high` | — | 1 MB | nenhum |
| vídeo (software), `draft`/`standard`/`high` | — | 2 / 7 / 9 MB | nenhum |

O pico deixa de crescer com o número de frames: a extrapolação do EDT-64 (~2,5–3 GB para ~2000 frames 1080p) cai para
o tamanho do vídeo parcial. Em memória, o `orderedFeeder` segura no máximo `max(16, 6 × 8) = 48` frames PNG
(~1,3–1,5 MB cada, ~70 MB) mais o que o pipe do FFmpeg bufferiza.

JSON: `h23-20261123-2258.json` (`bench-capture`, `--label h23 --runs 3`).

Comando: `node scripts/bench-capture.ts --label h23 --runs 3 --out C:/Users/rober/AppData/Local/Temp/ff-bench`.
`scripts/bench-capture.ts` passou a medir o pico do `workDir` por amostragem (`ff-render-*` no temporário), porque os
frames não existem mais ao fim do render nem o `keepWorkDir` pode ficar ligado sem mudar o que se mede.

## H5 — varredura de workers (sem mudança no padrão)

Pergunta do plano: com o encode agora no mesmo conjunto de núcleos da captura, o número ótimo de workers mudou?
`defaultWorkerCount` (metade dos núcleos, teto 8, 768 MB por browser) = **6** nesta máquina (12 threads, 15,9 GiB).
Regra de decisão: só muda se a curva mostrar um joelho claramente diferente (ganho > 5% além do ruído).

Método: `bench-capture --workers 2,4,6,8,12`, `standard`, 3 execuções, mediana (faixa mín–máx entre parênteses),
`motion` 1080p 300 frames. Vídeo: só software, 1 rodada fria + 2 quentes (cache de extração). Mesma máquina de uso normal
do titular (CPU de fundo ~20–40%).

`s/min` (menor é melhor):

| workers | motion hardware | motion software | vídeo software (quente) |
|---|---|---|---|
| 2 | 156,4 (154,6–158,7) | 151,3 (148,9–159,8) | 126,6 (124,6–128,7) |
| 4 | 101,9 (100,0–104,1) | **114,3** (112,8–116,4) | **96,2** (92,7–99,7) |
| **6 (padrão)** | **92,5** (85,2–97,6) | 116,1 (113,7–116,6) | 100,2 (98,3–102,0) |
| 8 | **92,1** (89,3–92,2) | 125,1 (121,7–125,6) | 105,6 (104,1–107,1) |
| 12 | 105,0 (102,7–107,8) | 137,3 (129,6–141,0) | 114,2 (113,2–115,1) |

`captureFps` (inclui o encode junto; hardware / software motion / vídeo): 2 → 11,7 / 12,1 / 14,7; 4 → 18,2 / 16,1 / 19,7;
6 → 20,2 / 15,9 / 19,0; 8 → 20,2 / 14,8 / 17,9; 12 → 17,7 / 13,4 / 16,5. Pico de disco do `workDir`: 0 MB (motion) e 7 MB
(vídeo) em todos os pontos: o número de workers não mexe nele.

Leitura:
- **Hardware:** o joelho está em 6–8 (92,5 e 92,1 são iguais dentro do ruído); 4 perde ~10% e 12 perde ~14% (browsers demais
  disputando a GPU e a CPU). O padrão 6 já é o ponto ótimo.
- **Software `motion`:** 4 e 6 empatam (114,3 contra 116,1, 1,6%, dentro da faixa); 8 e 12 pioram (+8% e +18%).
- **Vídeo (software):** 4 contra 6 dá 96,2 contra 100,2 (4%), abaixo dos 5% e com faixas que se tocam; 8 e 12 pioram.
  Uma rodada fria só (1 amostra por ponto) mostra a mesma ordem (101,1 / 111,2 / 112,2 / 122,4 para 4 / 6 / 8 / 12).
- **Conclusão: `defaultWorkerCount` não muda.** Nenhum joelho passa de 5% além do ruído; mexer na regra por 4% de
  um cenário só seria ajustar a esta máquina. A regra continua uma só para os dois modos de GPU.
- Os 6 workers de hoje também são a metade dos núcleos: dobrar (12) é sempre pior, o que confirma o teto de 8 e
  a regra "metade dos núcleos".
- Comparação cruzada com o `h23` (mesmos pontos, 6 workers, `standard`): hardware 87,5 → 92,5 e software 109,4 → 116,1.
  A diferença (6%) é o ruído de outra sessão de medição com a máquina em uso (o `h23` inteiro foi medido em outro
  horário); compare dentro de uma varredura, não entre elas.

JSON: `h5-20261123-2317.json` (`--label h5`), `h5d-*.json` (varredura `draft`, abaixo).

**Mesma curva em `draft`** (`motion`, 3 execuções, mediana; `s/min`, faixa mín–máx):

| workers | hardware | software |
|---|---|---|
| 4 | 100,3 (97,2–100,6) | 114,0 (113,6–114,1) |
| **6 (padrão)** | **81,9** (81,4–84,8) | 113,4 (109,5–118,8) |
| 8 | 82,7 (81,0–83,0) | 111,6 (108,7–113,3) |

Hardware repete o `standard` (6 ≈ 8, 4 perde 22%). Em software 4, 6 e 8 ficam a ~2% entre si, dentro do ruído: não há joelho.
O 6 em `draft` hardware (81,9) bate com o `h23` (83,3), o que dá confiança de que a curva do `standard` é só deslocada
pelo ruído de sessão.

**Lote (`--concurrency`).** `workersPerJob(concurrency, default)` divide os workers entre trabalhos (`floor(6 / c)`); a
curva acima já mostra que 2 workers por trabalho (concurrency 3) rende ~156 s/min por trabalho, contra ~92 s/min de um
trabalho com 6 — duas sessões de 3 workers somam mais que uma de 6, mas cada vídeo demora mais. Não foi medido o
lote de ponta a ponta (decisão do plano: "se barato"; o ganho depende do tamanho do lote e não muda o padrão).

## Número final do EDT-62

`s/min` e `captureFps` do `motion` 1080p, 300 frames, workers = 6, mediana de 3, baseline → `h23` (estado final; o H5 não
mudou código nem padrão). `captureFps` do `h23` inclui o encode andando junto e **não é comparável** com o do baseline
(use `s/min`).

| modo | preset | s/min baseline → final | Δ | captureFps baseline → final |
|---|---|---|---|---|
| hardware | draft | 159 → 83,3 | −48% | 13,3 → 22,2 |
| hardware | standard | 164 → 87,5 | −47% | — → 21,2 |
| hardware | high | 167 → 89,6 | −46% | — → 21,5 |
| software | draft | 211 → 110,5 | −48% | 9,6 → 16,6 |
| software | standard | 219 → 109,4 | −50% | — → 16,8 |
| software | high | 228 → 120,5 | −47% | — → 15,9 |

Por hipótese: H4 −33% (hardware) / −37% (software) em `s/min` `draft`, H1 só em software (−10%), H2+H3 −20% (hardware) e −8 a −11%
(software), H5 sem mudança (padrão confirmado). Disco: 382/453 MB de PNG → < 1 MB. Falta H6 (fora da 1.0).

## A001 — filtro CSS do vídeo (EDT-100)

Em 2026-11-26, o A001 foi renderizado antes e depois da correção com `--gpu hardware --workers 1 --preset standard`.
Os dois renders usaram a mesma fonte, cache de quadros já preenchido e o FFmpeg vendorizado.

| Render integral | Frames | Duração do vídeo | Tempo de parede | Tamanho |
|---|---:|---:|---:|---:|
| Antes, `4d3e455` | 1357 | 45,23 s | 306,0 s | 10.601.920 B |
| Com correção, `3cd0a6b` | 1357 | 45,23 s | 288,0 s | 10.428.578 B |

Cada valor vem de uma execução. A RAM livre no início era 2,53 GiB antes e 5,04 GiB depois e variou durante
a captura. Os tempos registram as condições dessas duas rodadas.

## A001 — render por camadas (EDT-102)

O mesmo HTML de 1080×1920 a 30 fps foi renderizado com um worker, `--gpu hardware --preset standard`,
com e sem `--layered`. A rodada por camadas manteve a pasta de trabalho (`--keep`) e começou com
3,85 GiB de RAM livre. A referência integral usou SVT-AV1 e a saída por camadas usou AV1 NVENC.

| Caminho | Fotos do Chrome | Frames | Tempo de parede | Tamanho | PSNR contra o integral |
|---|---:|---:|---:|---:|---:|
| Integral, com EDT-100 | 1357 | 1357 | 288,0 s | 10.428.578 B | referência |
| Por camadas | 550 | 1357 | 164,5 s | 9.815.720 B | **40,75 dB** |

No render por camadas, a captura e o gradiente levaram 81,7 s, o áudio 7,6 s e a composição com encode 75,1 s.
O tamanho caiu 5,9%. A comparação usou `psnr` do FFmpeg sobre os 1357 frames decodificados em
`yuv420p` e teve mínimo de 37,95 dB por frame.

## A001 — decodificação NVDEC (EDT-103, etapa 1)

As duas rodadas reutilizaram as mesmas camadas, máscaras e grafo do EDT-102 e codificaram com AV1 NVENC
(`p5`, `cq 38`). A diferença entre elas foi a decodificação das três janelas da mesma fonte H.264 Main.
O tempo abaixo cobre a composição e o encode do vídeo, usando os arquivos intermediários já gravados.

| Decodificação | Tempo | Tamanho do vídeo sem áudio | RAM livre no início |
|---|---:|---:|---:|
| CPU | 77,6 s | 8.696.811 B | 2,34 GiB |
| NVDEC | 62,3 s | 8.655.135 B | 2,96 GiB |

O codec de origem selecionou CUDA. A saída NVDEC teve 45,89 dB contra a saída decodificada em CPU
e 40,62 dB contra o render integral corrigido. Cada valor de tempo vem de uma execução.

As sondas para a etapa de composição em GPU passaram com 12 frames em CUDA → `scale_cuda` → NVENC
e D3D11 → NVENC. O FFmpeg pinado devolveu `Function not implemented` no mapeamento direto
CUDA → Vulkan e `80070057` na criação da textura de saída do `scale_d3d11` em NV12.
As sondas usaram o vídeo sem autorrotação e mediram a passagem de superfícies entre estágios.

## A001 — composição em VRAM (EDT-103, etapa 2)

O A001 de 1080×1920 e 30 fps foi renderizado com `--vram --gpu hardware --workers 1 --preset standard`,
no FFmpeg LGPL `N-129308-g17de9f8597` e no driver NVIDIA 610.88. A rodada começou com 3,72 GiB de RAM livre.
O FFmpeg negociou superfícies Vulkan da decodificação até o encoder. O Chrome produziu 550 PNGs de
sobreposição e a GPU recebeu essas camadas por upload. A comparação decodificou os 1357 frames do MP4
com o FFmpeg anterior e usou o mesmo render integral do EDT-100 como referência.

| A001 | Total | Composição e encode | Tamanho do MP4 | PSNR contra o integral |
|---|---:|---:|---:|---:|
| Camadas com decodificação em CPU (EDT-102) | 164,5 s | 75,1 s | 9.815.720 B | 40,75 dB |
| Compositor Vulkan (EDT-103) | 106,7 s | 20,5 s | 10.994.811 B | 42,22 dB |

O MP4 Vulkan ficou 5,4% maior que o render integral de 10.428.578 B. O menor PSNR por frame foi 38,96 dB.
O FFmpeg anterior produziu AV1 inválido em VBR na RTX 4060. O novo pin passou pela sonda com
decodificação do bitstream e pela comparação dos 1357 frames. A rotação no libplacebo respeitou a
largura visível da superfície H.264 alinhada a macroblocos.

## A001 — sonda de captura CEF (EDT-103, etapa 3)

A [sonda Windows](../scripts/cef-probe/README.md) abriu o A001 compilado a 1080×1920 e 30 fps com CEF
158.0.6, BeginFrame externo e textura D3D11 compartilhada na RTX 4060. A rodada começou com 2,71 GiB
de RAM livre e durou **55,7 s** do primeiro BeginFrame até a drenagem do libplacebo. Houve **550 texturas
distintas aceitas**, **1.357 frames Vulkan** entregues ao filtro com PTS sequencial e zero callbacks em
software. A sonda descartou sete callbacks com o marcador de um seek anterior.

O FFmpeg importou a textura D3D11 em um dispositivo Vulkan com o mesmo LUID. O retângulo da composição
ficou na GPU durante a cópia e a filtragem. A sonda leu oito bytes por candidato, fora do quadro,
para validar o seek e o alfa pré-multiplicado. Esse tempo cobre captura e filtragem da camada HTML.
Na integração com `--vram --gpu hardware --workers 1 --preset standard` no Windows x64, o mesmo
dispositivo Vulkan recebe o vídeo decodificado, as 555 texturas distintas do CEF e o gradiente.
A barra é calculada por shader. O grafo entregou 1.357 frames ao encoder AV1 e registrou zero
callbacks em software. A inspeção de layout levou 21,38 s, a captura com composição e encode
levou 59,89 s e a execução completa levou **91,46 s**, incluindo o áudio AAC e a montagem do MP4.

A edição atual do A001 (com swoosh) foi a referência visual da comparação. O MP4 de 11.146.097 B
atingiu **43,82 dB** de PSNR em média e **40,20 dB** no pior frame. O teste do bitstream decodificou
todos os frames de vídeo e a trilha AAC estéreo. O caminho CEF acelerado no Linux segue pendente.
