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
