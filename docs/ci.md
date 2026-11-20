# CI

O gate roda **na máquina de desenvolvimento**. Sem GitHub Actions, sem serviço externo, sem container.

## Por quê

| Opção | Custo real | Veredito |
|---|---|---|
| Local (`node scripts/ci.ts`) | 47 s, zero download | **escolhido** |
| Docker | build inicial de 8–12 min + ~600 MB de imagem; WSL2 encarece I/O de `node_modules`; assets são win64, então exigiria embarcar FFmpeg Linux e as libs do Chrome | só quando existir artefato de release para reproduzir |
| Nuvem (Actions/Cirrus/AppVeyor) | exige provedor e, no nosso caso, build Linux do FFmpeg + dependências do shell; Actions está proibido | quando houver servidor próprio |

O motivo decisivo: o produto depende de assets **pinados e já presentes** (shell 158, FFmpeg LGPL, 25 famílias). Um runner remoto teria que baixar 470 MB por execução ou manter cache; a máquina local já tem, com hash conferido.

## Etapas

| Etapa | Tempo medido | O que reprova |
|---|---:|---|
| typecheck | 3,0 s | erro de tipo |
| testes rápidos | 1,0 s | contrato, encode, transcrição, catálogo, compilador |
| suíte completa | 36,0 s | qualquer teste, incluindo determinismo e render ponta a ponta |
| doctor | 1,4 s | browser/FFmpeg/fontes ausentes ou impossíveis de verificar |
| render de fumaça | 5,5 s | pipeline quebrado |
| verificar MP4 | 0,7 s | codec/frames diferente de `av1`/90 |

Relatório em `out/ci-report.json`.

## Comandos

```bash
node scripts/ci.ts            # gate completo (47 s)
node scripts/ci.ts --fast     # typecheck + testes rápidos (5 s)
node scripts/ci.ts --release  # inclui npm pack --dry-run dos 7 pacotes
node scripts/install-hooks.ts # hook de pré-push rodando --fast
```

O hook fica em `.git/hooks/pre-push` e não é versionado — cada clone instala o seu.

## Regras

- O gate **não** usa `.env` nem chama a rede: Jira, upload e IA ficam fora.
- Toda etapa falha alto e para a sequência.
- Teste que depende de Chrome ou FFmpeg faz `skip` explícito quando o binário não existe — nunca passa em silêncio.
- A promessa de pixel só é verificada no modo `software` (SwiftShader); em `hardware` a garantia é por máquina.

## Quando migrar para servidor

Existe uma pendência real para CI remoto: publicar e cachear um **FFmpeg Linux LGPL** e as bibliotecas do Chrome headless. Só vale quando o build precisar acontecer sem esta máquina — aí o caminho é um runner próprio (Woodpecker ou Drone em VPS), não um serviço de terceiro com o workflow no repositório.
