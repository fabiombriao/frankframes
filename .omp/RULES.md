# Regras duras

Estas linhas viajam em toda requisição, inclusive para subagentes. Não são sugestão.

- **PROIBIDO GitHub Actions.** Não criar, restaurar, habilitar nem propor workflow de Actions neste repositório. O `scripts/check-policy.ts` reprova o gate se `.github/workflows/` existir. CI é `node scripts/ci.ts`, rodando local.
- **Nenhum serviço de CI externo sem pedido explícito.** Se um dia for necessário build remoto, a decisão é do titular, registrada no Jira (EDT-34) e executada em runner próprio.
- **Nenhum encoder GPL.** Proibido `libx264`, `libx265`, `ffmpeg-static`, `@ffmpeg-installer`. O FFmpeg é o build LGPL de `vendor/ffmpeg`, conferido por hash.
- **Nenhum GSAP.** Runtime primário é WAAPI/CSS.
- **Nenhuma fonte de CDN em render.** Fontes vêm de `vendor/fonts`; `setup` pode baixar, o render não.
- **Segredo só em `.env`**, nunca versionado, nunca impresso em log ou resposta.
- **Falhar alto.** Proibido catch vazio, fallback silencioso e retry cego. Contrato inválido bloqueia o render.
- **Nada de fork, código ou texto de framework alheio.** Ver `PROVENANCE.md`.
- **Antes de dizer que está pronto:** `node scripts/ci.ts` verde.
- **Publique cada atualização concluída no GitHub.** Siga as instruções de instalação e publicação no
  [`AGENTS.md` da raiz](../AGENTS.md).
- **Não pare para reportar progresso.** Só encerre a resposta quando precisar de uma decisão do titular,
  estiver bloqueado por algo fora do alcance das ferramentas, ou a fila estiver concluída. Relatório é
  parte da resposta, não motivo para interromper o trabalho.
