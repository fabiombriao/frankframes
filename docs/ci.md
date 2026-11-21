# CI

O gate roda **na máquina de desenvolvimento**. Sem GitHub Actions, sem serviço externo, sem container.

> **Proibição registrada.** GitHub Actions é vedado neste repositório (`.omp/RULES.md`). A regra não é
> só texto: `scripts/check-policy.ts` reprova o gate se `.github/workflows/` existir. Verificado com um
> workflow de teste — o gate saiu com 1 violação e código 1.

## Por quê

| Opção | Custo real | Veredito |
|---|---|---|
| Local (`node scripts/ci.ts`) | ~3 min 24 s, zero download | **escolhido** |
| Docker | build inicial de 8–12 min + ~600 MB de imagem; WSL2 encarece I/O de `node_modules`; assets são win64, então exigiria embarcar FFmpeg Linux e as libs do Chrome | só quando existir artefato de release para reproduzir |
| Nuvem (Actions/Cirrus/AppVeyor) | exige provedor e, no nosso caso, build Linux do FFmpeg + dependências do shell; Actions está proibido | quando houver servidor próprio |

O motivo decisivo: o produto depende de assets **pinados e já presentes** (shell 158, FFmpeg LGPL, 25 famílias). Um runner remoto teria que baixar 470 MB por execução ou manter cache; a máquina local já tem, com hash conferido.

## Etapas

| Etapa | Tempo medido | O que reprova |
|---|---:|---|
| política | 0,2 s | workflow de Actions, dependência GPL/GSAP, CDN no render, `.env` versionado, licença/spec ausente |
| typecheck | 3,8 s | erro de tipo |
| testes rápidos | 4,2 s | contrato, encode, transcrição, catálogo, compilador |
| suíte completa | 183,5 s | qualquer teste, incluindo determinismo, goldens e render ponta a ponta |
| doctor | 1,1 s | browser/FFmpeg/fontes ausentes ou impossíveis de verificar |
| render de fumaça | 9,9 s | pipeline quebrado |
| verificar MP4 | 0,8 s | codec/frames diferente de `av1`/90 |

Soma das etapas: ~3 min 24 s. Os quatro primeiros tempos vêm da última execução registrada em
`out/ci-report.json`; doctor, render e verificação foram medidos com os comandos do gate. Nessa
execução a suíte completa falhou e o gate parou ali — o log completo fica em `out/ci-suite.log`.

## Comandos

```bash
node scripts/ci.ts            # gate completo (7 etapas, ~3 min 24 s)
node scripts/ci.ts --fast     # política + typecheck + testes rápidos (8 s)
node scripts/ci.ts --release  # inclui npm pack --dry-run dos 7 pacotes
node scripts/install-hooks.ts # hook de pré-push rodando --fast
```

O hook fica em `.git/hooks/pre-push` e não é versionado — cada clone instala o seu.

## Regras

- O gate começa pela política: ela é a primeira etapa e para a fila em caso de violação.
- O gate **não** usa `.env` nem chama a rede: Jira, upload e IA ficam fora.
- Toda etapa falha alto e para a sequência.
- Teste que depende de Chrome ou FFmpeg faz `skip` explícito quando o binário não existe — nunca passa em silêncio.
- A promessa de pixel só é verificada no modo `software` (SwiftShader); em `hardware` a garantia é por máquina.
- Goldens comparam hash e, quando diverge, PSNR contra `catalog/goldens/<bloco>/<frame>.png`
  (≥50 dB aceito como jitter de rasterização). A verificação usa `captureShots: 3`, independente do
  modo rápido do render.

## Quando migrar para servidor

Existe uma pendência real para CI remoto: publicar e cachear um **FFmpeg Linux LGPL** e as bibliotecas do Chrome headless. Só vale quando o build precisar acontecer sem esta máquina — aí o caminho é um runner próprio (Woodpecker ou Drone em VPS), não um serviço de terceiro com o workflow no repositório.

Forja e CI são decisões separadas: manter o código no GitHub é aceitável; usar o Actions, não. Kamal
**não é CI** — é deploy de containers por SSH; ele entraria depois do build, nunca no lugar do gate.
