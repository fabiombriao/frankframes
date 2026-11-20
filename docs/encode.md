# Política de encode

## Regra dura

O produto não distribui **nenhum** binário que imponha licença ao nosso código nem ao do cliente.

| Item | Decisão |
|---|---|
| FFmpeg | build **LGPL**, sem `--enable-gpl` |
| x264 / x265 | **bloqueados em código** (`E_GPL_ENCODER`) |
| H.264 | só via `libopenh264`, e só com opt-in explícito (`--allow-h264-openh264`) |
| AV1 | `libsvtav1` (BSD) — padrão |
| VP9 | `libvpx-vp9` (BSD) — alternativa web |
| GSAP | proibido no core; runtime primário é WAAPI/CSS |

`assertDistributionSafe()` roda antes do primeiro encode e recusa qualquer binário com `--enable-gpl` ou
com encoder GPL exposto. `assertCodecAllowed()` recusa codec sem o encoder permissivo correspondente.

Verificação real (2026-11-20):

```
OK          ffmpeg n8.1.3 (LGPL, 233 encoders) · av1 + vp9
BLOQUEADO   ffmpeg 9.0.2 gyan.dev · E_FFMPEG_GPL
```

## Presets

Números de partida; recalibrar com material real, não com cartão sintético.

| Preset | AV1 (`libsvtav1`) | VP9 (`libvpx-vp9`) | H.264 (`libopenh264`) |
|---|---|---|---|
| `draft` | crf 42, preset 10 | crf 48, cpu-used 5 | 3M |
| `standard` | crf 32, preset 8 | crf 34, cpu-used 4 | 8M |
| `high` | crf 26, preset 6 | crf 28, cpu-used 2 | 16M |

Medido nesta máquina, 60 frames 1080p30 de cartão sintético:

| Codec | Tempo de encode | Saída |
|---|---:|---:|
| AV1 MP4 | 896 ms | 154 KB |
| VP9 WebM | 1.261 ms | 110 KB |

## Container

| Codec | Container | Muxing |
|---|---|---|
| AV1 | `.mp4` | `-movflags +faststart` |
| VP9 | `.webm` | nenhum `movflags` |
| H.264 (openh264) | `.mp4` | `-movflags +faststart` |

`-video_track_timescale 90000` sempre. `-xerror` sempre: sem ele o FFmpeg termina o vídeo no primeiro
frame ilegível e ainda sai com código 0.

## Dívida declarada

- H.264 continua existindo por compatibilidade de player. Ele existe **por escolha do usuário**, com
  aviso de patente, nunca como caminho padrão.
- AV1 em MP4 não toca em players antigos. O caminho para web é WebM/VP9; o caminho para distribuição
  moderna é AV1.
