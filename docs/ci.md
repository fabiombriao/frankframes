# CI

O gate roda **na máquina de desenvolvimento**. Sem GitHub Actions, sem serviço externo, sem container.

> **Proibição registrada.** GitHub Actions é vedado neste repositório (`.omp/RULES.md`). A regra não é
> só texto: `scripts/check-policy.ts` reprova o gate se `.github/workflows/` existir. Verificado com um
> workflow de teste — o gate saiu com 1 violação e código 1.

## Por quê

| Opção | Custo real | Veredito |
|---|---|---|
| Local (`node scripts/ci.ts`) | ~3 min 24 s, zero download | **escolhido** |
| Docker | build inicial de 8–12 min + ~600 MB de imagem; WSL2 encarece I/O de `node_modules`; assets são win64, então exigiria embarcar FFmpeg Linux e as libs do Chrome | só quando existir artefato de release para reproduzir |
| Nuvem (Actions/Cirrus/AppVeyor) | exige provedor e, no nosso caso, build Linux do FFmpeg + dependências do shell; Actions está proibido | quando houver servidor próprio |

O motivo decisivo: o produto depende de assets **pinados e já presentes** (shell 158, FFmpeg LGPL, 25 famílias). Um runner remoto teria que baixar 470 MB por execução ou manter cache; a máquina local já tem, com hash conferido.

## Etapas

| Etapa | Tempo medido | O que reprova |
|---|---:|---|
| política | 0,2 s | workflow de Actions, dependência GPL/GSAP, CDN no render, `.env` versionado, licença/spec ausente |
| typecheck | 3,8 s | erro de tipo |
| testes rápidos | 4,2 s | contrato, encode, transcrição, catálogo, compilador |
| suíte completa | 183,5 s | qualquer teste, incluindo determinismo, goldens e render ponta a ponta |
| doctor | 1,1 s | browser/FFmpeg/fontes ausentes ou impossíveis de verificar |
| render de fumaça | 9,9 s | pipeline quebrado |
| verificar MP4 | 0,8 s | codec/frames diferente de `av1`/90 |

Soma das etapas: ~3 min 24 s. Os quatro primeiros tempos vêm da última execução registrada em
`out/ci-report.json`; doctor, render e verificação foram medidos com os comandos do gate. Nessa
execução a suíte completa falhou e o gate parou ali — o log completo fica em `out/ci-suite.log`.

Só com `--release` (EDT-65), depois das sete acima — o release é **um tarball só**, `@frankframes/cli`,
compilado (ver "Release" abaixo):

| Etapa | Tempo medido | O que reprova |
|---|---:|---|
| build release | ~10 s (25 s na primeira vez) | erro do `tsc -p tsconfig.build.json`; sobrou `.ts"` ou `@frankframes/` no JS; `import()` dinâmico montado em runtime; arquivo lido por `new URL(…, import.meta.url)` ausente do estágio; shebang perdido; tarball com `vendor/`, goldens ou testes |
| avisos | 2,6 s | dependência de produção sem aviso em `THIRD-PARTY-NOTICES.md` ou com licença fora de MIT/ISC/Apache-2.0/BSD-2-Clause/BSD-3-Clause/0BSD/BlueOak-1.0.0 |
| instalar tarball | ~40 s (usa o registro npm) | `npm install` do tgz, e com o bin instalado: `--version`, `doctor`, `init`, `lint --json`, `blocks list`, `studio`, `render --preset draft` de 1 s e ffprobe (`av1`, 30 frames); no Windows também o shim `frankframes.cmd` |

## Comandos

```bash
node scripts/ci.ts            # gate completo (7 etapas, ~3 min 24 s)
node scripts/ci.ts --fast     # política + typecheck + testes rápidos (8 s)
node scripts/ci.ts --release  # gate completo + build do tarball, avisos de terceiros e instalação real do tgz
node scripts/build-release.ts   # só o tarball: out/release/frankframes-cli-<versão>.tgz
node scripts/third-party.ts --check   # só os avisos de terceiros
node scripts/verify-release.ts out/release/frankframes-cli-<versão>.tgz   # só a instalação real
node scripts/install-hooks.ts # hook de pré-push rodando --fast
```

O hook fica em `.git/hooks/pre-push` e não é versionado — cada clone instala o seu.

## Regras

- O gate começa pela política: ela é a primeira etapa e para a fila em caso de violação.
- O gate **não** usa `.env` nem chama a rede: Jira, upload e IA ficam fora.
- Toda etapa falha alto e para a sequência.
- **Toda etapa tem prazo** (`scripts/ci.ts`, `TIMEOUTS`): política 1 min, typecheck e testes rápidos 5 min,
  suíte completa 25 min, doctor 3 min, render de fumaça 10 min; no `--release`, build 5 min, avisos 2 min e
  instalação do tarball 15 min. Estourou: a etapa
  reprova, o fim da saída dela vai para o terminal, e a árvore de processos inteira (runner de testes e
  Chrome) é encerrada (`taskkill /T /F` no Windows, grupo do processo no POSIX). Um teste que vaza um
  handle aberto aparece como a causa, não como um gate que nunca termina. `--test-force-exit` não é usado:
  esconderia o vazamento.
- Teste que depende de Chrome ou FFmpeg faz `skip` explícito quando o binário não existe — nunca passa em silêncio.
- A promessa de pixel só é verificada no modo `software` (SwiftShader); em `hardware` a garantia é por máquina.
- Goldens comparam hash e, quando diverge, PSNR contra `catalog/goldens/<bloco>/<frame>.png`
  (≥50 dB aceito como jitter de rasterização). A verificação usa 5 leituras por frame e roda 4 blocos
  em paralelo (`FRANKFRAMES_GOLDEN_SHOTS`, `FRANKFRAMES_GOLDENS_CONCURRENCY`), independente do modo
  rápido do render.

## Release

`--release` troca os antigos `npm pack --dry-run` por pacote por três etapas, porque o Node 24 não executa
`.ts` dentro de `node_modules` e os pacotes do monorepo exportam `src/*.ts`:

1. **build release** (`scripts/build-release.ts`): compila `packages/*/src` com `tsconfig.build.json` para um
   estágio `out/release/stage/` que espelha o layout do repositório (`packages/<pkg>/src/*.js`, `catalog/`,
   `docs/`), reescreve `@frankframes/<x>` para caminho relativo, gera o `package.json` com as dependências de
   produção na versão exata do `package-lock.json`, valida o estágio e roda `npm pack` para
   `out/release/frankframes-cli-<versão>.tgz`. `vendor/` e `catalog/goldens*` ficam de fora (o `setup` baixa
   o primeiro; os goldens só servem a teste). A pasta `out/` é ignorada pelo git; `--out <pasta>` troca o destino
   (o teste usa uma pasta temporária) e o build só apaga pastas vazias ou que ele mesmo criou.
2. **avisos** (`scripts/third-party.ts --check`): confere a árvore de produção (`npm ls --omit=dev --all`) com
   `THIRD-PARTY-NOTICES.md` e a lista de licenças permitidas. Sem `--check`, só lista.
3. **instalar tarball** (`scripts/verify-release.ts`): instala o tgz num prefixo temporário e roda o bin
   instalado com `FRANKFRAMES_HOME=<repo>/vendor`. Em falha, imprime o comando que quebrou e mantém o
   diretório temporário para inspeção. É a única parte do gate que usa rede (`npm install`).

`CHANGELOG.md` entra no tarball se existir e é obrigatório a partir da 1.0.0. O teste
`packages/cli/test/release-build.test.ts` (lento, suíte completa) cobre o estágio sem rede.

## Quando migrar para servidor

Existe uma pendência real para CI remoto: publicar e cachear um **FFmpeg Linux LGPL** e as bibliotecas do Chrome headless. Só vale quando o build precisar acontecer sem esta máquina — aí o caminho é um runner próprio (Woodpecker ou Drone em VPS), não um serviço de terceiro com o workflow no repositório.

Forja e CI são decisões separadas: manter o código no GitHub é aceitável; usar o Actions, não. Kamal
**não é CI** — é deploy de containers por SSH; ele entraria depois do build, nunca no lugar do gate.
