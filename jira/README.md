# Backlog FrankFrames

Fonte de verdade do backlog no formato que a CLI do Orca consome.

## Semear no Jira

Projeto: **FrankFrames** (`FF`), template Scrum, company-managed — a CLI do Orca não cria projeto
(`project list|types|fields`), então a criação é no Jira uma vez.

Depois de criado, o seed é mecânico:

```bash
orca jira project types --project FF          # ids de Epic e Story (variam por projeto)
orca jira create --project FF --type <epic>   --title "<épico>" --body "<summary>"
orca jira create --project FF --type <story>  --title "<história>" --body "<critério de aceite>" \
  --fields-json '{"parent":{"key":"FF-1"},"customfield_10016":5}'
```

`customfield_10016` é Story Points e `parent` liga a história ao épico em projeto company-managed;
`project fields --project FF --type <story>` mostra os ids reais do site.

## Concluído (não entra no backlog)

Contrato, engine determinístico (relógio virtual, seek, captura atômica, vídeo fora de banda,
paralelismo, shell pinado, fontes, taxonomia de falha), producer com áudio, compilador de
sub-composições, transcrição por API, FFmpeg LGPL embarcado, 8 blocos, skill e onboarding
(`init`, `doctor`, `skill install`).
