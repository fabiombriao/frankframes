# Release

A distribuição do FrankFrames é **um tarball só**, `@frankframes/cli`, compilado. Este documento diz como
gerar, verificar e instalar esse tarball, e por que ele é um só.

## Gerar

```bash
node scripts/build-release.ts            # padrão: out/release
node scripts/build-release.ts --out out/outra-pasta
```

Produz `out/release/frankframes-cli-<versão>.tgz` (a versão vem de `packages/cli/package.json`) e o estágio
`out/release/stage/` de onde o tarball sai. O build:

1. compila `packages/*/src` (TypeScript) para JavaScript com `tsconfig.build.json`;
2. reescreve os imports `@frankframes/<pacote>` para caminho relativo dentro do estágio;
3. copia o que é lido em runtime e não passa pelo compilador: `packages/cli/src/studio`, `packages/cli/skill`,
   `catalog/blocks`, `catalog/motion/thumbs`, `docs/` (sem `plano-1.0.md`), `LICENSE`, `THIRD-PARTY-NOTICES.md` e
   `CHANGELOG.md` (obrigatório a partir da 1.0.0);
4. gera o `package.json` do estágio (`bin.frankframes`, `engines.node >=22.18`, só as dependências de produção na
   versão exata do `package-lock.json`);
5. valida o estágio (nenhum `.ts"` nem `@frankframes/` sobrando no JS, todo arquivo de `files` presente, shebang no
   `cli.js`) e roda `npm pack`.

Ficam de fora, de propósito: `vendor/` (o `setup` baixa), `catalog/goldens*`, testes e `scripts/`. O build só apaga
uma pasta de saída vazia ou criada por ele mesmo.

## Verificar

```bash
node scripts/ci.ts --release                                          # gate completo + as 3 etapas abaixo
node scripts/verify-release.ts out/release/frankframes-cli-1.0.0.tgz  # só a instalação real
node scripts/third-party.ts --check                                   # só os avisos de terceiros
```

O `--release` roda o gate de sempre e depois `build release`, `avisos` e `instalar tarball`
(`verify-release.ts`: instala o tgz num prefixo temporário com `npm install` e roda o bin instalado —
`--version`, `doctor`, `init`, `lint --json`, `blocks list`, `studio` e um `render --preset draft` de 1 s conferido
com ffprobe). Etapas, tempos e o que cada uma reprova estão em [`ci.md`](ci.md). A instalação é a única parte do
gate que usa rede (o registro npm, para `parse5`, `puppeteer-core` e transitivas).

Antes de publicar uma versão: suba a versão nos `package.json` (raiz e `packages/*`), atualize o `CHANGELOG.md` e
rode `npm install --package-lock-only` para o lock acompanhar.

## Instalar

```bash
npm i -g out/release/frankframes-cli-1.0.0.tgz
frankframes --version     # 1.0.0
frankframes setup         # baixa fontes, FFmpeg LGPL e browser pinados, conferidos por SHA-256
frankframes doctor        # tudo em ok? senão ele diz qual comando rodar
```

O tarball não leva o FFmpeg nem o browser: o `setup` os baixa para `~/.frankframes` (ou para a pasta de
`FRANKFRAMES_HOME`) e confere o SHA-256 de cada um; rodar de novo só baixa o que falta. Plataformas suportadas:
`win64` e `linux64`; em outra, o `setup` e o `doctor` falham alto.

Para remover: `npm rm -g @frankframes/cli`. Os arquivos baixados pelo `setup` ficam em `~/.frankframes` e são
apagados à mão.

## Por que um tarball único e não pacotes por workspace

O monorepo tem sete pacotes (`contract`, `encode`, `engine`, `producer`, `transcribe`, `catalog`, `cli`) que
exportam `src/*.ts`, e o Node 24 **não executa `.ts` dentro de `node_modules`**
(`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`). Publicar os sete como estão não funcionaria depois de instalados.
Publicar os sete compilados exigiria trocar o `exports` de cada pacote e manter dois modos de resolução (fonte no
repositório, JavaScript no pacote), mais um catálogo lido de fora do pacote por `new URL("../../../catalog/blocks/",
import.meta.url)`.

No tarball único o estágio **espelha o layout do repositório** (`packages/<pkg>/src/*.js`, `catalog/`, `docs/`),
então esses caminhos relativos continuam valendo sem mudar uma linha de código; o `@frankframes/cli` é o único
nome instalável (é o que o `upgrade` consulta) e os pacotes internos viajam dentro dele. O desenvolvimento segue
em TypeScript sem build: o build de release existe só para empacotar.
