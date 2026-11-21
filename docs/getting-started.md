# Começando em 5 minutos

Requisito: Node ≥ 22.18 (o projeto roda TypeScript direto, sem build).

## 1. Preparar a máquina

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

## 3. Ver antes de renderizar

```bash
node packages/cli/src/cli.ts preview meu-video/index.html --open
```

O preview compila a mesma página do render, roda o relógio em tempo real e recarrega sozinho quando você
salva. A barra no rodapé tem play/pause e scrub por frame; o instante fica na URL (`#f=45`).

## 4. Renderizar

```bash
node packages/cli/src/cli.ts render meu-video/index.html -o out/video.mp4 --preset draft --gpu software --no-loudness
```

Saída AV1 em MP4. `--preset draft|standard|high`, `--workers N`, `--json` para máquina.
`--gpu auto|software|hardware` escolhe o caminho de captura (o padrão é `auto`; composição com vídeo
roda sempre em software); `--no-loudness` desliga a normalização de loudness em dois passes.

Frames extraídos de vídeo ficam em cache: `<assetHome>/cache/frames`, com teto de 2 GiB e remoção do
mais antigo primeiro. Dentro do repo, `<assetHome>` é `vendor/`; fora do repo, o cache fica em
`~/.frankframes/cache/frames`.

## 5. Editar a composição

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

Se o provedor devolver tempos por palavra, a legenda sai em **karaokê**: cada palavra acende no
instante exato (`animation-delay` absoluto) e as já faladas ficam na cor de destaque. Sem palavras,
o texto quebra em linhas equilibradas e a fonte encolhe para caber na largura segura.

## 6. Usar um bloco pronto

```bash
node packages/cli/src/cli.ts blocks list
node packages/cli/src/cli.ts blocks add title-card meu-video/abertura
```

`catalog/README.md` é o índice dos 36 blocos (22 paisagem 16:9 + 14 vertical 9:16), gerado por
`node scripts/generate-catalog.ts`; não edite à mão.

## Problemas comuns

| Sintoma | Causa | Correção |
|---|---|---|
| `E_DURATION` no render | mídia sem duração declarada | declare `data-duration` ou deixe o probe medir (arquivo precisa existir) |
| vídeo preto | caminho errado no `src` | caminho é relativo ao arquivo da composição |
| fonte diferente | família fora do catálogo | use um dos 25 nomes em `docs/contract.md` §9b |
| `E_FFMPEG_GPL` | binário com `--enable-gpl` | use o vendor: `node scripts/vendor-ffmpeg.ts` |
