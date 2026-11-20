# Backlog FrankFrames no Jira

Projeto: **EDT — Editor IA** (`https://ia2bhub.atlassian.net/jira/software/projects/EDT`).
Backlog importado: **8 épicos + 25 tarefas** (`EDT-1` … `EDT-33`). `jira/backlog.json` é a fonte de
verdade e carrega o `jiraKey` de cada item.

## Mapa

| Épico | Chave | Tarefas |
|---|---|---|
| Empacotamento e distribuição | EDT-1 | EDT-2 … EDT-5 |
| Preview e iteração | EDT-6 | EDT-7 … EDT-9 |
| Regressão visual | EDT-10 | EDT-11 … EDT-13 |
| Catálogo de blocos | EDT-14 | EDT-15 … EDT-17 |
| Transcrição local | EDT-18 | EDT-19 … EDT-21 |
| Áudio de entrega | EDT-22 | EDT-23 … EDT-25 |
| Robustez | EDT-26 | EDT-27 … EDT-29 |
| Documentação | EDT-30 | EDT-31 … EDT-33 |

## Criar item novo pela CLI do Orca

```bash
orca jira project fields --project EDT --type 10264      # campos do create
orca jira create --project EDT --type 10264 \
  --title "<título>" --body-file <arquivo> \
  --fields-json '{"parent":{"key":"EDT-26"},"labels":["engine"]}' --json
```

Tipos no projeto: `10261` Subtask, `10262` Epic, `10263` Bug, `10264` Tarefa.

Limitações observadas nesta CLI (20/11/2026):

- não existe criação de projeto (`project list|types|fields` apenas);
- não existe update nem delete de issue — descrição errada só se corrige recriando ou por comentário;
- o projeto **não tem campo de Story Points** no create: a estimativa vai no corpo (`Estimativa: N pontos.`);
- `orca jira search` devolve vazio mesmo com JQL válida; consulte por chave (`orca jira issue EDT-7`).

## Concluído (fora do backlog)

Contrato, engine determinístico (relógio virtual, seek, captura atômica, vídeo fora de banda,
paralelismo, shell pinado, fontes embarcadas, taxonomia de falha), producer com áudio e compilador de
sub-composições, transcrição por API, FFmpeg LGPL embarcado, 8 blocos de catálogo, skill e onboarding
(`init`, `doctor`, `skill install`).
