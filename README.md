# FrankFrames

Vídeo determinístico a partir de HTML. Sem React, sem bundler, sem GSAP, sem encoder GPL.

## Estado

| Peça | Estado |
|---|---|
| `packages/contract` | ✅ parser + resolução de tempo + duração + diagnósticos + testes |
| `packages/encode` | ✅ presets, args de FFmpeg, guarda de licença (bloqueia GPL/x264) |
| `packages/cli` | ✅ `lint` (humano e `--json`) |
| `packages/engine` | ⛔ não existe — próximo passo (captura determinística) |
| `packages/producer` | ⛔ não existe |

Determinismo já provado fora do repositório: 30 frames, duas execuções e ordem invertida → hashes
idênticos. O teste versionado entra junto com o engine.

## Uso

```bash
npm install
npm test
node packages/cli/src/cli.ts lint examples/hello.html
node packages/cli/src/cli.ts lint examples/hello.html --json
node scripts/check-ffmpeg.ts <caminho-do-ffmpeg>
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
