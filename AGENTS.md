# FrankFrames — instruções para agentes

Antes de trabalhar no FrankFrames, leia também os documentos de contexto do projeto:

1. `.omp/RULES.md` — regras duras;
2. `.omp/AGENTS.md` — contexto, comandos, invariantes e decisões;
3. `docs/handoff-codex.md` — estado do projeto e fila de trabalho a partir de 2026-11-26.

## Instalar em outro computador pelo GitHub

Siga o [passo a passo pelo `main` do GitHub](docs/getting-started.md#pelo-github-código-mais-recente).
O guia cobre download, `setup`, `doctor`, abertura do Studio e instalação do helper CEF no Windows.
Confira o `main` remoto antes de informar se o repositório está atualizado. O pacote da aba Releases
corresponde à versão da tag publicada.

Quando a pessoa pedir para instalar ou deixar o FrankFrames funcionando, esse pedido já autoriza os
passos da instalação local descritos no guia: obter o código, rodar `npm ci`, baixar as dependências
do `setup` e verificar o funcionamento. Execute nessa ordem e confirme a entrega com o `doctor` e
um render de teste ou a abertura do Studio, conforme o pedido. Prossiga sem exigir inventário ou
um segundo "autorizado". Se houver uma exigência de permissão do ambiente, identifique a etapa
afetada e siga a solicitação de permissão correspondente.

## Publicar cada atualização concluída no GitHub

1. Revise `git status` e o diff. Inclua no commit apenas os arquivos da tarefa.
2. Rode o gate local completo com `node scripts/ci.ts`. Corrija falhas recuperáveis e repita a validação.
3. Com o gate aprovado, faça o commit, integre a alteração ao `main` e execute `git push origin main`.
4. Confira com `git ls-remote origin refs/heads/main` que o commit chegou ao `main` do GitHub.

Quando houver delegação, a sessão responsável por fechar a tarefa integra, valida e publica o trabalho
dos subagentes. Se o gate ou o push continuar bloqueado, informe a etapa e o motivo. Tags e pacotes seguem
o [processo de publicação de versões](docs/release.md).
