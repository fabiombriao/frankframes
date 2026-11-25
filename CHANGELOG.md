# Changelog

FrankFrames — proprietário (ver `LICENSE`). Versões seguem `MAJOR.MINOR.PATCH`.

## Próxima versão

### Legendas

- Legenda por Groq ou OpenAI-compatível sai em karaokê: o pedido agora solicita tempo por palavra, que antes nunca
  vinha, e `captions` diz se a legenda saiu em karaokê (com quantas palavras) ou por frase.

### Sub-composições

- Sub-composição embutida sai como entrou: `<br>` não dobra mais (o espaço entre linhas da legenda por frase saía
  em dobro), `<img>` não ganha tag de fechamento, comentários mantêm o texto, SVG fica no namespace SVG e o CSS e o
  JavaScript de `<style>`/`<script>` não são escapados.

## 1.0.0 — 2026-11-24

Primeira versão de produção: HTML vira MP4 de forma determinística, com editor, catálogo, legendas, mix de
áudio e geração por agente.

**Plataformas e determinismo.** `win64` e `linux64`, cada uma com browser e FFmpeg LGPL pinados por SHA-256;
outra plataforma falha alto. O gate Linux roda em Docker (`scripts/linux/gate.ts`). A promessa de determinismo é
estreita de propósito: hash de frame igual só em `software`, no mesmo SO e na mesma arquitetura, com o browser
pinado; no modo padrão (`auto`, GPU quando existe) o resultado é visualmente equivalente, não idêntico bit a bit.

### Empacotamento

- Um tarball só, `@frankframes/cli`, compilado e instalável com `npm i -g`, em vez de sete pacotes que o Node não
  executaria de dentro de `node_modules`; `frankframes --version` informa a versão.
- Browser, FFmpeg e fontes ficam fora do pacote e vêm por `setup`, conferidos por SHA-256 e guardados em
  `FRANKFRAMES_HOME`; rodar `setup` de novo não baixa nada que já está lá.
- Avisos de terceiros gerados da árvore de produção, com o gate reprovando licença fora da lista permitida.

### Preview

- Preview em tempo real com live reload, barra de controle e áudio fiel ao que o render entrega.
- O relógio para no último frame, com loop opcional, e recarregar a página mantém o instante e o estado de play.
- Vídeo no preview com cache de frames extraídos e retomada exata.

### Determinismo

- Captura com três frames estáveis, uma leitura por frame e relógio virtual; seek independente da ordem.
- GPU `auto` (hardware quando existe, SwiftShader quando não) e `--gpu software` para hash reproduzível.
- Goldens por plataforma e comparação por PSNR no gate; vídeo é sempre extraído pelo FFmpeg, nunca decodificado
  pelo Chrome.
- Render mais rápido: codifica enquanto captura, sem PNG em disco; método e números em `docs/perf.md`.

### Catálogo

- 48 blocos prontos (28 paisagem, 20 vertical), todos com miniatura, hash e golden.
- Transições entre cenas e galeria navegável com prévia ao vivo.
- 25 famílias de fonte OFL embarcadas; fonte declarada que não carrega bloqueia o render em vez de trocar de
  fonte em silêncio.

### Legendas

- Legendas por transcrição (Groq, OpenAI-compatível ou local por comando explícito), com quebra equilibrada de
  linhas e karaokê palavra a palavra.
- Em vídeo vertical a caixa usa até 84% da largura e a fonte acompanha a largura, em vez de espremer o texto
  numa coluna estreita.

### Mix

- Áudio de entrega a -14 LUFS, com ducking sob voz e automação de volume por keyframes.
- O limite de true peak (-1 dBTP) vale para o arquivo codificado: o mix mede o AAC/Opus final, corrige uma vez e
  avisa o ganho aplicado; se ainda passar, falha com `E_AUDIO_TRUE_PEAK`.
- Silêncio digital não quebra a normalização e `--no-loudness` entrega o mix cru.

### Falhas

- Contrato inválido bloqueia o render; todo erro tem código `E_*` estável e dica acionável, e `docs/reference/`
  lista todos eles, gerados do código.
- Captura nunca espera para sempre, fonte ausente e imagem ausente falham em vez de sumir, e remover temporários
  que falha deixa de ser silencioso.
- Cancelar (`E_CANCELED`) para o FFmpeg e o browser e não deixa temporários nem arquivo parcial.
- O número padrão de workers vem da memória livre, não da total: com a máquina cheia de programas abertos o render
  não abre mais Chromes do que cabem, e avisa quando nem um cabe. Era a causa do timeout de seek visto no aceite.
- Estouro de prazo do seek ou da captura diz o frame, a etapa em que parou e as imagens e fontes pendentes.
- Falha de um worker no render paralelo fecha o Chrome dos outros, inclusive o que ainda estava abrindo; antes o
  processo podia não terminar.

### Onboarding

- `init` cria um projeto válido, `doctor` diz exatamente o que falta e qual comando rodar, e `skill install`
  entrega o guia para agentes.
- `setup` prepara a máquina inteira e é idempotente; `upgrade` consulta a versão publicada.

### Studio

- Player com timeline, inspetor e catálogo; cada edição é validada pelo contrato e gravada no HTML preservando
  formatação e comentários.
- Importar mídia, dividir, aparar, excluir, copiar/colar/duplicar, desfazer/refazer, faixas com ímã, zoom até o
  frame e forma de onda.
- Inserir bloco do catálogo e importar composição `.html` como sub-composição pelo próprio Studio.
- Tamanho e duração da raiz editáveis (projetos verticais, duração derivada dos clips) e rotação de vídeo de
  celular respeitada.
- Exportar MP4 pelo Studio com progresso e cancelar.

### Motion

- Atributos declarativos de motion (`data-enter`, `data-exit` e ênfase), 26 presets com miniatura, tipografia
  cinética por palavra ou letra, keyframes visuais por propriedade, mola e câmera em imagem e vídeo.
- Transições entre clips que se encostam, no contrato e no Studio, com aviso quando um `data-start` aninhado é
  ignorado.
- Todos os blocos do catálogo foram migrados para os atributos de motion.

### Geração

- `frankframes generate "…"` cria o vídeo a partir de um texto pelo Codex CLI com conta ChatGPT, validando o
  contrato antes de renderizar; `frames` extrai quadros para conferir o resultado.
- Exportação em lote com variáveis: um modelo, N vídeos, falha de um job não derruba o lote.

### Fechamento

- Aceite com vídeo real (vertical 1080×1920, 30 s, cortado, com bloco, legendas e loudness de entrega) feito
  inteiro pelo Studio e verificado por script (`scripts/accept-video.ts`): `ACEITE OK`.
- Gate local único (`node scripts/ci.ts`, e `--release` para o tarball) e instalação real do tarball verificada
  em prefixo limpo.

### Pendências conhecidas

<!-- Um item por pendência, na forma "- **EDT-N — título.** impacto." Ao resolver, apague o item inteiro (e a seção, se esvaziar) e mova o ganho para o épico certo acima. -->

- **EDT-5 — `doctor` numa VM Windows limpa não foi validado.** O diagnóstico foi exercitado na máquina de
  desenvolvimento e em Linux/Docker; numa instalação do Windows sem nada pode apontar um requisito que não previmos.
- **EDT-19 — whisper.cpp não vem embarcado.** A legenda local só funciona por comando explícito do usuário, que
  baixa o modelo; o padrão é um provedor remoto, que exige chave e envia o áudio para fora da máquina.
- **EDT-34 — não há CI em servidor próprio.** O gate (`node scripts/ci.ts`) roda local, na máquina de quem
  entrega; nada impede um push sem o gate além do hook de pré-push.
- **EDT-63 — não há catálogo remoto.** Os 48 blocos vêm dentro do pacote e só mudam com uma nova versão; blocos
  novos ou correções não chegam por atualização do catálogo.
