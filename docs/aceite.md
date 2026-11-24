# Aceite de ponta a ponta com vídeo real (EDT-64)

Roteiro fixo e verificação automática para o último item antes do release. O vídeo do titular nunca entra
no repositório: o projeto de aceite fica em `out/aceite-a001/` (ignorado) e o Studio copia a fonte para
`out/aceite-a001/assets/`. O script `scripts/accept-video.ts` fica fora do gate (`scripts/ci.ts`) porque
precisa do vídeo.

- Fonte: `C:\Users\rober\Downloads\A001_11181126_H685.MOV` (H.264 1920x1080 com rotação -90, exibe 1080x1920, 24 fps, 68,164583 s, AAC estéreo 48 kHz).
- Resultado esperado: MP4 vertical 1080x1920 de 30,000 s (corte de 8 s a 38 s), loudness de entrega, lower-third vertical, legendas.

## Roteiro (tudo pelo Studio, nada editado à mão no HTML)

1. `node packages/cli/src/cli.ts init out/aceite-a001` e abrir
   `node packages/cli/src/cli.ts studio out/aceite-a001/index.html`. O projeto de aceite é **1080x1920** com duração
   **derivada** dos clips (sem `data-duration` na raiz): no inspetor de Composição, largura 1080, altura 1920 e
   "derivada dos clips" marcado.
2. Importar o `.MOV` no playhead 0: clip de 68,164583 s (conferir no ffprobe).
3. Dividir em 8 s e em 38 s; apagar o primeiro e o terceiro pedaço. Esperado: um clip de vídeo com
   `data-offset="8"` e `data-duration="30"` começando em 0. **Comportamento medido:** apagar o primeiro pedaço
   **não reancora** o segundo em 0 (a exclusão não mexe no resto da timeline, §9d): o pedaço fica em `data-start="8"` e
   é movido para 0 pelo inspetor (`data-start`) ou arrastando na timeline.
4. Remover os clips do `init` (kicker/título/régua) ou encurtá-los para 4 s; no painel Blocos, com o playhead em
   5 s, clicar em **Crédito vertical** (`vertical-lower-third`, 1080x1920, 3,5 s): o bloco entra como
   sub-composição no playhead (EDT-88). Aplicar pelo inspetor, **no clip do bloco** (o host), o preset de entrada
   `subir` e o de saída `apagar`. O texto do bloco é o do catálogo ("Helena Vasques"); os clips internos do bloco
   não são editáveis pelo inspetor.
5. Legendas (provedor Groq, `GROQ_API_KEY` no `.env`; só o trecho de 30 s sai da máquina):
   ```
   ffmpeg -ss 8 -t 30 -i A001_11181126_H685.MOV -vn -ac 1 -ar 16000 out/aceite-a001/trecho.wav
   node packages/cli/src/cli.ts captions out/aceite-a001/trecho.wav -o out/aceite-a001/legendas-v2.html --size 1080x1920
   ```
   A CLI lê `GROQ_API_KEY` do ambiente, não do `.env`: exporte-a na sessão antes (sem imprimir). Com o playhead em 0,
   **Importar** `legendas-v2.html` pelo Studio (na repetição do aceite, exclua antes o clip de legendas anterior): entra como sub-composição em 0 com a duração da raiz do arquivo (30 s)
   (EDT-88). Sem a chave, o `transcribe` falha alto; não trocar de provedor.
6. Exportar pelo Studio, preset `standard` (AV1), destino `final.mp4` (fica em `out/aceite-a001/final.mp4`). O Studio
   não sobrescreve (`E_EXPORT_EXISTS`): numa repetição, renomeie o `final.mp4` anterior antes.
7. Conferir `final.mp4` num player: sincronia de lábio nos 30 s (o script não mede sincronia fina).

## Comando de verificação

```
node scripts/accept-video.ts out/aceite-a001/final.mp4 \
  --entry out/aceite-a001/index.html \
  --source "C:\Users\rober\Downloads\A001_11181126_H685.MOV" \
  --spec scripts/accept/keyframes-a001.json \
  --captions out/aceite-a001/legendas-v2.html
```

Grava `out/aceite-a001/aceite.json` (`--out` muda o destino). Saída 0 = tudo passou, 1 = alguma
verificação falhou, 2 = o aceite não chegou a rodar (erro `E_ACCEPT_*` com dica).

## O que o script verifica

| Verificação | Regra |
|---|---|
| `lint` | a entrada passa no contrato |
| `duration.*` | `lint --json` = 30,000 s; ffprobe do MP4 = lint ± 1 frame; `nb_frames` = `frameCountFor(30, fps)` |
| `audio.*` | stream de áudio presente; `input_i` em [-15, -13] LUFS; `input_tp` ≤ -0,9 dBTP; áudio = vídeo ± 1 frame |
| `keyframe[n].match` | frame do MP4 em `t` × frame da fonte em `source`, PSNR da região ≥ `minPsnr` (30 dB); se falhar, tenta os frames vizinhos da fonte (±1) |
| `keyframe[n].motion-enter` | frames em 0,1 s e 0,9 s diferem (PSNR < 40 dB) e o de 0,9 s não é chapado (`uniform` do `inspectFrames`) |
| `keyframe[n].lower-third` / `caption` | a região difere da fonte no mesmo instante (PSNR < 30 dB); fonte = `t` + offset do corte (8 s) |

Detalhes do `keyframes.json`: `t:"palavra"` na legenda vira o início do primeiro segmento do
`legendas.html` mais 0,3 s (a entrada por palavra já terminou); `motion-enter` sem `region` compara o
quadro inteiro; `from`/`to` (padrão 0,1 e 0,9) e `maxPsnr` são opcionais.

## Resultado da execução

Execução de 2026-11-24, versão 0.1.0, Studio no Chrome (painel do app), tudo pelo Studio, nada editado à mão no HTML.
Segunda rodada, depois de EDT-89 (legendas) e EDT-90 (true peak do arquivo codificado): legendas regeneradas
(`legendas-v2.html`), clip antigo excluído e novo importado em 0 s pelo Studio, exportação nova.
`out/aceite-a001/final.mp4`: AV1 + AAC, 1080x1920, 30,000 s, 900 frames, 9,0 MB. Números de `aceite.json`:

| Verificação | Medido | Esperado | |
|---|---|---|---|
| `lint` | 0 erros | ok | ok |
| `duration.lint` / `.mp4` / `.frames` | 30 s / 30 s (dif. 0) / 900 | 30 s ± 1 frame / 900 | ok |
| `audio.stream` / `.duration` | presente / 30 s = 30 s | presente / ± 1 frame | ok |
| `audio.lufs` | -14,85 LUFS | [-15, -13] | ok |
| `audio.truePeak` | -1,20 dBTP | ≤ -0,9 dBTP | ok |
| `keyframe[0].match` (t=1) | PSNR 33,76 dB | ≥ 30 | ok |
| `keyframe[1].match` (t=29,5) | PSNR 40,21 dB | ≥ 30 | ok |
| `keyframe[2].motion-enter` (5,1→5,9) | PSNR 11,03 dB; fim não chapado | < 40 | ok |
| `keyframe[3].lower-third` (t=6) | PSNR 10,18 dB | < 30 | ok |
| `keyframe[4].caption` (t=0,3) | PSNR 17,01 dB | < 30 | ok |

**Aceite aprovado** pelo script (`ACEITE OK`) e pelo titular: sincronia de lábio e legendas (passo 7) aprovadas em 2026-11-24 no `final.mp4` de 1080×1920.

Primeira rodada (mesma data, antes de EDT-89/EDT-90): reprovada só por `audio.truePeak` (-0,77 dBTP, o pico do arquivo
AAC passava do limite porque o `loudnorm` limita o PCM, não o codec) e com legendas estreitas (caixa de 540 px, 4 a
5 linhas). O MP4 daquela rodada ficou em `out/aceite-a001/final-v1.mp4`.

Observações da segunda rodada:

- O render avisa, como esperado, "composição com vídeo: render forçado em software" e, por EDT-90, "true peak do
  arquivo codificado -0.77 dBTP acima do limite -1 dBTP; ganho de -0.43 dB aplicado e áudio recodificado (agora
  -1.20 dBTP, -14.8 LUFS)". A correção custou 0,43 dB de loudness: -14,42 → -14,85 LUFS, ainda na faixa [-15, -13],
  mas mais perto da borda.
- Legendas: a caixa passou a ocupar até 84% da largura (728 px no frame de 13 s, antes 540 px), centralizada, com
  fonte de 70 px (largura × 0,065) em vez de 59 px. Ainda quebram em 2 a 4 linhas e a de 4,76 a 8,34 s cobre o bloco
  de crédito, que fica abaixo dela na pilha.
- Uma primeira tentativa de exportação desta rodada falhou com `E_BROWSER_TIMEOUT` (seek do frame 41 sem resposta em
  60 s) com a máquina sob carga; as mesmas legendas renderizam sozinhas (900 frames) e a repetição da exportação
  passou sem mudar nada. Não reproduzido; fica registrado.
