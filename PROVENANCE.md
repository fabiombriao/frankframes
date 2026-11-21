# Proveniência

Este repositório contém código **independente**. Não é fork, tradução, porte nem obra derivada de
nenhum framework de vídeo em HTML.

## Licença

Proprietária, todos os direitos reservados. Ver `LICENSE`. O acesso ao código não concede direito de
uso, cópia ou redistribuição. Componentes de terceiros mantêm suas licenças e estão listados em
`THIRD-PARTY-NOTICES.md`.

## Método

1. O comportamento observável foi documentado antes de qualquer linha de código, em `docs/contract.md`
   e `docs/encode.md`.
2. A implementação foi escrita a partir dessa especificação. O código-fonte de terceiros não é
   consultado durante o desenvolvimento e não existe neste repositório.
3. O vocabulário é próprio: `data-clip-id`, `data-track`, `data-offset` único, erro alto por padrão.
4. Nenhum identificador interno, comentário, string de erro, nome de arquivo ou estrutura de diretório
   de terceiros foi reaproveitado.

## Proibido neste repositório

- Código, comentários ou strings copiados de outro framework.
- GSAP em qualquer forma (licença GreenSock não é OSI). Runtime primário: WAAPI/CSS.
- Catálogo, templates, presets, assets, textos de skill ou documentação de terceiros.
- Binário de FFmpeg com `--enable-gpl`, `libx264` ou `libx265`.
- Logos e marcas de terceiros, inclusive em texto comparativo.

## Dependências e licenças

| Dependência | Licença | Uso |
|---|---|---|
| `parse5` | MIT | parser HTML do contrato |
| `typescript` | Apache-2.0 | apenas build/checagem |
| `@types/node` | MIT | tipos |
| `libsvtav1` | BSD-3-Clause (encoder) | AV1 |
| `libvpx` | BSD-3-Clause | VP9 |
| `libopenh264` | BSD-2-Clause | H.264 opt-in, binário pré-compilado da Cisco |

Bibliotecas de terceiros não tornam este código derivado. Uso de biblioteca exige atribuição, não
abertura do nosso código.

## Registro

| Data | Evento |
|---|---|
| 2026-11-20 | licença proprietária atribuída a Fábio Morales Brião (CNPJ 34.681.339/0001-12) |
| 2026-11-20 | contrato próprio implementado (`packages/contract`), política de encode com guarda GPL (`packages/encode`), CLI `lint` |
| 2026-11-21 | contrato de motion (`data-enter/exit/emphasis/camera/transition`, §7b): gramática, curvas e presets em português escritos do zero a partir de CSS/WAAPI; sem nomes, sintaxe ou texto de outro framework |
| 2026-11-21 | 26 presets de motion e miniaturas geradas pelo próprio engine (EDT-51) |
