# FrankFrames — ponte para o Claude Code

O `AGENTS.md` contém as instruções compartilhadas de instalação e publicação. Os arquivos em `.omp/`
complementam essas instruções com as regras e o contexto do projeto.

@AGENTS.md
@.omp/RULES.md
@.omp/AGENTS.md

## Planejador e executor (decisão do titular)

Duas sessões ligadas no mesmo checkout, cada uma com um papel só:

- **Sessão de planejamento — Opus 5.5, esforço alto.** Lê o código, decide o desenho, mantém
  `docs/plano-1.0.md` (passos executáveis por item: arquivos, spec em `docs/contract.md`, testes que
  falhariam sem a mudança), manda um item por vez para a sessão de execução, revisa o diff, roda
  `node scripts/ci.ts` e só então faz commit, push e atualiza o Jira. Não escreve código de produto.
- **Sessão de execução — Sonnet 5.5, esforço alto.** Implementa o item recebido seguindo o plano,
  roda os testes e o `ci --fast`, e responde com o resumo do diff. Não faz commit, push nem mexe no
  Jira; se o plano estiver errado, para e devolve a pergunta ao planejamento em vez de redesenhar.
- Sem sessões separadas, `.claude/agents/planejador.md` (Opus) e `.claude/agents/executor.md` (Sonnet)
  atuam como subagentes. A sessão que os coordena roda o gate completo, faz commit, push e atualiza o Jira.
