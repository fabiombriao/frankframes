# FrankFrames

Vídeo determinístico a partir de HTML. Sem React, sem bundler, sem GSAP, sem encoder GPL.

```bash
node packages/cli/src/cli.ts render examples/hello.html -o out/hello.mp4
```

## Estado

| Peça | Estado |
|---|---|
| `packages/contract` | ✅ parser + tempo + duração + diagnósticos |
| `packages/encode` | ✅ presets AV1/VP9/openh264, guarda de licença (bloqueia GPL/x264) |
| `packages/engine` | ✅ relógio virtual, seek, captura atômica, vídeo fora de banda, paralelismo, shell pinado, fontes, taxonomia de falha, limpeza de órfão |
| `packages/producer` | ✅ pipeline completo: compile → probe → extract → capture → audio → encode → assemble |
| `packages/cli` | ✅ `lint`, `render`, `preview`, `transcribe`, `captions`, `blocks`, `models`, `init`, `doctor`, `setup`, `upgrade`, `browser`, `skill`, `frames` |
| `packages/transcribe` | ✅ local (opt-in), Groq e OpenAI-compatible — nada baixa sem comando explícito |
| `catalog/blocks` | ✅ 36 blocos prontos (22 paisagem 16:9 + 14 vertical 9:16) + `frankframes blocks add` |
| `skills/` | ✅ duas skills de agente: `frankframes` (contrato) e `frankframes-generate` (pedido em texto → MP4 conferido) |

Determinismo é teste, não promessa:

- `packages/engine/test/determinism.test.ts` — 60 frames × 2 execuções + 1 em ordem invertida, no caminho padrão (`auto`) e em software.
- `packages/engine/test/media.test.ts` — MP4 de teste extraído por FFmpeg; `<video>` vira `<img>` e a captura continua estável.
- `packages/producer/test/render.test.ts` — HTML → MP4 com áudio, 45 frames, dois renders com exatamente os mesmos hashes.

Captura e mídia seguem a mesma política:

- Uma leitura por frame, depois do paint. O primeiro frame de cada sessão é o único que exige três
  leituras idênticas; `FRANKFRAMES_CAPTURE_SHOTS=3` força o modo conservador em todos os frames.
- Composição com vídeo roda sempre em software, independentemente da GPU disponível.
- Frames extraídos ficam em `<assetHome>/cache/frames` com teto de 2 GiB; o mais antigo sai primeiro.
  Fora do repo, `<assetHome>` é `~/.frankframes`, então o cache fica em `~/.frankframes/cache/frames`.

GPU é o padrão; sem GPU utilizável cai para SwiftShader. Igualdade byte a byte entre máquinas é
prometida em `software`; em `hardware` a garantia é "igual nesta máquina".

## Uso

```bash
npm install
node scripts/fetch-fonts.ts              # 25 famílias OFL (~1 MB) em vendor/fonts
node scripts/vendor-ffmpeg.ts            # FFmpeg LGPL pinado (~270 MB) em vendor/ffmpeg
node packages/cli/src/cli.ts browser install   # shell pinado 158 + verificação de SHA-256

npm test
node packages/cli/src/cli.ts lint examples/hello.html
node packages/cli/src/cli.ts studio examples/cena-dupla/index.html   # player + timeline + inspetor
node packages/cli/src/cli.ts gallery            # galeria dos 48 blocos no navegador
node scripts/showreel.ts                       # showreel MP4 com os 48 blocos (~3 min de vídeo)
node packages/cli/src/cli.ts preview examples/hello.html --open
node packages/cli/src/cli.ts render examples/hello.html -o out/hello.mp4 --preset draft --workers 4
node packages/cli/src/cli.ts render entrada.html --gpu software --no-loudness
node packages/cli/src/cli.ts render entrada.html --json
node packages/cli/src/cli.ts render --batch lote.json --concurrency 2   # lote com variáveis: docs/batch.md
node packages/cli/src/cli.ts blocks list
node packages/cli/src/cli.ts blocks add title-card ./meu-video
node packages/cli/src/cli.ts blocks index --json          # índice com sha256 de cada bloco
node packages/cli/src/cli.ts blocks publish dist/catalogo # diretório pronto para hospedar
node packages/cli/src/cli.ts blocks serve dist/catalogo   # servidor local com o catálogo
node packages/cli/src/cli.ts transcribe audio.wav --language pt
node packages/cli/src/cli.ts models install whisper-large-v3-turbo   # ~1,5 GB, só por este comando

node scripts/generate-catalog.ts          # recalcula o sha256 dos meta.json e regenera catalog/README.md
node scripts/check-ffmpeg.ts <caminho-do-ffmpeg>
node scripts/check-gpu.ts
```

Requer Node ≥ 22.18 (executa TypeScript direto, sem build). FFmpeg/FFprobe vêm do `PATH` ou de
`FFMPEG_PATH`/`FFPROBE_PATH`.

## Estrutura

```
packages/contract   contrato puro: nada de DOM, I/O ou browser
packages/encode     política de codec e args de FFmpeg
packages/engine     browser pinado, relógio virtual, captura, mídia, fontes
packages/producer   pipeline HTML -> MP4 e mixagem de áudio
packages/transcribe transcrição: local opt-in, Groq, OpenAI-compatible
packages/catalog    leitura dos blocos do catálogo
packages/cli        interface de linha de comando
catalog/README.md    índice dos 48 blocos (gerado por scripts/generate-catalog.ts)
catalog/blocks      48 composições prontas (28 paisagem 16:9 + 20 vertical 9:16)
skills/             skills para agente de código (frankframes, frankframes-generate)
docs/getting-started.md  do zero ao MP4 em 5 minutos
docs/contract.md    a especificação (fonte de verdade)
docs/licensing.md   LGPL, patentes, marcas e o que o usuário pode distribuir
docs/transitions.md encadear cenas e a regra do animation-delay absoluto
examples/cena-dupla duas cenas com faixa de transição, 8 s
docs/encode.md      presets e regras de licença
docs/transcribe.md  política de custo da transcrição
vendor/fonts        25 famílias OFL-1.1 (Inter é o padrão)
vendor/ffmpeg       build LGPL pinado + LICENSE + SOURCE (binários fora do versionamento)
PROVENANCE.md       método e limites de reuso
```

## CI

O gate roda local, sem serviço externo: `node scripts/ci.ts` (7 etapas; tempos por etapa em
`docs/ci.md`). Para rodar antes de cada push: `node scripts/install-hooks.ts`.

## Regras do projeto

- Contrato inválido **bloqueia** o render. Nunca há "renderizou com sucesso e saiu errado".
- Duração não é estimada: é autoral, derivada ou `unresolved` com a lista do que falta.
- Nenhum encoder GPL entra no caminho de distribuição.
- Fonte de CDN é proibida: só o que está em `vendor/fonts`.
- A spec vem antes do código. PR que muda comportamento muda `docs/contract.md` no mesmo commit.

## Licença

Proprietária — todos os direitos reservados. Ver `LICENSE`. Dependências de terceiros em
`THIRD-PARTY-NOTICES.md`. Método de desenvolvimento independente em `PROVENANCE.md`.
