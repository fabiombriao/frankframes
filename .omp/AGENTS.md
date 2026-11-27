# FrankFrames — contexto do projeto

Produto proprietário de Fábio Morales Brião (CNPJ 34.681.339/0001-12): transforma HTML em MP4
determinístico. Não é fork, não usa código de framework de vídeo alheio. Ver `PROVENANCE.md`.

## O que existe

```
packages/contract    parser HTML, tempo (data-start), duração, diagnóstico. Sem I/O.
packages/encode      presets AV1/VP9/openh264, guarda de licença (bloqueia GPL)
packages/engine      browser pinado, relógio virtual, seek, captura, mídia fora de banda, fontes
packages/producer    compile (sub-composições) -> probe -> extract -> capture -> audio -> encode -> assemble
packages/transcribe  local (opt-in), Groq, OpenAI-compatible
packages/catalog     leitura dos blocos
packages/cli         lint, render, preview, studio, transcribe, blocks, models, browser, init, doctor, setup
catalog/blocks       48 composições prontas (16:9 e 9:16)
skills/frankframes   skill para agente (fonte em skills/, cópia em packages/cli/skill)
```

## Comandos

```bash
node scripts/ci.ts              # gate: typecheck, testes, doctor, render de fumaça
node scripts/ci.ts --fast       # 5 s: typecheck + testes rápidos
node packages/cli/src/cli.ts render examples/hello.html -o out/v.mp4 --preset draft
node packages/cli/src/cli.ts lint examples/hello.html --json
node packages/cli/src/cli.ts reframe podcast.mp4 -o out/podcast --start 12 --duration 30
node packages/cli/src/cli.ts doctor
node scripts/fetch-fonts.ts     # fontes OFL em vendor/fonts
node scripts/vendor-ffmpeg.ts   # FFmpeg LGPL pinado em vendor/ffmpeg
```

Node ≥ 22.18 (TypeScript roda direto, sem build). Nada de bundler.

## Invariantes

1. **Contrato inválido bloqueia o render.** Nunca "renderizou com sucesso e saiu errado".
2. **Duração não é estimada**: autoral, derivada ou `unresolved` com a lista exata do que falta.
3. **Determinismo é teste**: seek independente de ordem, hash por frame. GPU é padrão (`auto`), SwiftShader é fallback; igualdade de hash só é prometida em `software`, no mesmo SO e arquitetura com o browser pinado (goldens por plataforma em `catalog/goldens/<win64|linux64>`).
4. **Vídeo nunca é decodificado pelo Chrome**: frames extraídos por FFmpeg, `<video>` vira `<img>`.
5. **Tempo resolvido pelo compilador**, não pelo runtime: `data-ff-start`/`data-ff-end`/`data-ff-comp-start`.
6. **Assets são pinados por hash** e vivem em `vendor/` (ou `FRANKFRAMES_HOME`).
7. **Spec antes do código**: `docs/contract.md` é a fonte de verdade; mudança de comportamento muda a spec no mesmo commit.

## Convenções de código

- TypeScript ESM, imports relativos com `.ts`, sem build.
- Comentário em português, identificador em inglês, curto.
- Erro com código estável (`E_*`) e `hint` acionável.
- Teste com `node:test`; teste que depende de Chrome/FFmpeg faz `skip` explícito, nunca passa em silêncio.
- Preferir apagar código morto a manter compatibilidade especulativa.

## Decisões já tomadas

| Tema | Decisão |
|---|---|
| Contêiner/codec | MP4 com AV1 por padrão; VP9/WebM muxa Opus; H.264 só via `libopenh264` com opt-in e aviso de patente |
| GPU | `auto` = hardware quando existe, SwiftShader quando não |
| CI | gate local (`scripts/ci.ts`); **GitHub Actions proibido** (`.omp/RULES.md`) |
| Plataformas | `win64` e `linux64` com browser e FFmpeg pinados por SHA-256; outra plataforma falha alto. Gate Linux em Docker (`scripts/linux/gate.ts`) |
| Transcrição | local só por comando explícito; nunca baixa sozinho |
| Escopo da 1.0 | EDT-5, EDT-19, EDT-34 e EDT-63 ficam **pós-1.0** (titular, 2026-11-24, decidido duas vezes; rótulo `pos-1.0` no Jira). "Terminar o Jira" não os reabre; não perguntar de novo |
| Distribuição | tarball único `@frankframes/cli` compilado por `scripts/build-release.ts`, instalado com `npm i -g`; os pacotes do monorepo seguem TS sem build; sem instalador nativo (`docs/release.md`) |

## Jira

Projeto **EDT** (`https://ia2bhub.atlassian.net`). Backlog em `jira/backlog.json` é a fonte de verdade;
sincronize com `node scripts/jira.ts seed|sync|list|show`. Credenciais em `.env` (ignorado).
Nunca criar itens direto no Jira sem atualizar o backlog.

## Revisão

Antes de declarar pronto: gate verde, e para mudança de comportamento, um teste que falharia sem ela.
Revisão adversarial já pegou 24 defeitos; assuma que caminho feliz não é cobertura.
