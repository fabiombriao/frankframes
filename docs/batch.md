# Exportação em lote

Várias versões do mesmo modelo (ou vários HTML) renderizadas numa fila, com um relatório no fim. Os
valores que mudam entram por **variáveis** (`data-var`, `data-var-attr`; spec em `docs/contract.md` §11).

## Duas formas de chamar

```bash
# vários HTML, uma pasta de saída: <pasta>/<nome>.mp4
node packages/cli/src/cli.ts render a.html b.html c.html -o out/lote/ --preset draft

# um arquivo de lote, com variáveis por job
node packages/cli/src/cli.ts render --batch lote.json --concurrency 2
```

Com mais de uma entrada, `-o` é uma **pasta** (um nome de arquivo é erro). Em `--batch` as entradas e as opções de
render vêm do arquivo: `-o`, `--codec`, `--preset`, `--gpu`, `--no-loudness`, `--keep` e entradas na linha de
comando são recusados (exit 2). `--concurrency`, `--workers` e `--json` valem nas duas formas.

## Arquivo de lote

```json
{
  "version": 1,
  "concurrency": 2,
  "defaults": { "preset": "standard", "codec": "av1", "gpu": "auto", "loudness": true },
  "jobs": [
    {
      "id": "cliente-a",
      "entry": "promo/index.html",
      "out": "out/cliente-a.mp4",
      "vars": { "titulo": "Oferta A", "foto": "assets/a.jpg" },
      "preset": "draft"
    }
  ]
}
```

- Caminhos relativos valem a partir da **pasta do arquivo de lote**.
- `id`: `^[a-z0-9][a-z0-9-]*$`, único. `out`: único (no Windows, sem diferenciar maiúsculas) e com a extensão do
  codec (`.mp4` para av1/h264, `.webm` para vp9).
- `defaults` e cada job aceitam `preset`, `codec`, `gpu` e `loudness`; o job sobrescreve o default.
  `loudness: false` entrega o mix sem normalizar.
- `vars`: texto→texto. **Sem `vars`, o job renderiza com os valores autorais.** Com `vars` (mesmo `{}`), toda
  variável do HTML precisa ter valor e toda chave precisa ser usada (`E_VAR_MISSING`, `E_VAR_UNKNOWN`).
- Campo desconhecido é erro, para um erro de digitação não virar opção ignorada.

Arquivo malformado é `E_BATCH_INVALID` (exit 1), com o campo e o índice do job (`jobs[1].out: …`), **antes** de
qualquer render. Também antes: confere que cada `entry` existe, e o guarda de licença do encoder roda uma vez por
codec usado.

## Concorrência

`--concurrency N` (padrão 1; ou `concurrency` no arquivo) é o número de jobs ao mesmo tempo. Com N > 1, cada render
usa `max(1, floor(workers_padrão / N))` workers de captura, para a máquina não ser disputada por N × workers
navegadores. `--workers` explícito vale **por job**: `--concurrency 2 --workers 4` abre até 8 navegadores, e a conta é de
quem escolheu. Os frames extraídos de um mesmo vídeo são compartilhados entre jobs que rodam juntos (uma extração só).

Uma falha de job **não** para a fila. **Ctrl+C** para de pegar jobs novos e cancela os que rodam (mesmo caminho do
cancelamento do render: FFmpeg e navegadores encerram, `.partial` e temporários são apagados); os jobs que não
começaram entram no relatório como `E_CANCELED`. Um segundo Ctrl+C sai na hora.

## Relatório e saída

O relatório é sempre gravado em `batch-report.json`, na pasta do arquivo de lote (ou na pasta do `-o`). Com `--json`
o mesmo conteúdo vai para a saída padrão.

```json
{
  "ok": false, "total": 3, "succeeded": 2, "failed": 1, "elapsedMs": 81200,
  "jobs": [
    { "id": "cliente-a", "entry": "…", "out": "…", "ok": true, "frames": 300, "durationSeconds": 10, "elapsedMs": 30100, "warnings": [] },
    { "id": "cliente-b", "entry": "…", "out": "…", "ok": false, "elapsedMs": 400,
      "error": { "ok": false, "code": "E_VAR_MISSING", "stage": "compile", "message": "…", "diagnostics": [] } }
  ]
}
```

`error` é o mesmo payload de `render --json` (sem caminho absoluto). A saída de texto traz uma linha por job e o
total, por exemplo `2/3 ok · 81,2 s`. **Exit 0** se todos os jobs renderizaram; **exit 1** se algum falhou, foi
cancelado ou se o lote é inválido.
