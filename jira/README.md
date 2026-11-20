# Backlog FrankFrames no Jira

Projeto: **EDT — Editor IA** (`https://ia2bhub.atlassian.net/jira/software/projects/EDT`).
Backlog sincronizado: **8 épicos + 25 tarefas** (`EDT-1` … `EDT-33`). `jira/backlog.json` é a fonte de
verdade e carrega o `jiraKey` de cada item.

## Tooling: REST via `.env` (preferido)

A CLI do Orca só cria e comenta — não edita, não apaga e o `search` dela devolve vazio. Para manter o
backlog, use o cliente REST do repo:

```bash
cp .env.example .env          # preencha JIRA_EMAIL e JIRA_API_TOKEN
node scripts/jira.ts whoami   # confere autenticação
node scripts/jira.ts list     # lista o projeto com o épico de cada item
node scripts/jira.ts show EDT-7
node scripts/jira.ts comment EDT-7 --body-file <arquivo>
node scripts/jira.ts transitions EDT-7
node scripts/jira.ts move EDT-7 Feito
node scripts/jira.ts seed --dry-run   # plano sem tocar no Jira
node scripts/jira.ts seed             # cria o que falta (idempotente)
node scripts/jira.ts sync             # reescreve descrição/rótulos a partir do backlog.json
node scripts/jira.ts fields           # procura campo de estimativa
node scripts/jira.ts self-test        # valida o planejamento offline
```

Regras do cliente:

- credenciais só de `.env` (ignorado pelo git) ou do ambiente — nunca em arquivo versionado;
- `seed` e `sync` são idempotentes: casam por `jiraKey` e, na falta, por `summary`;
- `sync` grava de volta o `jiraKey` em `jira/backlog.json`.

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

## Limitações do projeto EDT

- **Não existe campo de Story Points** (verificado em `/rest/api/3/field`). A estimativa fica no corpo
  da tarefa como `Estimativa: N pontos.` — total atual: 96 pontos.
- Tipos: `10261` Subtask, `10262` Epic, `10263` Bug, `10264` Tarefa.
- Criação de projeto não é exposta por nenhuma das duas vias (Orca nem REST sem permissão global de
  administrador); o EDT foi criado na interface.

## Orca

O conector do Orca perdeu a seleção de site ("No matching connected Jira site") e não é mais necessário:
comentário e transição agora existem no cliente REST. Use o Orca só se quiser leitura rápida.

## Orca, quando conveniente

Leitura rápida e comentário continuam funcionando pelo conector (`orca jira issue`, `orca jira comment
add <chave> --body-file <arquivo>`). Para qualquer escrita em lote, use `scripts/jira.ts`.
