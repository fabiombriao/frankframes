# Captura em VRAM com CEF (EDT-103)

A sonda usa CEF fora da tela com BeginFrame externo e a página compilada pelo produtor.
No Windows, copia a textura BGRA compartilhada do CEF enquanto o callback está ativo.
Importa a cópia D3D11 em um dispositivo Vulkan criado pelo FFmpeg e sincroniza os dois
com um keyed mutex. Uma cópia Vulkan alimenta o `buffer` do libavfilter, que passa pelo
libplacebo e devolve `AVFrame` em Vulkan com o PTS da composição.

A sonda mantém o viewport da composição dentro de um iframe e desenha dois marcadores na faixa
de quatro pixels abaixo do quadro. Lê oito bytes dos marcadores por callback candidato, descarta
pinturas atrasadas, confere o alfa pré-multiplicado e passa só o retângulo da composição ao filtro.
Reutiliza a última textura quando o inspetor do render por camadas encontra a mesma assinatura visual.
Use o executável com HTML local confiável, pois o SDK minimal pinado usa CEF sem sandbox.

## Compilar no Windows x64

Use Visual Studio 2022 Build Tools com C++ para Desktop, CMake e o loader Vulkan do driver.
Descompacte os três SDKs sob `out/cef-probe` após conferir o SHA-256 de cada arquivo.

| SDK | Arquivo | SHA-256 |
| --- | --- | --- |
| CEF (BSD-3-Clause) | [158.0.6+g23f1736, win64 minimal](https://cef-builds.spotifycdn.com/cef_binary_158.0.6%2Bg23f1736%2Bchromium-158.0.8127.89_windows64_minimal.tar.bz2) | `1da0b9fe0e915bd41448939f944003d848f8d9e4d15c7d85d7a17cce656b1a9a` |
| Vulkan-Headers (Apache-2.0 ou MIT) | [v1.3.296](https://codeload.github.com/KhronosGroup/Vulkan-Headers/tar.gz/refs/tags/v1.3.296) | `e204e0b3c19f622d197df945737f5db913d6621830999b8578d34e80a7c90585` |
| FFmpeg compartilhado (LGPL) | [N-129308-g17de9f8597, win64 LGPL shared](https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-11-26-12-56/ffmpeg-N-129308-g17de9f8597-win64-lgpl-shared.zip) | `7c7627690848a4de59f342012d973f00107df6595a7ae2bfc559a764a4a1ed8c` |

```powershell
$cefRoot = (Resolve-Path 'out/cef-probe/cef_binary_158.0.6+g23f1736+chromium-158.0.8127.89_windows64_minimal').Path.Replace('\','/')
$vkRoot = (Resolve-Path 'out/cef-probe/Vulkan-Headers-1.3.296').Path.Replace('\','/')
$ffRoot = (Resolve-Path 'out/cef-probe/ffmpeg-N-129308-g17de9f8597-win64-lgpl-shared').Path.Replace('\','/')
cmake -S scripts/cef-probe -B out/cef-probe/repro -A x64 "-DCEF_ROOT=$cefRoot" "-DVULKAN_HEADERS=$vkRoot" "-DFFMPEG_SDK=$ffRoot"
cmake --build out/cef-probe/repro --config Release
node scripts/cef-probe/run.mjs out/cef-probe/repro/Release/ff-cef-probe.exe out/a001/index.html 12
```

Omita o limite `12` para testar toda a composição. A aprovação exige o mesmo número de
frames capturados e filtrados em Vulkan, PTS sequencial e zero callbacks em software.

## Render completo

```powershell
$env:FRANKFRAMES_CEF_EXE = (Resolve-Path out/cef-probe/repro/Release/ff-cef-probe.exe).Path
node packages/cli/src/cli.ts render out/a001/index.html --vram --gpu hardware --workers 1 -o out/a001/a001-cef-vram.mp4
```

O `--vram` também encontra o executável em `cef/win64/ff-cef-probe.exe` abaixo de `FRANKFRAMES_HOME`
(ou do diretório de assets padrão). No monorepo, instale o binário e os recursos com
`cmake --install out/cef-probe/repro --config Release --prefix vendor/cef`.
Uma execução CEF iniciada falha se não puder usar GPU.

O primeiro passe em CEF transmite só os metadados de vídeo e layout. O segundo entrega texturas
para o grafo libavfilter nativo, que decodifica, compõe vídeo, vidro, gradiente e HTML e codifica AV1
na mesma GPU. A barra usa um shader alimentado por valores numéricos. O processo principal monta o
áudio e o MP4. Use `--keep` para guardar o plano e os shaders. Com `FRANKFRAMES_CEF_TRACE=1` essa
pasta também contém os logs nativos. Composições com até 16.384 frames usam o marcador atual.
A integração Linux depende da importação e sincronização de superfícies DMA-BUF.
