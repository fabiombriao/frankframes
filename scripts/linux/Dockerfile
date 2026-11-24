# FrankFrames — proprietário. Ver LICENSE na raiz.
# Imagem do gate Linux (EDT-13): só o que o chrome-headless-shell 158.0.8127.36 linux64 precisa para abrir.
# Sem COPY do repositório: o checkout entra por cópia em tempo de execução (scripts/linux/gate.ts).
# Lista medida com `ldd` no executável instalado por @puppeteer/browsers sobre node:24-bookworm.
# Já vêm na imagem base e não são reinstalados: xz-utils, unzip (extração do FFmpeg), tar, git, libx11-6,
# libxext6, libxcb1, libcairo2, libpango-1.0-0, libglib2.0-0, libexpat1 e as fontes DejaVu (o projeto usa vendor/fonts).
FROM node:24-bookworm

# Ordem alfabética. Cada pacote cobre a(s) biblioteca(s) que o ldd reportou como "not found":
#   libasound2          libasound.so.2 (áudio ALSA)
#   libatk-bridge2.0-0  libatk-bridge-2.0.so.0
#   libatk1.0-0         libatk-1.0.so.0
#   libatspi2.0-0       libatspi.so.0
#   libdbus-1-3         libdbus-1.so.3
#   libgbm1             libgbm.so.1 (puxa libdrm2)
#   libnss3             libnss3.so, libnssutil3.so e, por dependência, libnspr4.so
#   libxcomposite1      libXcomposite.so.1
#   libxdamage1         libXdamage.so.1
#   libxfixes3          libXfixes.so.3
#   libxkbcommon0       libxkbcommon.so.0
#   libxrandr2          libXrandr.so.2
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      libasound2 \
      libatk-bridge2.0-0 \
      libatk1.0-0 \
      libatspi2.0-0 \
      libdbus-1-3 \
      libgbm1 \
      libnss3 \
      libxcomposite1 \
      libxdamage1 \
      libxfixes3 \
      libxkbcommon0 \
      libxrandr2 \
 && rm -rf /var/lib/apt/lists/*

# /work é o destino da cópia do checkout; o usuário `node` (uid 1000) já existe na imagem.
RUN mkdir -p /work && chown node:node /work
USER node
WORKDIR /work
