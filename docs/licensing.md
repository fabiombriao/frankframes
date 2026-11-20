# Licenciamento

Este documento explica o que o produto distribui e o que o usuário pode fazer com o resultado. Não é
parecer jurídico.

## O produto

Proprietário, todos os direitos reservados (ver `LICENSE`). O código não é aberto, não é forkável e o
acesso ao repositório não concede licença de uso.

## O que o instalador leva

| Componente | Licença | Obrigação |
|---|---|---|
| Nosso código | proprietária | nenhuma além do contrato de licenciamento |
| FFmpeg (build LGPL, sem `--enable-gpl`) | LGPL-2.1-or-later | texto da licença + origem e receita de reconstrução (`vendor/ffmpeg/SOURCE.txt`) |
| libsvtav1, libvpx | BSD-3-Clause | aviso de copyright |
| libopenh264 (opcional, H.264) | BSD-2-Clause | aviso; patentes cobertas **apenas** pelo binário pré-compilado da Cisco |
| Fontes (25 famílias) | SIL OFL-1.1 | texto da licença ao lado de cada família em `vendor/fonts` |
| Chrome headless shell | binário do Chromium | licenças próprias do Chromium |

O FFmpeg é executado como **processo separado**. Nenhuma biblioteca é linkada ao nosso código, então a
LGPL não alcança o produto.

## Codec e patente

- **AV1** é o padrão. A AOMedia concede a patente sem royalties para implementações conformes.
- **VP9** é alternativa livre, em WebM.
- **H.264/AVC** tem pool de patentes que independe de quem escreveu o código. Por isso ele só existe via
  `libopenh264` com opt-in explícito (`--allow-h264-openh264`) e aviso. Escrever código próprio não
  elimina essa exposição — só a licença de patente elimina.

## O que o usuário pode fazer com o vídeo

O MP4 gerado é do usuário. Nós não reivindicamos direito sobre o conteúdo renderizado, nem sobre as
mídias que ele fornece. A licença do produto cobre o software, não a saída.

## Marcas

O nome FrankFrames e o logotipo pertencem ao titular. O produto não usa marca de terceiro, e não deve
ser apresentado como derivado de outro framework de vídeo — ver `PROVENANCE.md`.

## Verificação

`node scripts/check-policy.ts` reprova o gate se aparecer dependência GPL, GSAP ou fonte de CDN no
caminho de render. `assertDistributionSafe()` reprova em tempo de execução qualquer binário FFmpeg com
`--enable-gpl` ou encoder GPL exposto.
