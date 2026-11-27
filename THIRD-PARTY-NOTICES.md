# Componentes de terceiros

O FrankFrames é proprietário (ver `LICENSE`). As dependências abaixo mantêm suas próprias licenças,
que exigem a reprodução dos avisos em distribuições do produto.

## Embutidas no código

### parse5 — MIT

Copyright (c) 2013-2019 Ivan Nikulin (ifaaan@gmail.com, https://github.com/inikulin)

Permissão concedida, gratuitamente, a qualquer pessoa que obtenha uma cópia deste software e dos
arquivos de documentação associados (o "Software"), para lidar com o Software sem restrição, incluindo,
sem limitação, os direitos de usar, copiar, modificar, mesclar, publicar, distribuir, sublicenciar e/ou
vender cópias do Software, e de permitir que as pessoas a quem o Software é fornecido o façam, sujeitas
às seguintes condições:

O aviso de copyright acima e este aviso de permissão devem ser incluídos em todas as cópias ou partes
substanciais do Software.

O SOFTWARE É FORNECIDO "NO ESTADO EM QUE SE ENCONTRA", SEM GARANTIA DE QUALQUER ESPÉCIE, EXPRESSA OU
IMPLÍCITA, INCLUINDO, MAS NÃO SE LIMITANDO A, GARANTIAS DE COMERCIALIZAÇÃO, ADEQUAÇÃO A UM FIM
ESPECÍFICO E NÃO VIOLAÇÃO. EM NENHUM CASO OS AUTORES OU DETENTORES DE DIREITOS AUTORAIS SERÃO
RESPONSÁVEIS POR QUALQUER RECLAMAÇÃO, DANO OU OUTRA RESPONSABILIDADE, SEJA EM AÇÃO CONTRATUAL,
ILÍCITO OU DE OUTRA FORMA, DECORRENTE DE, OU EM CONEXÃO COM O SOFTWARE OU O USO OU OUTRAS OPERAÇÕES
NO SOFTWARE.

### entities — BSD-2-Clause

Copyright (c) Felix Böhm. Todos os direitos reservados.

A redistribuição e o uso em código-fonte e binário, com ou sem modificação, são permitidos desde que:
(1) redistribuições de código-fonte mantenham o aviso de copyright, esta lista de condições e a
isenção de responsabilidade; (2) redistribuições em binário reproduzam o aviso de copyright, esta
lista de condições e a isenção de responsabilidade na documentação e/ou em outros materiais.

ESTE SOFTWARE É FORNECIDO PELOS DETENTORES DE DIREITOS AUTORAIS E CONTRIBUIDORES "NO ESTADO EM QUE SE
ENCONTRA", COM ISENÇÃO DE GARANTIAS EXPRESSAS OU IMPLÍCITAS, INCLUINDO GARANTIAS DE COMERCIALIZAÇÃO E
ADEQUAÇÃO A UM FIM ESPECÍFICO. EM NENHUM CASO O DETENTOR DE DIREITOS AUTORAIS OU CONTRIBUIDORES SERÁ
RESPONSÁVEL POR DANOS DIRETOS, INDIRETOS, INCIDENTAIS, ESPECIAIS, EXEMPLARES OU CONSEQUENCIAIS
DECORRENTES DO USO DESTE SOFTWARE.

## Dependências de produção instaladas pelo npm

O tarball `@frankframes/cli` não embute estes pacotes: o `npm install` os baixa do registro, cada um com
o próprio `LICENSE`. A lista é a árvore de `npm ls --omit=dev --all`, e `node scripts/third-party.ts --check`
reprova o gate se aparecer dependência sem aviso aqui ou com licença fora de MIT, ISC, Apache-2.0,
BSD-2-Clause, BSD-3-Clause, 0BSD e BlueOak-1.0.0.

### puppeteer-core — Apache-2.0

Copyright The Chromium Authors. Controla o Chrome headless shell pinado (`packages/engine`). Licenciado
sob a Apache License 2.0 (https://www.apache.org/licenses/LICENSE-2.0): uso, reprodução e distribuição
permitidos, desde que se mantenha o aviso de copyright e o texto da licença, que acompanham o pacote
instalado em `node_modules/puppeteer-core`. O FrankFrames não o modificou.

### @mediapipe/tasks-vision — Apache-2.0

Versão 1.2.3, Google. A tarefa de detecção facial roda localmente e usa o modelo
MediaPipe BlazeFace Full Range publicado com licença Apache-2.0. [Código e licença do MediaPipe](https://github.com/google-ai-edge/mediapipe).
[Ficha e licença do modelo](https://huggingface.co/litert-community/MediaPipe-FaceDetector-BlazeFace-Full-Range).

### Transitivas de puppeteer-core e de parse5

Mesmos termos de cada licença abaixo; o texto integral e o aviso de copyright de cada pacote ficam no
`LICENSE` dele, dentro do `node_modules` instalado.

| Pacote | Versões | Licença | Copyright |
|---|---|---|---|
| @puppeteer/browsers | 3.2.7 | Apache-2.0 | The Chromium Authors |
| chromium-bidi | 157.0.8090-0 | Apache-2.0 | The Chromium Authors |
| webdriver-bidi-protocol | 1.0.2 | Apache-2.0 | Google Inc. |
| devtools-protocol | 0.0.1717327 | BSD-3-Clause | The Chromium Authors |
| ansi-regex | 6.6.0 | MIT | Sindre Sorhus |
| ansi-styles | 6.2.3 | MIT | Sindre Sorhus |
| emoji-regex | 10.6.0 | MIT | Mathias Bynens |
| escalade | 3.2.0 | MIT | Luke Edwards |
| get-east-asian-width | 1.7.0 | MIT | Sindre Sorhus |
| mitt | 3.0.1 | MIT | Jason Miller |
| modern-tar | 0.8.6 | MIT | Ayuhito |
| string-width | 7.2.0, 8.3.0 | MIT | Sindre Sorhus |
| strip-ansi | 7.2.0 | MIT | Sindre Sorhus |
| typed-query-selector | 2.12.4 | MIT | Pig Fang |
| wrap-ansi | 9.0.2 | MIT | Sindre Sorhus |
| ws | 8.23.0 | MIT | Einar Otto Stangvik, Arnout Kazemier e colaboradores |
| yargs | 18.2.0 | MIT | James Halliday e colaboradores |
| zod | 4.6.7 | MIT | Colin McDonnell |
| cliui | 9.0.1 | ISC | colaboradores |
| get-caller-file | 2.0.5 | ISC | Stefan Penner |
| y18n | 5.0.8 | ISC | colaboradores |
| yargs-parser | 22.0.0 | ISC | colaboradores |

## FFmpeg embarcado (build LGPL)

O produto distribui o build **LGPL** descrito em `vendor/ffmpeg/SOURCE.txt`, um por plataforma, os dois da mesma
versão e da mesma release datada e imutável do `BtbN/FFmpeg-Builds` (tag `autobuild-2026-11-26-12-56`; a tag
`latest` é móvel e não é usada):

| Campo | win64 | linux64 |
|---|---|---|
| versão | `N-129308-g17de9f8597` | `N-129308-g17de9f8597` |
| arquivo | `ffmpeg-N-129308-g17de9f8597-win64-lgpl.zip` | `ffmpeg-N-129308-g17de9f8597-linux64-lgpl.tar.xz` |
| SHA-256 do arquivo | `a5d0ac2c93907d281063a4c39fd2f14e2fd1189575b699216cff5f008f25540c` | `671e661c5b0a9efd08e7dcb1922c1cc62c373adda4db4256b8fb7e5a87b39bac` |
| licença | LGPL-2.1-or-later (`vendor/ffmpeg/LICENSE.txt`) | LGPL-2.1-or-later (`vendor/ffmpeg/LICENSE.txt`) |

URL: `https://github.com/BtbN/FFmpeg-Builds/releases/download/<tag>/<arquivo>`. O BtbN poda releases diárias
antigas: se a tag sair do ar, o `setup` falha alto no download (HTTP 404) e o pin precisa ser trocado por outro
build datado com os dois arquivos, com os SHA-256 novos.

Obligações cumpridas: texto da licença ao lado do binário, origem e receita de reconstrução em
`vendor/ffmpeg/SOURCE.txt`, e SHA-256 dos binários em `vendor/ffmpeg/manifest.json`. O FrankFrames
executa o FFmpeg como processo separado; nenhuma biblioteca é linkada ao nosso código.

## Executadas como processos externos (não embutidas)

| Componente | Licença | Papel |
|---|---|---|
| FFmpeg (build LGPL, sem `--enable-gpl`) | LGPL-2.1-or-later | encode, probe, extração de mídia |
| libsvtav1 | BSD-3-Clause | encoder AV1 |
| libvpx | BSD-3-Clause | encoder VP9 |
| libopenh264 | BSD-2-Clause | H.264 opcional (binário Cisco, patentes cobertas pelo distribuidor) |
| Chrome headless shell | binário do Chromium, licenças próprias | rasterização |

O produto recusa em código qualquer binário FFmpeg com `--enable-gpl`, `libx264` ou `libx265`
(`packages/encode/src/policy.ts`). Ver `docs/encode.md`.

## Ferramentas de desenvolvimento (não distribuídas)

`typescript` (Apache-2.0), `@types/node` (MIT), `undici-types` (MIT).

O helper CEF instalado localmente para a sonda e para o render `--vram` no Windows usa os SDKs
externos abaixo, que acompanham as próprias licenças.
Versões e SHA-256 estão em [scripts/cef-probe/README.md](scripts/cef-probe/README.md).

| Componente | Licença | Papel |
|---|---|---|
| Chromium Embedded Framework e seu wrapper C++ | BSD-3-Clause, `LICENSE.txt` no SDK. Copyright 2008–2020 Marshall A. Greenblatt. Partes copyright 2006–2009 Google Inc. | Captura acelerada fora da tela |
| Vulkan-Headers | Apache-2.0 ou MIT, `LICENSE.md` no SDK. Copyright 2015–2023 The Khronos Group Inc. | Cabeçalhos das APIs Vulkan usadas pelo helper |
| FFmpeg BtbN compartilhado | LGPL-2.1-or-later, avisos e licenças no SDK | Decoder, compositor libplacebo, encoder e mux de vídeo do helper |
