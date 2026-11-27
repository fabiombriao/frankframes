# Começando em 5 minutos

Requisito: Node ≥ 22.18 (o projeto roda TypeScript direto, sem build).

## 1. Preparar a máquina

### Pelo GitHub (código mais recente)

Entre no GitHub com uma conta que tenha acesso ao repositório privado e extraia o ZIP na outra máquina.
[Baixar o `main` do FrankFrames](https://github.com/fabiombriao/frankframes/archive/refs/heads/main.zip).

No Windows x64, abra o PowerShell na pasta extraída `frankframes-main` e rode:

```powershell
npm.cmd ci
node packages/cli/src/cli.ts setup
node packages/cli/src/cli.ts doctor
```

No Linux x64, use `npm ci` para instalar as dependências. Os comandos `setup` e `doctor` são os mesmos.
O `setup` baixa o navegador, o FFmpeg e as fontes. Siga as instruções que o `doctor` mostrar se alguma
dependência estiver faltando.

Para continuar um projeto existente, copie a pasta inteira com o `index.html`, a mídia e as subcomposições.
Na pasta `frankframes-main`, rode o comando abaixo com o caminho real do `index.html`:

```powershell
node packages/cli/src/cli.ts studio "C:\MeusProjetos\video-3\index.html" --port 5183
```

Mantenha o terminal aberto durante a edição e acesse [o Studio](http://127.0.0.1:5183/).
O helper CEF do render `--vram` é instalado à parte no Windows x64. [Instalação do helper](../scripts/cef-probe/README.md#render-completo).

### Pelo tarball (instalação de uso)

```bash
npm i -g frankframes-cli-1.0.0.tgz      # o tgz gerado por `node scripts/build-release.ts` (ver docs/release.md)
frankframes --version
frankframes setup                       # fontes, FFmpeg LGPL e browser pinados, com SHA-256, em ~/.frankframes
frankframes doctor
```

O tarball da aba Releases corresponde à versão publicada. Com ele, use `frankframes <comando>` onde os
exemplos abaixo escrevem `node packages/cli/src/cli.ts <comando>`. [Releases do FrankFrames](https://github.com/fabiombriao/frankframes/releases).

### Pelo clone (desenvolvimento)

```bash
npm install
node scripts/fetch-fonts.ts      # 25 famílias OFL (~1 MB)
node scripts/vendor-ffmpeg.ts    # FFmpeg LGPL pinado (~270 MB)
node packages/cli/src/cli.ts browser install   # shell 158 + verificação de SHA-256
node packages/cli/src/cli.ts doctor
```

`doctor` precisa terminar com `node`, `browser`, `ffmpeg`, `fontes` e `catálogo` em `ok`. Se algo faltar,
ele diz exatamente qual comando rodar.

## 2. Criar um projeto

```bash
node packages/cli/src/cli.ts init meu-video
```

Gera `meu-video/index.html` com uma composição válida de 4 s, 1920×1080, 30 fps — e uma pasta `assets/`.

## 3. Studio (player + timeline)

```bash
frankframes studio meu-video/index.html
```

Abre `http://127.0.0.1:<porta>/` com player no centro, timeline embaixo, inspetor e catálogo na lateral.
Você pode arrastar a barra de um clip para mudar o início, arrastar a borda direita para mudar a duração,
editar `data-start`, `data-duration`, `data-offset`, `data-volume`, `data-audio-role`, `data-playback-rate`
e o texto no inspetor, e inserir blocos no ponto atual da timeline. Cada alteração é validada pelo contrato
e gravada no HTML preservando formatação e comentários; erro de contrato não grava.

Na barra do topo:

- **Importar** (ou arraste o arquivo para a janela): vídeo, áudio ou imagem vai para `assets/` e entra
  como clip no playhead, com a duração medida. Vários arquivos de uma vez entram em sequência. Um `.html`
  (por exemplo `legendas.html`) entra como sub-composição, com a duração da raiz do arquivo.
- **Blocos** (painel lateral): clicar num bloco do catálogo o insere no playhead como sub-composição; a pasta do
  bloco é copiada para `blocks/<slug>/` (igual a `blocks add`). **Inserir texto** cria um `<div>` com "Texto".
- **Legendas** (painel lateral): selecione na timeline o clip de um arquivo gerado por `captions` e o inspetor lista
  cada legenda, com início–fim e o texto. Corrija o texto e tecle Enter (ou toque em **Aplicar**) para gravar no
  arquivo das legendas; o preview recarrega e o desfazer vale para a edição. A linha sob o playhead fica marcada, e
  tocar no tempo leva o playhead ao início dela. Com o mesmo número de palavras, cada uma mantém o tempo; mudando o
  número, as palavras iguais no começo e no fim continuam no tempo delas e só o trecho trocado é repartido pelo
  tamanho das palavras (na inserção ou remoção pura, junto com a palavra vizinha). Enquanto houver texto não
  aplicado, o Exportar espera, e selecionar outro clip descarta esse texto. Arquivo gerado por versão anterior não
  mostra a seção: gere de novo com `captions` (regras em [`contract.md`](contract.md), §7b.8 e §9d).
- **Dividir** (tecla `S`): corta o clip selecionado no playhead em dois, sem mover o resto da timeline.
- **Desfazer / Refazer** (`Ctrl+Z`, `Ctrl+Shift+Z` ou `Ctrl+Y`): vale para toda edição feita no Studio
  nesta sessão. Se você editar o arquivo em outro programa, o histórico é descartado em vez de sobrescrever.
  Desfazer uma importação tira o clip, mas o arquivo continua em `assets/` (bloco: em `blocks/<slug>/`; `.html`: em `compositions/`).

## 4. Ver antes de renderizar

```bash
node packages/cli/src/cli.ts preview meu-video/index.html --open
```

O preview compila a mesma página do render, roda o relógio em tempo real e recarrega sozinho quando você
salva. A barra no rodapé tem play/pause e scrub por frame; o instante fica na URL (`#f=45`).

## 5. Renderizar

```bash
node packages/cli/src/cli.ts render meu-video/index.html -o out/video.mp4 --preset draft --gpu software --no-loudness
```

Saída AV1 em MP4. `--preset draft|standard|high`, `--workers N`, `--json` para máquina.
`--gpu auto|software|hardware` escolhe o caminho de captura (o padrão é `auto`; composição com vídeo
roda sempre em software); `--no-loudness` desliga a normalização de loudness em dois passes.

Frames extraídos de vídeo ficam em cache: `<assetHome>/cache/frames`, com teto de 2 GiB e remoção do
mais antigo primeiro. Dentro do repo, `<assetHome>` é `vendor/`; fora do repo, o cache fica em
`~/.frankframes/cache/frames`.

### Conferir frames

Depois de renderizar, olhe o resultado antes de entregar:

```bash
node packages/cli/src/cli.ts frames out/video.mp4 --at 10%,50%,90% -o out/frames --json
```

Extrai um PNG por instante (`--at` aceita segundos e porcentagens da duração; o padrão é `10%,50%,90%`) e marca
como `uniform: true` o frame **chapado** (cor única), sinal de clip que sumiu ou bloco que não entrou. Abra os PNGs e
compare com o pedido. Erros: `E_FRAMES_INPUT` (arquivo inexistente ou que não é vídeo) e `E_FRAMES_TIME` (instante
fora de `[0, duração)`).

### Lote e variáveis

Marque no HTML o que muda (`<h1 data-var="titulo">Oferta</h1>`, `<img data-var-attr="src:foto">`) e liste as versões
num arquivo de lote:

```json
{ "version": 1, "defaults": { "preset": "draft" },
  "jobs": [
    { "id": "a", "entry": "meu-video/index.html", "out": "out/a.mp4", "vars": { "titulo": "Oferta A", "foto": "a.jpg" } },
    { "id": "b", "entry": "meu-video/index.html", "out": "out/b.mp4", "vars": { "titulo": "Oferta B", "foto": "b.jpg" } }
  ] }
```

```bash
node packages/cli/src/cli.ts render --batch lote.json --concurrency 2
```

Sai um MP4 por job e um `batch-report.json` ao lado do arquivo de lote. Formato, concorrência e relatório em
`docs/batch.md`; variáveis em `docs/contract.md` §11. Para vários HTML sem variáveis:
`render a.html b.html -o out/lote/`.

## 6. Editar a composição

O contrato completo está em [`docs/contract.md`](contract.md). O mínimo:

```html
<div data-composition-id="peca" data-root="true"
     data-width="1920" data-height="1080" data-fps="30" data-duration="4">

  <div data-clip-id="titulo" data-start="0" data-duration="3" class="clip">Olá</div>
  <div data-clip-id="credito" data-start="titulo" data-duration="1" class="clip">depois do título</div>
</div>
```

- `data-start` aceita número, `id` do clip (começa quando ele termina) ou `id + 1` / `id - 0.5`.
- Sem `data-duration` na raiz, a duração é derivada do maior fim — e nunca estimada.
- Erro de contrato **bloqueia** o render: `frankframes lint arquivo.html` diz o código e o que fazer.

## Legendas

```bash
frankframes captions audio.wav -o legendas.html --size 1080x1920
```

Se o provedor devolver tempos por palavra, a legenda sai em **karaokê**: a fala é dividida em legendas
curtas, de até 4 palavras (`--max-words N`; a que ficaria pouco tempo na tela é juntada à vizinha e pode
passar disso), e só a palavra que está sendo falada fica na cor de destaque, as outras em branco (regras em
`docs/transcribe.md`). Sem palavras, sai uma legenda por frase: o texto quebra em linhas equilibradas e a fonte
encolhe para caber na largura segura.

Para cada palavra entrar com movimento, acrescente `--motion` com um preset de entrada
(`frankframes captions audio.wav -o legendas.html --motion "subir dur=0.3"`): com tempos por palavra, a
palavra entra quando é falada; sem eles, as palavras entram em sequência. A duração se ajusta à fala
(`docs/contract.md` §7b.8).

Errou uma palavra? Não precisa transcrever de novo: o texto de cada legenda se corrige no Studio (seção 3).

## 7. Usar um bloco pronto

```bash
node packages/cli/src/cli.ts blocks list
node packages/cli/src/cli.ts blocks add title-card meu-video/abertura
```

`catalog/README.md` é o índice dos 36 blocos (22 paisagem 16:9 + 14 vertical 9:16), gerado por
`node scripts/generate-catalog.ts`; não edite à mão. Mexeu no `index.html` de um bloco? Rode o mesmo
script: ele recalcula o `sha256` do `meta.json` (o índice e a instalação remota exigem o hash exato) e só
reescreve o `meta.json` que mudou.

## 8. Skills para agentes

O repositório traz duas skills em `skills/`: `frankframes` (o contrato: atributos, tempo, motion, fontes) e
`frankframes-generate` (o roteiro para gerar um vídeo inteiro a partir de um pedido em texto: escolhe blocos,
monta o HTML de cenas, roda lint, renderiza em rascunho e confere os frames). Para instalar as duas no projeto atual:

```bash
node packages/cli/src/cli.ts skill install            # .claude/skills/<nome>/SKILL.md
node packages/cli/src/cli.ts skill install --cursor    # .cursor/rules/<nome>.mdc
```

Quem edita `skills/` roda `node scripts/sync-skill.ts` para atualizar a cópia publicada em `packages/cli/skill/`
(e a tabela de presets da skill de geração, que sai do código).

## Gerar a partir de texto

Com o Codex CLI instalado e logado na sua conta ChatGPT, um pedido em texto vira uma composição conferida e um
rascunho em MP4:

```bash
codex login                                    # uma vez; entra com a conta ChatGPT
node packages/cli/src/cli.ts generate "abertura de 6 s para o relatório do trimestre" -o out/abertura
```

O comando confere o HTML (lint, formato, duração), renderiza `out/abertura/draft.mp4`, confere três frames e abre o
Studio com o resultado. O Codex só enxerga texto (skill, contrato, catálogo, presets); mídia sua nunca é enviada.
Detalhes, opções, o que sai da máquina e os códigos de erro: [docs/generate.md](generate.md).

## Problemas comuns

| Sintoma | Causa | Correção |
|---|---|---|
| `E_DURATION` no render | mídia sem duração declarada | declare `data-duration` ou deixe o probe medir (arquivo precisa existir) |
| vídeo preto | caminho errado no `src` | caminho é relativo ao arquivo da composição |
| fonte diferente | família fora do catálogo | use um dos 25 nomes em `docs/contract.md` §9b |
| `E_FFMPEG_GPL` | binário com `--enable-gpl` | use o vendor: `node scripts/vendor-ffmpeg.ts` |
