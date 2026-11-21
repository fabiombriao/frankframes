# FrankFrames — ponte para o Claude Code

A fonte de verdade das instruções de agente está em `.omp/` (lida pelo omp/Orca).
Este arquivo só importa os dois para o Claude Code, sem duplicar conteúdo.

@.omp/RULES.md
@.omp/AGENTS.md

## Planejador e executor (decisão do titular)

- **Opus 5.5, esforço alto, planeja.** A sessão principal (ou o agente `planejador`) lê o código,
  decide o desenho, escreve o plano em `docs/plano-1.0.md` e quebra cada item do Jira em passos
  executáveis: arquivos, spec a mudar em `docs/contract.md`, testes que falhariam sem a mudança.
- **Sonnet 5.5, esforço alto, executa.** Todo trabalho de código vai para o agente `executor`
  (`Agent` com `model: "sonnet"`, `effort: "high"`), um item do plano por vez, ou em paralelo só
  quando os itens não tocam os mesmos arquivos.
- O planejador revisa o diff do executor, roda `node scripts/ci.ts` e só então faz commit, push e
  atualiza o Jira. O executor não faz commit, push nem mexe no Jira.
- Definições em `.claude/agents/planejador.md` e `.claude/agents/executor.md`.
