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
| `packages/cli` | ✅ `lint`, `render`, `preview`, `browser check/install` |
| `packages/transcribe` | ⛔ planejado — opt-in apenas (ver `docs/transcribe.md`) |

Determinismo é teste, não promessa:

- `packages/engine/test/determinism.test.ts` — 60 frames × 2 execuções + 1 em ordem invertida, no caminho padrão (`auto`) e em software.
- `packages/engine/test/media.test.ts` — MP4 de teste extraído por FFmpeg; `<video>` vira `<img>` e a captura continua estável.
- `packages/producer/test/render.test.ts` — HTML → MP4 com áudio, 45 frames, dois renders com exatamente os mesmos hashes.

GPU é o padrão; sem GPU utilizável cai para SwiftShader. Igualdade byte a byte entre máquinas é
prometida em `software`; em `hardware` a garantia é "igual nesta máquina".

## Uso

```bash
npm install
node scripts/fetch-fonts.ts              # 25 famílias OFL (~1 MB) em vendor/fonts
node packages/cli/src/cli.ts browser install   # shell pinado 158 + verificação de SHA-256

npm test
node packages/cli/src/cli.ts lint examples/hello.html
node packages/cli/src/cli.ts preview examples/hello.html --open
node packages/cli/src/cli.ts render examples/hello.html -o out/hello.mp4 --preset draft --workers 4
node packages/cli/src/cli.ts render entrada.html --json

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
packages/cli        interface de linha de comando
docs/contract.md    a especificação (fonte de verdade)
docs/encode.md      presets e regras de licença
docs/transcribe.md  política de custo da transcrição
vendor/fonts        25 famílias OFL-1.1 (Inter é o padrão)
PROVENANCE.md       método e limites de reuso
```

## Regras do projeto

- Contrato inválido **bloqueia** o render. Nunca há "renderizou com sucesso e saiu errado".
- Duração não é estimada: é autoral, derivada ou `unresolved` com a lista do que falta.
- Nenhum encoder GPL entra no caminho de distribuição.
- Fonte de CDN é proibida: só o que está em `vendor/fonts`.
- A spec vem antes do código. PR que muda comportamento muda `docs/contract.md` no mesmo commit.

## Licença

Proprietária — todos os direitos reservados. Ver `LICENSE`. Dependências de terceiros em
`THIRD-PARTY-NOTICES.md`. Método de desenvolvimento independente em `PROVENANCE.md`.
