# Aceite de ponta a ponta com vídeo real (EDT-64)

Roteiro fixo e verificação automática para o último item antes do release. O vídeo do titular nunca entra
no repositório: o projeto de aceite fica em `out/aceite-a001/` (ignorado) e o Studio copia a fonte para
`out/aceite-a001/assets/`. O script `scripts/accept-video.ts` fica fora do gate (`scripts/ci.ts`) porque
precisa do vídeo.

- Fonte: `C:\Users\rober\Downloads\A001_11181126_H685.MOV` (H.264 1920x1080 24 fps, 68,164583 s, AAC estéreo 48 kHz).
- Resultado esperado: MP4 de 30,000 s (corte de 8 s a 38 s), loudness de entrega, lower-third, legendas.

## Roteiro (tudo pelo Studio, nada editado à mão no HTML)

1. `node packages/cli/src/cli.ts init out/aceite-a001` e abrir
   `node packages/cli/src/cli.ts studio out/aceite-a001/index.html`.
2. Importar o `.MOV` no playhead 0: clip de 68,164583 s (conferir no ffprobe).
3. Dividir em 8 s e em 38 s; apagar o primeiro e o terceiro pedaço. Esperado: um clip de vídeo com
   `data-offset="8"` e `data-duration="30"` começando em 0. Se o pedaço não reancorar em 0, mover pela
   timeline e registrar o comportamento.
4. Remover os clips do `init` (kicker/título/régua) ou encurtá-los para 4 s; inserir o bloco `lower-third`
   em 5 s e aplicar um preset de entrada e de saída pelo inspetor no título.
5. Legendas (provedor Groq, `GROQ_API_KEY` no `.env`; só o trecho de 30 s sai da máquina):
   ```
   ffmpeg -ss 8 -t 30 -i A001_11181126_H685.MOV -vn -ac 1 -ar 16000 out/aceite-a001/trecho.wav
   node packages/cli/src/cli.ts captions out/aceite-a001/trecho.wav -o out/aceite-a001/legendas.html --size 1920x1080
   ```
   Inserir `legendas.html` como sub-composição em 0 com duração 30 s. Sem a chave, o `transcribe` falha
   alto; não trocar de provedor.
6. Exportar pelo Studio, preset `standard`, para `out/aceite-a001/final.mp4`.
7. Conferir `final.mp4` num player: sincronia de lábio nos 30 s (o script não mede sincronia fina).

## Comando de verificação

```
node scripts/accept-video.ts out/aceite-a001/final.mp4 \
  --entry out/aceite-a001/index.html \
  --source "C:\Users\rober\Downloads\A001_11181126_H685.MOV" \
  --spec scripts/accept/keyframes-a001.json \
  --captions out/aceite-a001/legendas.html
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

Pendente: preenchido no passo 4 do EDT-64, depois de rodar o roteiro com o titular (números do
`aceite.json`, data e versão).
