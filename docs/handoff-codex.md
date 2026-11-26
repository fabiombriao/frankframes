# Handoff para o Codex — 2026-11-26

Daqui em diante o desenvolvimento do FrankFrames segue no Codex. Este documento é o ponto de partida: o estado
do projeto, as regras que não mudam e a fila de trabalho, em ordem. Leia antes de mexer em qualquer coisa:

1. `.omp/RULES.md` — regras duras (valem para toda resposta e todo subagente);
2. `.omp/AGENTS.md` — o que existe, comandos, invariantes, decisões já tomadas, Jira;
3. `docs/contract.md` — a spec; comportamento novo muda a spec no mesmo commit;
4. este arquivo.

`CLAUDE.md` descreve duas sessões do Claude Code (planejador e executor) e os agentes em `.claude/agents/`.
No Codex não há essa divisão: a mesma sessão planeja, implementa, roda o gate, faz commit, push e atualiza o Jira,
seguindo as mesmas regras.

## 1. Estado

- **Versão 1.0.0 lançada em 2026-11-24.** Depois dela entraram EDT-93 a EDT-99 (legendas em karaokê, edição de
  legenda no Studio, sub-composição sem `<br>` dobrado), descritos em `CHANGELOG.md`, seção "Próxima versão",
  ainda sem tag.
- `main` em `4d262c9`, igual a `origin/main`, árvore limpa.
- Itens adiados para depois da 1.0, por decisão do titular (não reabrir nem perguntar de novo): **EDT-5, EDT-19,
  EDT-34, EDT-63** (rótulo `pos-1.0`).
- Studio de teste do A001: `node packages/cli/src/cli.ts studio out/a001/index.html --port 5178` (a partir de
  `frankframes/`; a mesma linha está em `../.claude/launch.json`).

## 2. Como trabalhar

- Node ≥ 22.18, TypeScript direto, sem build. `node scripts/ci.ts --fast` (≈5 s) durante o trabalho;
  `node scripts/ci.ts` verde antes de dizer que está pronto e antes de cada commit.
- Mudança de comportamento: spec em `docs/contract.md` + um teste que falharia sem a mudança + entrada no
  `CHANGELOG.md` (seção "Próxima versão"), no mesmo commit.
- **Jira:** `jira/backlog.json` é a fonte de verdade. Item novo entra primeiro no backlog (épico certo,
  `summary`, `points`, `labels`, `acceptance`) e só então `node scripts/jira.ts seed`; depois
  `node scripts/jira.ts comment|move`. Nunca criar item direto no Jira. Editar o JSON preservando acentos
  (`ensure_ascii=False`, indentação 2, `\n` no fim). Credenciais só no `.env`: nunca ler em voz alta,
  imprimir ou versionar.
- Commit no formato do histórico: `fix: …`, `feat: …`, `docs(…): …`, com a chave `(EDT-N)` no fim.
- Vídeo de teste: `C:\Users\rober\Downloads\video-teste.mp4` (8 s, 1080×1920). O A001
  (`out/a001/assets/a001.mov`) é do aceite. Nenhum vídeo entra no repositório; `out/` é ignorado pelo git.
- O titular acompanha pelo celular: respostas curtas, em português, terminando com a decisão que falta (se faltar).
  Não parar só para reportar progresso.

### Máquina

RTX 4060, Ryzen 5 5600X (12 threads), 15,9 GB de RAM, Windows 11. Antes de medir tempo ou rodar o gate, conferir
a memória livre: um supervisor de outro projeto do titular (`OmniCodex`, processos `OmniRoute … run-next.mjs`)
já acumulou processos e zerou a memória, e aí tempo e `E_BROWSER_TIMEOUT` não dizem nada sobre o código.
**Não matar esses processos sem OK explícito do titular.** Piso combinado: 1,5 GB livres para iniciar cada rodada.

## 3. Fila de trabalho

Nenhum destes itens está no Jira ainda. Primeiro passo: registrar no `jira/backlog.json` e semear, como descrito
acima. Ordem sugerida: A, depois B, depois C (C depende de B).

### A. Defeito: filtro CSS do `<video>` some no render

**O que acontece.** O A001 tem `.fill { filter: contrast(1.08) saturate(0.88) brightness(0.92) }` no `<video>`.
No render esse filtro não aparece. Confirmado no A001 lendo a `<img data-ff-media>` substituta: `filter: none`,
`class=""`.

**Causa.** `packages/engine/src/media-shim.ts`, função `swap` (≈ linhas 30–56): a `<img>` substituta recebe só
`data-ff-*` e um `cssText` com `position/left/top/width/height/object-fit/object-position/display`. A classe, o
`style` inline e as demais propriedades visuais do vídeo (`filter`, `opacity`, `border-radius`, `mix-blend-mode`,
`clip-path`…) se perdem.

**Correção a decidir na spec** (`docs/contract.md`, bloco "A `<img>` substituta", ≈ linha 103):
copiar a classe e o `style` inline do vídeo resolve regras como `.fill { … }`, mas não regras que miram o tipo
(`video { … }`, `video.fill { … }`). Mais robusto: copiar para a `<img>` os valores **computados** das propriedades
visuais do vídeo, como já é feito com `object-fit`. Escolher uma, registrar o limite na spec.

**Aceite.** Teste que falharia hoje: composição com `<video class="x">` e `.x { filter: … }` (e uma regra por
tipo `video { … }`, se a escolha cobrir), conferindo o filtro computado da `<img>` substituta e o pixel de um
frame renderizado. Gate verde; goldens que mudarem por causa disso precisam de justificativa no commit. Medir
o A001 antes e depois.

### B. Render por camadas (protótipo pronto, medido no A001)

**Ideia.** Hoje o Chrome desenha a página inteira, vídeo incluído, e cada frame vira uma foto. No modelo por
camadas:

1. o Chrome desenha **só o que vai por cima do vídeo**, com fundo transparente, e só tira foto quando algo
   mudou desde o frame anterior;
2. o FFmpeg monta o vídeo (cortes, câmera, cor), põe as camadas por cima, desenha a barra de progresso e
   codifica na placa (`av1_nvenc`).

**Resultado no A001** (45,23 s, 1357 frames, 1080×1920):

| | hoje, `--gpu hardware` | hoje, `auto` (vídeo força software, contract §9) | protótipo |
|---|---|---|---|
| tempo total | 131,6 s | 159,5 s | **≈ 60 s** |
| Chrome | — | — | 33,3 s (3 Chromes; 80,8 s com 1) |
| FFmpeg compor + codificar | — | — | 27,1 s |

- Fotos únicas: **550 de 1357** frames; o resto repete a camada anterior.
- Fidelidade contra o render de hoje (sem o filtro de cor nos dois, ver A): PSNR médio **32,3 dB**, mín 22,2
  (frames 135, 981, 1161). Referência: software × hardware de hoje dá 53,4 dB.
- Vantagem extra: sem `<img>` de vídeo dentro do Chrome, some o motivo de "composição com vídeo roda sempre em
  software" (contract §9: a textura da `<img>` fora de banda atrasa no compositor de GPU). A camada pode rodar
  em hardware.

**O que falta para ficar fiel.**

- **Vidro sobre o vídeo:** `backdrop-filter: blur(18px)` dos cards desfoca o vídeo por trás deles. Na camada
  transparente não há vídeo atrás, então o desfoque some. Precisa de máscara por região exportada pela página
  e desfoque no compositor.
- **Câmera sub-pixel:** o protótipo faz `scale` + `crop` em pixel inteiro; o Chrome recorta em fração de pixel
  (`object-view-box`). É a maior parte da diferença no terceiro trecho.
- **Barra de progresso e câmera estão fixas no script** do protótipo, copiadas do A001. No produto elas vêm do
  manifest: clips (`start`, `duration`, `offset`), `data-camera` (zoom de/para, foco `fx/fy`, curva) e o motion
  de cada elemento.
- **Tamanho:** 15,4 MB a `-cq 34` contra 10,6 MB hoje; ajustar a qualidade para o mesmo tamanho antes de comparar.
- Rodar só quando a composição tem vídeo; sem vídeo, o caminho de hoje continua.

**Arquivos do protótipo** (fora do produto, em `out/a001/prototipo/`, ignorado pelo git; não apagar):

- `camadas.ts [hardware|software] [workers]`: gera `out/a001/camadas.html` (o `index.html` sem `<video>`, com
  fundo transparente e a barra escondida), abre N Chromes por faixa contígua de frames e escreve `png/NNNNN.png`
  mais `camadas.ffconcat`.
  - Assinatura por frame: valor **computado** de cada propriedade animada em `document.getAnimations()`, mais a
    `visibility` de cada `[data-ff-start]`. Comparar o progresso da animação não serve: trilha parada avança sem
    mudar pixel (dava 1140 fotos em vez de 550).
- `compor.ts [cq]` com `FILTRO=0` para desligar o filtro de cor: monta o grafo em `grafo.txt` e codifica.
  - Câmera: bisseção da `cubic-bezier(0.34,0.1,0.18,1)` dentro da expressão do FFmpeg.
  - Cor: `lutrgb` (contraste) + `colorchannelmixer` (matriz do `saturate` × brilho).
  - Barra: faixa `geq` com borda fracionária.
  - O áudio é copiado de `%TEMP%\ffgpu\a001-hardware.mp4` (render de referência).
- `diag.ts`, `zoom.ts`, `ver.ts`: diagnósticos (o que anima por frame, zoom e filtro reais da `<img>`, manifest).
- `lado-*.jpg`, `cmp/`, `psnr.*`: comparações lado a lado e PSNR por frame.

**Armadilhas do FFmpeg encontradas** (o vendor é LGPL, BtbN):

- `perspective` e `eq` não existem (são GPL). Há `scale`, `crop`, `lutrgb`, `colorchannelmixer`, `overlay`,
  `geq`, `libplacebo`, `overlay_cuda`, `scale_cuda`, `scale_d3d11`.
- `;` dentro de expressão, mesmo entre aspas, corta o grafo. Encadear com `0*(a)+0*(b)+…+(último)`.
- O `crop` não atualiza `in_w` quando o tamanho de entrada muda por frame: calcular `x`/`y` pela mesma expressão
  de zoom.
- O `fps` pode emitir um frame a mais por trecho: usar `trim=end_frame=` por trecho.
- `-filter_complex_script` está obsoleto: usar `-/filter_complex arquivo`.
- `-ss` antes do `-i` bate com os frames do cache de extração do produto.

**Aceite sugerido.** O modo existe atrás de uma opção explícita, cobre só composições com vídeo e lê câmera,
cortes e barra do manifest. Tem desfoque de vidro e câmera sub-pixel. No A001: PSNR ≥ 40 dB contra o render
atual (com A corrigido) e tempo medido em `docs/perf.md`, antes e depois.

### C. Caminho todo na placa de vídeo

**Objetivo.** O frame nunca sai da placa de vídeo: decodificar, compor e codificar sem passar pela RAM, como
fazem CapCut, After Effects e DaVinci. "100% na GPU" não existe em nenhum editor. O processador continua com
layout, JavaScript das animações, áudio, controle e gravação do arquivo, que são poucos milissegundos por frame.

**Onde o frame sai da placa hoje:** o FFmpeg decodifica o vídeo e grava JPEG (CPU). O Chrome lê esses JPEGs
(CPU). O Chrome desenha (GPU). O screenshot copia da placa para a RAM e comprime (CPU, o gargalo). O NVENC
recebe o frame de volta (GPU).

**Etapas, cada uma medida antes da próxima:**

1. **Decodificação na placa (NVDEC)** via `-hwaccel cuda` no FFmpeg vendorizado, alimentando o compositor de B
   direto, sem JPEG. Baixo custo.
2. **Compositor na placa:** câmera, cor, vidro, barra e junção das camadas em filtros de GPU (`libplacebo`,
   `scale_cuda`/`overlay_cuda`) ou em compositor próprio com shaders. Resolve junto a câmera sub-pixel. Custo
   médio; é a continuação de B.
3. **Chrome sem cópia:** trocar o Chrome controlado por fora (puppeteer + screenshot) por Chromium embutido via
   **CEF** (BSD). Com renderização fora da tela e textura compartilhada (D3D11), cada frame desenhado chega ao
   compositor como textura na própria placa. Usar controle externo de BeginFrame para manter o relógio virtual
   frame a frame. Exige módulo nativo (C++ ou Rust), binário de ≈200 MB pinado por SHA-256 como o browser de hoje,
   e build próprio para `linux64`. Custo alto.
4. **Codificação NVENC:** já é assim.

**Restrições.**

- NVENC e NVDEC são só NVIDIA. AMD (AMF) e Intel (QSV) precisam de outro caminho. Sem GPU, o pipeline atual fica
  como reserva.
- Determinismo: no modo GPU continua "visualmente igual", não hash igual; o modo `software` segue sendo o de hash.
- Licença: CEF (BSD) e os cabeçalhos do Video Codec SDK da NVIDIA entram em `THIRD-PARTY-NOTICES.md` e
  `PROVENANCE.md`. Nada GPL.

**Estimativa (não medida):** o A001 cairia para 15–25 s. O limite passaria a ser o seek e o estilo de cada frame
no Chrome; hoje são ≈27 ms por frame via CDP, e embutido deve cair bastante.

**Por que não reescrever do zero.** Um motor nativo com formato de cena próprio, sem Chrome, seria o mais rápido.
Mas o produto é "HTML vira MP4": catálogo de 48 blocos, Studio, legendas e geração por agente dependem de
HTML/CSS. Reimplementar layout e animação de CSS não compensa. O caminho acima mantém o HTML e tira dele só o
que é lento.

## 4. Decisões que não se reabrem

Estão em `.omp/AGENTS.md` ("Decisões já tomadas") e `.omp/RULES.md`. Resumo: AV1 em MP4 por padrão; GPU
`auto`; gate local e GitHub Actions proibido; nenhum encoder GPL (`libx264`, `libx265`, `ffmpeg-static`,
`@ffmpeg-installer`); nenhum GSAP; nenhuma fonte de CDN no render; falhar alto (sem `catch` vazio, fallback
silencioso nem retry cego); nada de código ou texto de framework alheio; itens `pos-1.0` ficam fora.
