# FrankFrames

Vídeo determinístico a partir de HTML. Sem React, sem bundler, sem GSAP, sem encoder GPL.

## Estado

| Peça | Estado |
|---|---|
| `packages/contract` | ✅ parser + resolução de tempo + duração + diagnósticos + testes |
| `packages/encode` | ✅ presets, args de FFmpeg, guarda de licença (bloqueia GPL/x264) |
| `packages/cli` | ✅ `lint` (humano e `--json`) |
| `packages/engine` | 🟡 E1–E4: sessão, relógio virtual, seek, captura atômica, vídeo fora de banda (extração + `<img>`), gate de determinismo. Falta: shell pinado por hash, paralelismo, taxonomia de falha, fontes embarcadas |
| `packages/producer` | ⛔ não existe |
| `packages/transcribe` | ⛔ planejado (local, Groq, OpenAI-compatible) |

Determinismo é teste, não promessa: `packages/engine/test/determinism.test.ts` roda 60 frames ×
2 execuções + 1 em ordem invertida, no caminho padrão (`auto`) e em software. GPU é o padrão; se não
existir GPU utilizável, cai para SwiftShader.

`packages/engine/test/media.test.ts` gera um MP4 de teste, extrai os frames por FFmpeg e prova que o
`<video>` é substituído por `<img>` e que a captura continua estável.

## Uso

```bash
npm install
npm test
node packages/cli/src/cli.ts lint examples/hello.html
node packages/cli/src/cli.ts lint examples/hello.html --json
node scripts/check-ffmpeg.ts <caminho-do-ffmpeg>
node scripts/check-gpu.ts
```

Requer Node ≥ 22.18 (executa TypeScript direto, sem build).

## Estrutura

```
packages/contract   contrato puro: nada de DOM, I/O ou browser
packages/encode     política de codec e args de FFmpeg
packages/cli        interface de linha de comando
docs/contract.md    a especificação (fonte de verdade)
docs/encode.md      presets e regras de licença
PROVENANCE.md       método e limites de reuso
examples/hello.html composição mínima
```

## Regras do projeto

- Contrato inválido **bloqueia** o render. Nunca há "renderizou com sucesso e saiu errado".
- Duração não é estimada: é autoral, derivada ou `unresolved` com a lista do que falta.
- Nenhum encoder GPL entra no caminho de distribuição.
- A spec vem antes do código. PR que muda comportamento muda `docs/contract.md` no mesmo commit.

## Licença

Proprietária — todos os direitos reservados. Ver `LICENSE`. Dependências de terceiros em
`THIRD-PARTY-NOTICES.md`. Método de desenvolvimento independente em `PROVENANCE.md`.
