# Plano 1.0 — FrankFrames

Fonte de verdade da execução dos itens EDT-39 a EDT-65 (EDT-63 é pós-1.0). Papéis em `CLAUDE.md`:
a sessão de planejamento (Opus 5.5) mantém este arquivo, manda um item por vez para a sessão de
execução (Sonnet 5.5), revisa o diff, roda `node scripts/ci.ts` e faz commit/push/Jira.

Partes: **A — Studio** (EDT-39..46), **B — Motion** (EDT-47..56), **C — Geração e 1.0** (EDT-58..65).
A ordem global entre as partes fica na seção "Ordem global" ao fim, mantida pelo planejamento.

**Vídeo real para testes (decisão do titular):** todo teste manual ou de integração que precise de
vídeo de verdade usa `C:\Users\rober\Downloads\video-teste.mp4`. Ele tem H.264 1080×1920 (vertical) a
30 fps, 8,08 s, AAC estéreo 44,1 kHz e 10 MB. Fica fora do repositório. Teste automatizado do gate
continua com mídia gerada por FFmpeg; o que depender desse arquivo faz `skip` explícito quando ele não
existe. O `A001_11181126_H685.MOV` fica reservado ao roteiro de aceite do EDT-64.

---

## Plano Studio — EDT-39 a EDT-46 (épico EDT-35)

Repositório: `C:\Users\rober\Sync\FrankFrames\frankframes`. Node 24 roda TS direto, sem build.
Executor: **não faz commit, push nem mexe no Jira**. Ao fim de cada item: `node scripts/ci.ts --fast`
verde e, para item com teste de Chrome/FFmpeg, `node --test <arquivo>` rodado e saída anexada ao relato.
O planejador roda `node scripts/ci.ts` completo antes do commit.

Regras que valem para todo item (de `.omp/RULES.md` e `.omp/AGENTS.md`):
- Spec antes do código: o texto de `docs/contract.md` muda **no mesmo item**.
- Erro com código `E_*` estável e `hint`; nada de catch vazio nem fallback silencioso.
- Teste `node:test`; teste que precisa de Chrome usa `resolveChrome()` e faz `t.skip("sem Chrome")`;
  que precisa de FFmpeg usa `resolveFfmpeg()` em try e faz `t.skip("sem FFmpeg")`. Nunca passa calado.
- Todo teste novo precisa falhar sem a mudança. Conferir isso rodando antes de implementar (TDD) ou
  revertendo a mudança localmente.
- Sem GSAP, sem encoder GPL, sem CDN, sem GitHub Actions.

Mapa rápido do código (para não reler tudo):
- `packages/cli/src/studio-server.ts` — rotas (`handle()` ~l.560–675), `compositionPayload` (l.371),
  `split` (l.512, modelo para todo endpoint de edição), `serial`, `commit(label, before, after)`,
  `validated(next,msg)`, `durationOf`, `nextClipId`, `ReplyError`, `STUDIO_FILES` (l.31, allowlist dos
  arquivos estáticos), SSE em `/api/events` (`client.write("data: change\n\n")`, l.278).
- `packages/cli/src/studio/app.js` — IIFE único; `state`, `renderTimeline`, `positionBar`,
  `onBarPointerDown`/`onDragMove`/`onDragEnd`, `queuePatch`, `mutate`, `runTool`, `splittable`,
  `readPlayerTime`, `togglePlayback`, handler de `keydown`, `setInterval` de 100 ms do playhead.
- `packages/producer/src/edit.ts` — `applyPatches`, `splitClip` (l.176), `EditError` (l.30).
- `packages/engine/src/clock.ts` — `startLive`/`stopLive`/`liveHooks`/`seek` (l.121–215).
- `packages/engine/src/preview-ui.ts`, `inject.ts` (`Injection`, `injectionScript`).
- `packages/producer/src/audio.ts` — `buildAudioGraph`, `mixAudio` (l.338), `DEFAULT_DUCK`, `DELIVERY_LOUDNESS`.
- `packages/producer/src/render.ts` — `renderComposition` (l.240), lista de áudio inline l.305–321.

---

### Fase 0 — base comum (vai junto com EDT-39, mesmo commit)

Existe para que os itens seguintes não briguem pelos mesmos trechos de `app.js`/`studio-server.ts`/`edit.ts`.

#### Desenho
1. **Lógica pura da timeline sai do IIFE** para `packages/cli/src/studio/timeline-math.js` (ESM puro,
   sem DOM, importável pelo Node nos testes). `app.js` passa a ser `<script type="module" src="/app.js">`
   e faz `import { … } from "/timeline-math.js"`; o corpo do IIFE continua igual. `"/timeline-math.js"`
   entra em `STUDIO_FILES`. Funções iniciais: `frameCount(total,fps)`, `lastFrameTime(total,fps)`,
   `roundToFrame(t,fps)`. Itens seguintes acrescentam funções aqui.
2. **`compositionPayload` ganha os campos que 41–46 precisam**, de uma vez:
   `track` (`clip.track`), `kind` (`"audio"` para `<audio>`; `"video"` para `<video>`, `<img>` e host de
   sub-composição; `"text"` para o resto), `hasAudio` (`clip.hasAudio === true`), `mediaSrc`
   (`clip.mediaSrc ?? null`), `fadeIn`, `fadeOut` (`?? null`), `hasKeyframes` (`clip.keyframes !== undefined`),
   `hasChildren` (`clip.children.length > 0 || clip.isSubComposition`), `parentId` (id do clip pai ou `null`;
   calcular em `flattenClips`), `editable` (`true` só para clip de topo com `data-clip-id` explícito no
   arquivo — mesma checagem de `splitClip`). `normalizeClip` em app.js passa a ler esses campos.
3. **Helpers compartilhados em `edit.ts`** extraídos de `splitClip`, sem mudar comportamento:
   - `locateClip(source, clipId): { node, start: number, end: number }` (offsets no arquivo; lança
     `E_CLIP_NOT_FOUND` "precisa de data-clip-id explícito" se não houver exatamente um nó);
   - `topLevelClip(composition, clipId, code)` (lança `code` se aninhado);
   - `referrersOf(all, ids: Set<string>, source)` (clips fora de `ids` com `startExpr.kind === "reference"`
     apontando para algum id de `ids`; lança erro se o referenciador não tem `data-clip-id` no arquivo);
   - `removeRange(source, start, end)` (remove o elemento e, se a linha ficar só com espaço, a linha inteira);
   - `refSuffix(offset)` (o `" + 1.5"`/`" - 0.2"` que hoje está inline).
   `splitClip` passa a usá-los; `packages/producer/test/edit.test.ts` atual tem que continuar verde.
4. **Guarda de foco para atalhos**: em app.js, `isTyping(event)` = alvo é `input`, `textarea`, `select`
   ou `[contenteditable]`. Todo atalho novo (Delete, Ctrl+C/V/D, L, `=`/`-`) é ignorado quando
   `isTyping` é verdadeiro. Os atalhos atuais (S, setas, Ctrl+Z) passam a usar a mesma guarda.

#### Spec
Nenhuma mudança de comportamento de contrato. Em §9d, acrescentar uma linha: "`GET /api/composition`
devolve, por clip, `track`, `kind` (`video`/`text`/`audio`), `editable` e os campos de mídia; ferramentas de
edição só operam em clip `editable`."

#### Passos
1. Criar `packages/cli/src/studio/timeline-math.js` com as três funções. `frameCount = Math.max(1, Math.ceil(total*fps - 1e-9))`; `lastFrameTime = (frameCount-1)/fps`.
2. `index.html`: trocar `<script src="/app.js" defer>` por `<script type="module" src="/app.js">`. `app.js`: adicionar o `import` no topo (fora do IIFE). Conferir no navegador que nada quebrou (módulo é `defer` por padrão).
3. `studio-server.ts`: `STUDIO_FILES["/timeline-math.js"] = "timeline-math.js"`; expandir `flattenClips` para carregar `parentId`; expandir `compositionPayload` com os campos do Desenho §2.
4. `edit.ts`: extrair os helpers do Desenho §3 e reescrever `splitClip` com eles.
5. `app.js`: `isTyping` + aplicar no handler de `keydown`.

#### Testes
- `packages/cli/test/timeline-math.test.ts` (novo; entra em `FAST_TESTS` de `scripts/ci.ts`):
  `frameCount(3,30)=90`, `lastFrameTime(3,30)=89/30`, `frameCount(0.5,30)=15`, `lastFrameTime(1/30,30)=0`.
  Falha sem o arquivo.
- `packages/cli/test/studio-server.test.ts`: `GET /api/composition` de uma composição com `<audio data-clip-id="a" data-track="3">`, `<video>` sem áudio e `<div>` de texto aninhado em sub-composição → confere `kind`, `track`, `hasAudio`, `parentId`, `editable:false` no aninhado. Falha sem o passo 3.
- `packages/cli/test/studio-server.test.ts`: `GET /timeline-math.js` responde 200 com `text/javascript`.
- `edit.test.ts` existente continua verde (prova que a extração não mudou o split).

#### Verificação manual
`node packages/cli/src/cli.ts studio examples/hello.html`: timeline, seleção, split, undo funcionam igual a antes; console sem erro.

#### Arquivos tocados
`packages/cli/src/studio/timeline-math.js` (novo), `packages/cli/src/studio/app.js`, `packages/cli/src/studio/index.html`, `packages/cli/src/studio-server.ts`, `packages/producer/src/edit.ts`, `packages/cli/test/timeline-math.test.ts` (novo), `packages/cli/test/studio-server.test.ts`, `scripts/ci.ts`, `docs/contract.md` §9d.
**Dependências**: nenhuma.

#### Riscos
- `type="module"` muda o escopo: se algum handler inline em `index.html` (`onclick="…"`) chama função global do app.js, quebra. Conferir com grep `onclick=` antes.
- O pacote `@frankframes/cli` publica `src/`: conferir `files` no `package.json` para o `.js` novo ir junto.

---

#### EDT-39 — Relógio ao vivo passa do fim; playhead trava e S/Dividir morre

**Causa raiz** (confirmada no código): `startLive(startAtMs)` em `clock.ts` faz `nowMs = realNow() - base`
a cada rAF **sem limite** — o relógio não conhece a duração. A barra (`preview-ui.ts`) só limita o frame
*desenhado* (`clampMs`) e o Play retoma com `startLive(__ff.now())` mesmo depois do fim. Resultado: `now()`
chega a 15 s num arquivo de 3 s, `syncVisibility` esconde tudo (frame preto), o Studio grampeia o playhead
em `total` e `splittable()` recusa porque `at >= end - 0.001` no último clip. Bugs vizinhos achados:
`inject.ts` embrulha a UI em `addEventListener("DOMContentLoaded", function(){…})();` — o `()` final chama
`undefined` e lança `TypeError` no load; a barra abre `EventSource("/__ff_reload")`, que o Studio não tem
(404 em loop); `togglePlayback` cai num `postMessage("ff-toggle")` que ninguém escuta.

##### Desenho
- **Relógio com fim** em `CLOCK_SOURCE`:
  - `__ff.setLiveBounds({ endMs, frameMs, loop })` grava os limites; `lastFrameMs = endMs - frameMs`.
    Sem chamada, o comportamento é o de hoje (ilimitado) — só usado por quem não tem barra.
  - `__ff.transportHooks: Array<(event) => void>`, com `event = { type, ms }`, `type ∈ "start" | "stop" | "seek" | "end" | "loop"`.
    Disparado por `startLive`, `stopLive`, `seek`, e no tick ao bater no fim. Exceção num hook vai para
    `liveErrors` (como os `liveHooks`), nunca some.
  - `__ff.playing(): boolean` (`liveHandle !== null`).
  - No `tick`, com limites: se `t >= endMs`:
    - `loop === true` → `t = t % endMs`, `base = realNow() - t`, dispara `{type:"loop", ms:t}`;
    - senão → `nowMs = lastFrameMs`, sincroniza, `stopLive()`, dispara `{type:"end", ms:lastFrameMs}`.
  - `startLive(ms)` e `seek(ms)` grampeiam em `[0, lastFrameMs]` quando há limites. O `sessionStorage`
    nunca recebe valor acima de `lastFrameMs`.
- **Barra de preview** (`preview-ui.ts`):
  - Chama `__ff.setLiveBounds` com `endMs = frames/fps*1000`, `frameMs = 1000/fps` e `loop` lido de `sessionStorage["__ffLoop:"+id]`.
  - Play com `now() >= lastFrameMs - 0.5` → `seek(0)` e `startLive(0)` (recomeça do início).
  - Hook `end` → `paused = true` e atualiza o rótulo do botão.
  - Botão novo `[data-ff-loop]` (`aria-pressed`, rótulo "⟳ Loop") alterna `loop` e persiste.
- **Injeção**: corrigir o `})();` para `});`. `Injection.preview` ganha `reload?: boolean` (padrão `true`); com
  `false` a barra não abre `EventSource`. O Studio passa `reload: false`, porque ele recarrega pelo próprio `/api/events`.
- **Studio** (`app.js`):
  - O playhead grampeia em `lastFrameTime(total,fps)`, não em `total`. Assim S funciona no último clip depois de tocar até o fim, desde que o clip dure mais que 1 frame.
  - `togglePlayback` sem `[data-ff-play]` mostra erro no status ("preview sem barra de controle") em vez do `postMessage` morto, que é apagado.
  - Tecla **L** clica `[data-ff-loop]` no iframe.

##### Spec
§9c, substituir o 2º parágrafo por: "No preview o relógio roda em **tempo real** (`__ff.startLive`) e
**termina no último frame** (`(frames − 1) / fps`): ao chegar lá, para e fica nele; Play no fim recomeça do 0.
Com **Loop** ligado (botão ⟳ da barra; tecla L no Studio; lembrado na aba), volta ao 0 sem parar. O instante
guardado em `sessionStorage` nunca passa do último frame. `__ff.transportHooks` recebe
`start/stop/seek/end/loop`." §9d: "O playhead do Studio vai de 0 ao início do último frame."

##### Passos
1. `packages/engine/src/clock.ts`:
   - adicionar `bounds = null`, `setLiveBounds`, `transportHooks`, `emit(type, ms)` com try/catch que empurra para `liveErrors`, e `playing`;
   - aplicar o grampo em `startLive`/`seek` e a lógica de fim no `tick`;
   - `stopLive` emite `stop` só se estava tocando;
   - exportar tudo em `window.__ff`.
2. `packages/engine/src/preview-ui.ts`: `setLiveBounds` na inicialização, restart no fim, hook `end`, botão `[data-ff-loop]` com estilo igual aos outros botões da barra, `reload` lido de `__ffPreviewMeta.reload !== false` antes de abrir o `EventSource`.
3. `packages/engine/src/inject.ts`: corrigir `})();` → `});`; `preview?: { fps; frames; id?; reload?: boolean }`.
4. `packages/cli/src/studio-server.ts` (`loadPreview`): `preview: { fps, frames: totalFrames, id, reload: false }`.
5. `packages/cli/src/studio/app.js`:
   - `setInterval` do playhead usa `clamp(now/1000, 0, lastFrameTime(state.total, state.fps))`;
   - `applyComposition` também grampeia assim;
   - `togglePlayback` sem fallback morto;
   - tecla `l`.
6. `docs/contract.md` §9c/§9d.

##### Testes
- `packages/engine/test/preview-ui.test.ts` (Chrome, skip explícito) — novos casos com composição de 0,5 s, `preview:{fps:30, frames:15}`:
  1. clicar `[data-ff-play]`, esperar até `__ff.playing() === false` (teto 3 s) → `__ff.now() === 14*1000/30` e `!playing()`. Falha hoje: `now()` passa de 500.
  2. depois do fim, clicar Play → em ≤ 150 ms `now() < 200` e `playing() === true`.
  3. clicar `[data-ff-loop]`, Play, esperar 1,2 s → `playing() === true` e `now() < 500`.
  4. `sessionStorage` (`"__ffTime"`) nunca acima de 467 depois do caso 1.
- `packages/engine/test/preview-ui.test.ts` (Chrome): página carregada sem `pageerror`/exceção. Usar o mecanismo que `capture.ts`/`Session` já expõe para erros de página; se não houver, avaliar `window.__ffErrors` coletado por um `window.addEventListener("error")` injetado no HTML de teste antes do bloco do engine. Falha hoje por causa do `})();`.
- `packages/engine/test/clock.test.ts` (rápido): `injectionScript({preview:{fps:30,frames:3,reload:false}})` não contém `"__ff_reload"`; com `reload` omitido contém. E o bloco da UI não casa `/\}\)\(\);<\/script>/`.
- `packages/cli/test/timeline-math.test.ts`: já cobre `lastFrameTime` (Fase 0).

##### Verificação manual
Studio com `examples/hello.html`:
- Space toca até o fim. O frame final fica visível (não preto), o playhead para no último frame e o botão volta para "Play".
- S com o último clip selecionado divide no playhead.
- Space de novo recomeça do 0.
- L e depois Space ficam em loop.
- No DevTools, a aba Network não mostra `/__ff_reload` e o console fica sem `TypeError`.

##### Arquivos tocados
`packages/engine/src/clock.ts`, `packages/engine/src/preview-ui.ts`, `packages/engine/src/inject.ts`, `packages/cli/src/studio-server.ts`, `packages/cli/src/studio/app.js`, `packages/engine/test/preview-ui.test.ts`, `packages/engine/test/clock.test.ts`, `docs/contract.md`.
**Dependências**: Fase 0 (mesmo commit).

##### Riscos
- Loop volta o tempo: timers do autor (`setTimeout` virtual) e estado JS não rebobinam, mesma limitação que já existe no scrub para trás. Documentado, não resolvido aqui.
- O render não usa `startLive`. Conferir que `determinism.test.ts` e `live.test.ts` continuam verdes (sem `setLiveBounds` o relógio é o de hoje).

---

#### EDT-40 — Áudio fiel no player (volume, fades, rate, offset, keyframes, ducking)

##### Desenho
**Decisão: o preview toca o mesmo mix do render**, feito pelo FFmpeg no servidor com o mesmo
`buildAudioGraph`/`mixAudio` (o mesmo `atempo` que preserva o tom, o mesmo `volume='piecewise'` dos
keyframes, o mesmo ducking de 9 dB/80 ms/250 ms, os mesmos `afade`/`adelay` e o mesmo `loudnorm` de duas
passadas). Esse mix sai em WAV e fica em cache por hash. Recriar o grafo em Web Audio duplicaria a regra
e divergiria (loudnorm e atempo não existem no navegador), o que viola "o que aparece é o que sai".

- **Producer** — novo `packages/producer/src/preview-audio.ts`:
  - `audioClipsFor(prepared: PreparedComposition): AudioClip[]`: move as linhas 305–321 de `render.ts`, que passa a chamar esta função.
  - `previewAudioKey(clips, totalSeconds, stats: Record<string,{size:number, mtimeMs:number}>): string`: sha256 de `JSON.stringify({v:1, clips, totalSeconds, stats, duck: DEFAULT_DUCK, loudness: DELIVERY_LOUDNESS})`. Edição só visual não muda a chave.
  - `renderPreviewAudio({ prepared, ffmpeg, cacheDir, signal? }): Promise<{ key, file, warnings } | null>`:
    - devolve `null` sem clips de áudio;
    - se `<cacheDir>/<key>.wav` já existe, reaproveita o arquivo;
    - senão chama `mixAudio({…, outPath: "<key>.tmp-<pid>.wav", format: "wav"})` e depois faz `rename`;
    - `cacheDir = assetPath("cache", "preview-audio")`.
  - `mixAudio` ganha `format?: "aac" | "wav"` (padrão `"aac"`): `wav` usa `-c:a pcm_s16le` no lugar de `-c:a aac -b:a 192k`. O resto do grafo fica idêntico.
  - Exportar tudo em `packages/producer/src/index.ts`.
- **Engine** — novo runtime `packages/engine/src/preview-audio.ts` exportando `PREVIEW_AUDIO_SOURCE`, injetado quando `Injection.audio` existe:
  - `audio?: { src: string } | { error: string }` vira `window.__ffPreviewAudio`.
  - No load:
    - `fetch(src)` → `AudioContext.decodeAudioData`;
    - silencia e pausa todo `<audio>`/`<video>` nativo da página (`muted = true`, `pause()`), porque o som vem só do mix.
  - Sincronização pelos `__ff.transportHooks` do EDT-39:
    - `start`/`loop`/`seek` com relógio tocando → para o nó atual e cria um `AudioBufferSourceNode` com `start(ctx.currentTime + 0.05, (ms + 50) / 1000)`, guardando âncora `{ctxT0, ms0}`;
    - `stop`/`end` → `stop()`;
    - `seek` parado → só guarda a posição.
  - Correção de deriva a cada 250 ms enquanto toca:
    - `audioMs = ms0 + (ctx.currentTime - ctxT0) * 1000 - ctx.outputLatency*1000`, comparado com `__ff.now()`;
    - `|Δ| > frameMs/2` → reinicia o nó em `__ff.now()`.
  - `__ff.audioState()` → `{ status: "none"|"loading"|"ready"|"suspended"|"error", playing, driftMs, error? }`.
  - Falha alta e visível:
    - erro de fetch/decode, ou `{error}` vindo do servidor → `status:"error"`, texto em `[data-ff-audio-status]` na barra e push em `liveErrors`;
    - `ctx.state === "suspended"` depois do start → badge "Som bloqueado — clique para ativar" que chama `ctx.resume()`.
  - Teto: composição acima de 20 min não baixa o mix; mostra "áudio do preview desligado acima de 20 min" (memória ≈ 23 MB/min decodificado).
- **Studio**:
  - `loadPreview`, depois do `prepare`, chama `renderPreviewAudio`;
  - se o resultado não for `null`, injeta `audio:{src:"/__ff_audio/<key>.wav"}`; se lançar erro, injeta `audio:{error:"E_PREVIEW_AUDIO: <mensagem>"}` e o vídeo do preview continua (o erro aparece na barra, nada cai calado);
  - rota `GET /__ff_audio/<key>.wav` (só `^[0-9a-f]{64}$`; senão 404) serve de `cacheDir` como `audio/wav`; Range não é necessário, porque o runtime baixa inteiro;
  - o iframe ganha `allow="autoplay"`.
- **CLI preview** (`frankframes preview`): `startServer` ganha `audioDir?: string`, servindo `/__ff_audio/`. O comando `preview` em `cli.ts` chama `renderPreviewAudio` no load e em cada recompile.
- `data-keyframes` continua só de volume. Nada no contrato muda de semântica.

##### Spec
§9c, acrescentar: "**Áudio no preview** é o mesmo mix do render (mesmo grafo: volume, fades, `data-offset`,
`data-playback-rate` com tom preservado, `data-keyframes`, ducking de `music` sob `voice` e loudnorm de entrega),
feito pelo FFmpeg em WAV e guardado em `cache/preview-audio/<sha256>.wav`. A chave só muda quando muda algo
que entra no mix, então editar texto ou layout não refaz o áudio. O player sincroniza o áudio com o relógio
e corrige deriva acima de meio frame. Se o navegador bloquear o som, a barra mostra o aviso; falha do mix aparece
na barra (`E_PREVIEW_AUDIO`) sem derrubar o vídeo. Acima de 20 min o áudio do preview fica desligado, com aviso."

##### Passos
1. `audio.ts`: opção `format` em `MixOptions`/`mixAudio`. Teste rápido do argumento de codec: se a montagem dos args for inline, extrair `codecArgs(format)` puro.
2. Criar `producer/src/preview-audio.ts` (`audioClipsFor`, `previewAudioKey`, `renderPreviewAudio`). `render.ts` passa a usar `audioClipsFor`. Exportar no `index.ts`.
3. Criar `engine/src/preview-audio.ts` (`PREVIEW_AUDIO_SOURCE`) e exportar no `engine/src/index.ts`. `inject.ts` adiciona `audio?` em `Injection` e injeta o runtime **depois** do clock e **antes** da barra.
4. `preview-ui.ts`: elemento `[data-ff-audio-status]` (vazio quando ok) na barra.
5. `studio-server.ts`: `renderPreviewAudio` em `loadPreview` (o cache por mtime já existe; o áudio entra no mesmo objeto `preview`), rota `/__ff_audio/`.
6. `index.html`: `allow="autoplay"` no `#player`.
7. `engine/src/server.ts`: opção `audioDir`. `cli.ts` (comando `preview`): chamar `renderPreviewAudio` e passar `audio` para a injeção.
8. `docs/contract.md` §9c.

##### Testes
- `packages/producer/test/preview-audio.test.ts` (novo; casos puros entram em `FAST_TESTS`):
  - `audioClipsFor` de uma composição com `<audio data-volume="0.5" data-fade-in="0.2" data-audio-role="music" data-keyframes='[…]' data-offset="1" data-playback-rate="1.5">` traz todos os campos;
  - `previewAudioKey`: mesma entrada dá a mesma chave; mudar `volume` muda a chave; mudar `stats[file].mtimeMs` muda a chave.
  - Falha sem o arquivo.
- Mesmo arquivo (FFmpeg, skip): gerar WAV de 1 s (copiar o helper `wav()` de `studio-tools.test.ts`) e uma composição de 2 s com ele em `start=0.5`:
  - `renderPreviewAudio` cria o `.wav`, e o ffprobe dá duração = 2 s ± 1/30;
  - a 2ª chamada devolve a mesma `key` sem reescrever (mtime igual);
  - `mixAudio` com `format:"wav"` produz `codec_name=pcm_s16le`.
- `packages/engine/test/preview-audio.test.ts` (novo, Chrome, skip): servidor de teste servindo um WAV de 2 s e página com `injectEngine(html,{live:true, preview:{fps:30,frames:60}, audio:{src:"/tone.wav"}})`:
  1. `audioState().status` chega a `"ready"`;
  2. Play → `playing:true`;
  3. `__ff.seek(1000)` tocando → depois de 400 ms `|driftMs| ≤ 1000/60`;
  4. pausa → `playing:false`;
  5. fim (EDT-39) → `playing:false`;
  6. `src` 404 → `status:"error"` e `[data-ff-audio-status]` com texto.
- `packages/cli/test/studio-tools.test.ts` (FFmpeg, skip):
  - composição com áudio → `GET /preview` contém `__ffPreviewAudio`, e o `src` responde 200 `audio/wav`;
  - composição sem áudio → não contém;
  - `GET /__ff_audio/../x.wav` → 404.

##### Verificação manual
Importar no Studio uma música (`data-audio-role="music"`) e uma voz (`voice`) sobrepostas. Ajustar volume e rate pelo inspetor e pôr `data-fade-in="1"` e `data-keyframes` à mão.
- Play: a música abaixa sob a voz, o fade e o rate são audíveis, e o tom fica preservado em rate 1.5.
- Scrub e play no meio: o som entra no ponto certo. Pause corta o som na hora.
- Exportar (ou `render`) e comparar de ouvido com o preview: o mix é o mesmo.
- Editar só um texto: o preview recarrega sem refazer o mix (log/tempo).

##### Arquivos tocados
`packages/producer/src/audio.ts`, `packages/producer/src/render.ts`, `packages/producer/src/preview-audio.ts` (novo), `packages/producer/src/index.ts`, `packages/engine/src/preview-audio.ts` (novo), `packages/engine/src/index.ts`, `packages/engine/src/inject.ts`, `packages/engine/src/preview-ui.ts`, `packages/engine/src/server.ts`, `packages/cli/src/cli.ts`, `packages/cli/src/studio-server.ts`, `packages/cli/src/studio/index.html`, testes acima, `scripts/ci.ts`, `docs/contract.md`.
**Dependências**: EDT-39 (`transportHooks`, `setLiveBounds`, `inject.ts`/`preview-ui.ts`).

##### Riscos
- **Latência**: o mix de duas passadas atrasa o `/preview` depois de toda edição de áudio (≈ 1–3 s em 1 min de áudio). Mitigação: cache por chave; medir e registrar no relato. Se passar de 5 s em 3 min, falar com o planejador antes de inventar mix assíncrono.
- **Headless sem saída de áudio**: se `ctx.currentTime` não andar no Chrome de teste, o caso de deriva não prova nada. Reportar em vez de afrouxar o teste.
- **Autoplay**: o clique no Studio é no documento pai. Com `allow="autoplay"` e mesma origem deve bastar; se não bastar, o badge pede o clique. Nunca tocar mudo em silêncio.
- **Memória**: o teto de 20 min está explícito na spec.

---

#### EDT-41 — Excluir clip sem mover o resto

##### Desenho
- `deleteClip(source, { clipId }): string` em `edit.ts`:
  - ids removidos = o clip mais todos os descendentes (`children` recursivo);
  - referenciadores (`referrersOf`, fora do conjunto) recebem `data-start` absoluto = `seconds(referrer.start)`, o início já resolvido no escopo dele, então nada se move;
  - remove o trecho com `removeRange`.
- Erros:
  - `E_CLIP_NOT_FOUND` (sem `data-clip-id` explícito);
  - `E_DELETE_UNSUPPORTED`: clip dentro de sub-composição de outro arquivo, ou referenciador sem `data-clip-id`. Hint: "edite o arquivo da sub-composição" / "dê data-clip-id a <id>".
  - Composição que fica sem clip temporizado cai no `validated()` → 400 `E_CONTRACT_INVALID`, como hoje.
- Endpoint `POST /api/clips/<id>/delete`, corpo `{}` → `200 {ok:true, id, duration, history}`. Mesma forma do `split`. Histórico: `commit("excluir <id>", …)`.
- Studio:
  - **Delete** e **Backspace** (com `isTyping` falso e clip selecionado) e botão `#deleteButton` "Excluir" na toolbar, desabilitado sem seleção ou com `editable:false`;
  - depois de excluir, `selectedId = null`. Ctrl+Z desfaz pelo histórico existente.

##### Spec
§9d, novo item: "**Excluir** (`POST /api/clips/<id>/delete`; Delete/Backspace). Remove o clip e o que estiver
dentro dele. Clips que começavam no fim dele (`data-start="<id>"` ou `"<id> + x"`) ganham `data-start`
absoluto igual ao instante em que já começavam: nada mais se move. Exige `data-clip-id` explícito e clip
deste arquivo (`E_DELETE_UNSUPPORTED`). Entra no desfazer."

##### Passos
1. `edit.ts`: adicionar `"E_DELETE_UNSUPPORTED"` ao union de `EditError.code`; implementar `deleteClip` com os helpers da Fase 0; exportar no `producer/src/index.ts`.
2. `studio-server.ts`:
   - no roteamento de `/api/clips/`, casar `^([^/]+)\/delete$` antes do patch genérico;
   - handler `remove(clipId, req, res)`, que copia `split`: lê o arquivo, chama `deleteClip`, mapeia `EditError` para 400, depois `validated` e `commit`.
3. `index.html`: `#deleteButton`. `app.js`:
   - `deleteSelected()` via `runTool`/`mutate("POST", "/api/clips/"+id+"/delete", {})`;
   - teclas `Delete`/`Backspace` com `preventDefault`;
   - `updateToolbar` habilita ou desabilita o botão.
4. `docs/contract.md` §9d.

##### Testes
- `packages/producer/test/edit.test.ts`:
  1. `a(0–2)`, `b data-start="a"`, `c data-start="b + 0.5"` → excluir `b` → `c` fica com `data-start="2.5"`; `loadComposition` dá o mesmo `start` de `c` antes e depois; o resto do arquivo fica byte a byte igual fora das linhas mexidas.
  2. Excluir um container com filho referenciado de fora → o referenciador vira absoluto.
  3. Referenciador sem `data-clip-id` → `E_DELETE_UNSUPPORTED`.
  4. Id inexistente → `E_CLIP_NOT_FOUND`.
  5. Linha vazia removida (sem buraco de espaço).
- `packages/cli/test/studio-tools.test.ts`: `POST /api/clips/b/delete` → 200; o arquivo não tem `b`; `POST /api/undo` restaura o arquivo idêntico.
- `packages/cli/test/studio-tools.test.ts`: excluir o único clip de uma raiz sem `data-duration` → 400 `E_CONTRACT_INVALID` e o arquivo não muda.

##### Verificação manual
Selecionar um clip do meio que outro referencia: Delete → ele some e o seguinte não pula. Ctrl+Z → volta. Com foco no campo de texto do inspetor, Backspace apaga letra, não o clip.

##### Arquivos tocados
`packages/producer/src/edit.ts`, `packages/producer/src/index.ts`, `packages/cli/src/studio-server.ts`, `packages/cli/src/studio/app.js`, `packages/cli/src/studio/index.html`, `packages/producer/test/edit.test.ts`, `packages/cli/test/studio-tools.test.ts`, `docs/contract.md`.
**Dependências**: Fase 0.

##### Riscos
- `referrer.start` de clip aninhado é tempo do escopo. Confirmar em `packages/contract/src/resolve.ts` que referência só resolve dentro do mesmo escopo; se cruzar escopo, recusar com `E_DELETE_UNSUPPORTED` em vez de calcular errado.
- CSS/JS do autor que mira o elemento excluído (`#id`) continua no arquivo. Fora do escopo; não tentar limpar.

---

#### EDT-42 — Aparar pela borda esquerda

##### Desenho
- `trimClipStart(source, { clipId, start }): string` em `edit.ts`, com `start` no mesmo tempo de escopo de `clip.start`:
  - `delta = start - clip.start`;
  - `data-duration = seconds(clip.end - start)` (o fim fica onde estava);
  - `data-start`:
    - se `startExpr` é absoluto → `seconds(start)`;
    - se é referência → `"<refId>" + refSuffix(startExpr.offset + delta)`, mantendo o vínculo;
  - vídeo/áudio: `data-offset = seconds(clip.offset + delta * clip.playbackRate)`;
  - `data-fade-in` fica.
- Erros:
  - `E_TRIM_OUT_OF_RANGE`: `start >= end - MIN_DURATION_SECONDS` (exportado por `@frankframes/contract`), `start < 0`, ou offset resultante `< 0` (não há mídia antes do início da fonte). Hint com o mínimo permitido.
  - `E_TRIM_UNSUPPORTED`: clip aninhado, com filhos/sub-composição (deslocaria a sub-timeline), com `data-keyframes` (tempo local mudaria), ou sem início/fim resolvidos. Hint: "declare data-duration".
- Endpoint `POST /api/clips/<id>/trim {start:number}` → `200 {ok, id, duration, history}`; `commit("aparar <id>")`.
- Studio:
  - `.resize-handle-start` à esquerda do `.clip-bar` (só se `editable` e sem `hasKeyframes`/`hasChildren`);
  - modo de drag `"trim-start"`, com prévia visual que grampeia em `max(0, start - offset/rate)` (mídia), `0` e `end - MIN_DURATION`;
  - no `onDragEnd`, chama `mutate` no `/trim`. Não usar `queuePatch`, porque o offset é calculado no servidor.
  - Valor arredondado ao frame (`roundToFrame`).

##### Spec
§9d, novo item: "**Aparar o início** (`POST /api/clips/<id>/trim {start}`; borda esquerda na timeline).
Muda `data-start` e `data-duration` mantendo o fim; em vídeo/áudio, `data-offset` avança
`(novo início − início) × data-playback-rate`. `data-start` por referência continua referência (só muda o
deslocamento). Recusa início que deixaria menos de `MIN_DURATION_SECONDS`, negativo, ou antes do começo da
mídia (`E_TRIM_OUT_OF_RANGE`), e clip com filhos, `data-keyframes` ou aninhado (`E_TRIM_UNSUPPORTED`)."

##### Passos
1. `edit.ts`: códigos `E_TRIM_OUT_OF_RANGE` e `E_TRIM_UNSUPPORTED`; `trimClipStart`; exportar.
2. `studio-server.ts`: rota `^([^/]+)\/trim$` + handler `trim` (cópia de `split` com `numeric(body,"start")`).
3. `app.js`: handle esquerdo em `renderTimeline`, modo `"trim-start"` em `onBarPointerDown`/`onDragMove`/`onDragEnd`. `style.css`: `.resize-handle-start`.
4. `docs/contract.md` §9d.

##### Testes
- `packages/producer/test/edit.test.ts`:
  1. vídeo `start=1 duration=4 offset=0.5 rate=2`, trim para 2 → `start=2`, `duration=3`, `offset=2.5`; `loadComposition` dá o `end` igual.
  2. `data-start="a + 0.5"`, trim +1 → `"a + 1.5"`.
  3. trim que daria offset < 0 → `E_TRIM_OUT_OF_RANGE`.
  4. trim que deixaria duração < mínimo → `E_TRIM_OUT_OF_RANGE`.
  5. clip com `data-keyframes` → `E_TRIM_UNSUPPORTED`.
  6. trim para trás (delta negativo) com offset suficiente → offset diminui.
- `packages/cli/test/studio-tools.test.ts`: `POST /api/clips/v/trim {start:2}` → 200, arquivo com os atributos esperados; `/api/undo` restaura.

##### Verificação manual
Clip de vídeo importado: arrastar a borda esquerda para a direita → o início anda, o fim fica parado, e no preview o vídeo começa do ponto aparado (não do zero). Arrastar para a esquerda além do início da fonte → a barra para no limite.

##### Arquivos tocados
`packages/producer/src/edit.ts`, `packages/producer/src/index.ts`, `packages/cli/src/studio-server.ts`, `packages/cli/src/studio/app.js`, `packages/cli/src/studio/style.css`, `packages/producer/test/edit.test.ts`, `packages/cli/test/studio-tools.test.ts`, `docs/contract.md`.
**Dependências**: Fase 0; depois de EDT-41 (mesmos trechos de `edit.ts`, roteamento e app.js).

##### Riscos
- Mídia sem `data-duration` (fim vindo do probe) não tem fim resolvido em `loadComposition` sem `mediaDurations`, e cai em `E_TRIM_UNSUPPORTED`. Clips importados pelo Studio sempre têm `data-duration`, então é aceitável. Fica na spec.

---

#### EDT-43 — Copiar, colar e duplicar

##### Desenho
- `duplicateClip(source, { clipId, at, newId }): { source: string; warnings: string[] }` em `edit.ts`:
  - copia o markup inteiro do elemento (com filhos) e insere logo **depois** do original (mesmo pai, mesma indentação, como no `splitClip`);
  - a cópia raiz recebe `data-clip-id=newId` e `data-start=seconds(at)` absoluto;
  - todo descendente com `data-clip-id="x"` vira `"<newId>-x"`;
  - dentro da cópia, `data-start` que referencia id renomeado é reescrito para o novo id;
  - referência a id de fora fica como está;
  - colisão de id → `E_AMBIGUOUS_CLIP`;
  - atributo HTML `id` dentro da cópia → `warnings` ("id HTML duplicado: <x>"), sem alterar.
- Erros:
  - `E_COPY_UNSUPPORTED`: só para clip aninhado. Host de sub-composição de topo pode ser copiado: copiar o host copia a referência `data-composition-src`, não o outro arquivo;
  - `E_COPY_OUT_OF_RANGE`: `at < 0` ou não finito.
- Endpoints:
  - `POST /api/clips/<id>/duplicate {}` → `at = clip.end`;
  - `POST /api/clips/<id>/paste {at:number}`.
  - Os dois respondem `200 {ok, id: newId, duration, warnings, history}`. `newId = nextClipId(source)`. `commit("duplicar <id>")` / `commit("colar <id>")`.
- Studio:
  - **Ctrl+C** guarda `state.clipboard = selectedId` e mostra no status "copiado <id>";
  - **Ctrl+V** chama `paste` em `at = state.playhead`;
  - **Ctrl+D** (`preventDefault`, senão o navegador abre favoritos) chama `duplicate`;
  - depois de colar/duplicar, `selectedId = id` da resposta;
  - `warnings` aparecem no status;
  - tudo com `isTyping` falso (nos campos, Ctrl+C/V nativo continua funcionando).
  - O clipboard é por referência: apagar o original antes de colar dá `E_CLIP_NOT_FOUND`, com a mensagem "o clip copiado não existe mais".

##### Spec
§9d, novo item: "**Copiar/colar/duplicar** (Ctrl+C, Ctrl+V no playhead, Ctrl+D logo após o original;
`POST /api/clips/<id>/paste {at}`, `POST /api/clips/<id>/duplicate`). Copia o elemento inteiro, com filhos,
para logo depois do original no arquivo, com `data-start` absoluto e `data-clip-id` novo; ids internos
viram `<novo>-<antigo>` e referências internas acompanham. Só clip de topo (`E_COPY_UNSUPPORTED`).
`id` HTML duplicado gera aviso. Copiar guarda a referência ao clip, não o conteúdo."

##### Passos
1. `edit.ts`: códigos `E_COPY_UNSUPPORTED` e `E_COPY_OUT_OF_RANGE`; `duplicateClip` (usar `locateClip` e `applyPatches` sobre o trecho copiado, como o `splitClip` faz com `copy`); exportar.
2. `studio-server.ts`: rotas `^([^/]+)\/(duplicate|paste)$` e handler `copy(clipId, mode, req, res)`.
3. `app.js`: `state.clipboard`, atalhos, seleção do novo clip, status.
4. `docs/contract.md` §9d.

##### Testes
- `packages/producer/test/edit.test.ts`:
  1. duplicar `t(1–3)` → novo elemento logo após, `data-start="3"`, mesmo `data-duration`, novo id; o original fica intocado.
  2. container `g` com filhos `g1` e `g2 data-start="g1"` → cópia tem `<new>-g1`, `<new>-g2` com `data-start="<new>-g1"`.
  3. cópia com `id="logo"` → `warnings` contém "logo".
  4. clip aninhado → `E_COPY_UNSUPPORTED`.
  5. `loadComposition` do resultado tem `ok:true`.
- `packages/cli/test/studio-tools.test.ts`: `paste {at:5}` → 200, o novo clip começa em 5; `duplicate` → começa no fim do original; `/api/undo` desfaz cada um.

##### Verificação manual
Selecionar um título: Ctrl+C, mover o playhead, Ctrl+V → cópia no playhead, selecionada. Ctrl+D → cópia logo após. Copiar um bloco com filhos → os filhos animam na cópia igual ao original.

##### Arquivos tocados
`packages/producer/src/edit.ts`, `packages/producer/src/index.ts`, `packages/cli/src/studio-server.ts`, `packages/cli/src/studio/app.js`, `packages/producer/test/edit.test.ts`, `packages/cli/test/studio-tools.test.ts`, `docs/contract.md`.
**Dependências**: Fase 0; depois de EDT-42 (mesmos trechos).

##### Riscos
- Seletores CSS por `[data-clip-id="x"]` no `<style>` do autor não miram a cópia renomeada; a animação via CSS de filho pode não se repetir. Registrar no relato. Não reescrever CSS.

---

#### EDT-45 — Zoom até frame e waveform

(Recomendado **antes** do EDT-44: troca o sistema de coordenadas da timeline, de % para px, que o EDT-44 usa no ímã.)

##### Desenho
- **Escala**:
  - `state.pxPerSecond`, com mínimo = "ajustar" (`largura visível / total`) e máximo = `fps * 48` (1 frame = 48 px);
  - `positionBar` passa de porcentagem para px (`left = start*pps`, `width = duration*pps`);
  - régua e linhas ficam no mesmo contêiner de rolagem `#timelineScroll` (`overflow-x:auto`), e o playhead em px;
  - ao tocar, auto-rolagem mantém o playhead visível.
- **Controles**:
  - **Ctrl+roda** (listener com `passive:false` e `preventDefault`) faz zoom de ×1,15 por passo ancorado no ponteiro (o instante sob o cursor fica parado);
  - botões `#zoomOut` "−", `#zoomIn` "+", `#zoomFit` "Ajustar", e `#zoomLevel` mostrando "N px/s" ou, perto do máximo, "1 frame = N px";
  - teclas `=`/`+` e `-`, com `isTyping` falso.
- **Régua**: `chooseStep(pps, fps)` (em `timeline-math.js`) devolve `{major, minor}` em segundos, sempre múltiplos de `1/fps` quando `pps/fps ≥ 8`. Nesse nível o rótulo é `ss:ff` (segundo:frame).
- **Waveform**:
  - endpoint `GET /api/waveform/<clipId>` → `200 {digest, peaksPerSecond:100, duration, peaks:number[]}`, com picos de 0 a 255 (máximo do valor absoluto por janela de 10 ms, mono) **do arquivo-fonte inteiro**;
  - o cliente recorta a janela do clip: de `offset` a `offset + duration*rate`, índice `floor(t*100)`.
  - Servidor em módulo novo `packages/cli/src/studio-waveform.ts`:
    - `peaksFromPcm(buf: Buffer /* s16le mono */, samplesPerPeak: number): number[]` (puro);
    - `waveformFor(ffmpeg, file): Promise<Waveform>`: `fileDigest` (engine) → cache em `assetPath("cache","waveform", "<digest>.v1.json")`; se faltar, `spawn(ffmpeg, ["-v","error","-i",file,"-map","0:a:0","-ac","1","-ar","8000","-f","s16le","-"])` lendo o stdout em stream (sem `execFile` com buffer), com `samplesPerPeak = 80`;
    - deduplica em voo com `Map<digest, Promise>` e limita a 2 FFmpeg simultâneos.
  - Erros:
    - 404 `E_CLIP_NOT_FOUND`;
    - 400 `E_WAVEFORM_UNSUPPORTED`: clip sem `mediaSrc`, `hasAudio:false`, ou caminho com segmento `.` ou fora do diretório da entrada. Hint: "só áudio/vídeo com som";
    - 422 `E_WAVEFORM_NO_AUDIO`: stderr com "matches no streams";
    - 500 `E_WAVEFORM_FAILED` com as últimas linhas do stderr no `message` e hint "confira o arquivo com ffprobe".
  - É GET e não entra em `serial()`.
  - Cliente:
    - `state.waveforms: Map<mediaSrc, Promise<Waveform>>`, buscado uma vez por fonte;
    - um `<canvas>` por clip com som, dimensionado só para a parte **visível** da barra (largura ≤ viewport), reposicionado e redesenhado em rAF a cada scroll ou zoom;
    - por coluna de pixel, desenha o máximo dos picos da coluna;
    - erro aparece como faixa hachurada com `title` = código, nunca vazio silencioso.

##### Spec
§9d, novo item: "**Zoom** da timeline com Ctrl+roda, botões ou `=`/`-`, de 'ajustar' até 1 frame = 48 px;
nesse nível a régua marca frames (`ss:ff`). **Waveform** de clips com som (`GET /api/waveform/<id>`): picos
de 10 ms do arquivo-fonte, mono, calculados pelo FFmpeg de `vendor/ffmpeg` e guardados em
`cache/waveform/<sha256 do arquivo>.v1.json`, então o mesmo arquivo nunca é analisado duas vezes. Sem faixa de áudio:
`E_WAVEFORM_NO_AUDIO`; falha do FFmpeg: `E_WAVEFORM_FAILED`."

##### Passos
1. `timeline-math.js`: `chooseStep(pps,fps)`, `clampZoom(pps,{fitPps,fps})`, `zoomAround(pps, factor, anchorTime, scrollLeft, pointerX)`, que devolve o novo `scrollLeft`, e `peakSlice(waveform, offset, duration, rate)`.
2. `studio-waveform.ts` (novo) com `peaksFromPcm` e `waveformFor`.
3. `studio-server.ts`:
   - rota GET `^/api/waveform/([^/]+)$`;
   - o handler lê o arquivo, faz `loadComposition`, acha o clip, valida o caminho com a mesma regra de dot-segment de `/__ff_site/` e `resolve(entryDir, mediaSrc)`, e usa o `ffmpeg` do `resolveFfmpeg` em cache (já existe `ffprobePath`; guardar o par inteiro).
4. `index.html`: contêiner `#timelineScroll` em volta da régua e das linhas, mais os botões de zoom.
5. `app.js`:
   - `state.pxPerSecond`;
   - `positionBar`, `renderRuler` (usa `chooseStep`), drag (delta em px ÷ pps) e playhead em px;
   - Ctrl+roda, teclas, auto-rolagem;
   - canvas de waveform.
   - `style.css` correspondente.
6. `docs/contract.md` §9d.

##### Testes
- `packages/cli/test/timeline-math.test.ts`:
  - `chooseStep(30*48, 30)` dá passos múltiplos de 1/30;
  - `chooseStep(10, 30)` dá `major ≥ 1`;
  - `zoomAround` mantém `anchorTime*pps - scrollLeft` constante;
  - `peakSlice` com offset 1, duration 2, rate 1.5 recorta os índices 100…400.
- `packages/cli/test/studio-waveform.test.ts` (novo):
  - (rápido) `peaksFromPcm` com 80 amostras zero e 80 amostras ±32767 dá `[0,255]`; com buffer de tamanho ímpar, a amostra incompleta é ignorada;
  - (FFmpeg, skip) WAV de 1 s, primeira metade silêncio e segunda quadrada cheia: `waveformFor` dá `peaks.length === 100`, `peaks[10] === 0`, `peaks[90] > 200`, e cria o arquivo de cache;
  - (FFmpeg, skip) a 2ª chamada não chama o FFmpeg: injetar `spawn` contável no `waveformFor` por parâmetro opcional `{spawnImpl}`;
  - (FFmpeg, skip) PNG passado como mídia dá `E_WAVEFORM_NO_AUDIO` ou `E_WAVEFORM_FAILED`, nunca peaks vazios.
- `packages/cli/test/studio-tools.test.ts` (FFmpeg, skip):
  - importar o WAV e `GET /api/waveform/<id>` → 200 com `peaksPerSecond:100`;
  - waveform de um `<div>` → 400 `E_WAVEFORM_UNSUPPORTED`.

##### Verificação manual
- Ctrl+roda até o máximo: a régua mostra frames, e arrastar um clip move de frame em frame. "Ajustar" volta a mostrar tudo.
- Clip de áudio e de vídeo com som mostram a waveform alinhada ao som: o fade-in aparece como rampa só se estiver na fonte, porque a waveform é da fonte.
- Aparar (EDT-42) desloca a waveform junto.
- Rolar com zoom alto não engasga.

##### Arquivos tocados
`packages/cli/src/studio/timeline-math.js`, `packages/cli/src/studio-waveform.ts` (novo), `packages/cli/src/studio-server.ts`, `packages/cli/src/studio/app.js`, `packages/cli/src/studio/index.html`, `packages/cli/src/studio/style.css`, `packages/cli/test/timeline-math.test.ts`, `packages/cli/test/studio-waveform.test.ts` (novo), `packages/cli/test/studio-tools.test.ts`, `docs/contract.md`.
**Dependências**: Fase 0; depois de EDT-43, porque reescreve `positionBar` e o drag que 41–43 tocam.

##### Riscos
- Canvas tem limite de ~32k px de largura: por isso o canvas cobre só a parte visível. Não "simplificar" para um canvas por clip inteiro.
- Arquivo de 2 h dá ~720k picos (~2,5 MB de JSON). Aceitável; se medir mais que 1 s de parse, reportar.
- `fileDigest` lê o arquivo inteiro a cada pedido sem cache. Guardar em memória `Map<path, {size, mtimeMs, digest}>` no módulo.

---

#### EDT-44 — Faixas, ímã e ordem de camada

**Achado**: `data-track` **já existe** no contrato (§4: inteiro, padrão 0, `W_TRACK_INVALID` se não
inteiro; torna clip um elemento com `data-track` + `data-duration`), mas a spec diz "**só UI**. O render
ignora". O critério "ordem de camada visual segue a faixa" exige mudar essa linha. Nenhum bloco do
catálogo nem exemplo usa `data-track` (grep: só `packages/contract/test/contract.test.ts`), então a
mudança não altera golden.

##### Desenho
- **Contrato**: `data-track` explícito num clip passa a definir a camada. O compilador acrescenta
  `z-index:<track>` ao `style` inline do clip quando o autor não declarou `z-index` ali. Nada além disso:
  não injeta `position`, porque mudar `position` alteraria o bloco de contenção dos filhos absolutos.
  Clip sem `data-track` não ganha nada (ordem do DOM). Wrapper que não é clip não ganha nada. Faixa
  mais alta fica por cima. Áudio: `data-track` continua só organização. Tempo não muda.
- **Onde**: `packages/producer/src/compile.ts`, `annotateTiming` (l.224), no mesmo laço que grava
  `data-ff-start` (l.236). Se `attr(node,"data-track")` existe e é inteiro e o `style` não casa
  `/(^|;)\s*z-index\s*:/i`, acrescentar `z-index:N` (com `;` se preciso). Vale para render e preview
  (os dois usam o HTML compilado).
- **Studio — faixas**:
  - linhas = pares distintos `(kind, track)`;
  - bloco visual primeiro (`video` e `text`), ordenado por `track` decrescente (o de cima na tela fica por cima no vídeo); empate → `text` acima de `video`;
  - bloco `audio` embaixo, ordenado crescente;
  - rótulo `V2`, `T3`, `A0` na coluna esquerda;
  - clips sobrepostos na mesma linha se empilham em sub-linhas (empacotamento guloso de intervalos, puro, em `timeline-math.js` como `packLanes(clips)`); nada é gravado.
  - Zona "+ nova faixa" acima do bloco visual (`track = maxVisual + 1`) e abaixo do áudio (`track = maxAudio + 1`).
- **Arrastar entre faixas**: no modo `move`, o Y do ponteiro escolhe a linha alvo.
  - Clip visual só solta em linha visual ou na zona nova visual; áudio, só em linha de áudio. Destino inválido mostra cursor `not-allowed` e não muda a faixa.
  - Soltar grava `{ "data-track": String(n), "data-start": … }` pelo `queuePatch` existente, num patch só, então entra num passo de desfazer.
- **Ímã**: `snap(t, candidates, thresholdSec)` em `timeline-math.js` devolve `{ t, guide: number | null }`.
  - Candidatos: playhead, 0, `total`, início e fim de todos os outros clips;
  - limiar = `8 / pxPerSecond`;
  - vale para mover (as duas bordas: escolher a de menor distância), redimensionar à direita e aparar à esquerda (EDT-42);
  - **Alt** segurado desliga;
  - sem ímã, arredonda ao frame (`roundToFrame`), substituindo o `SNAP = 0.05` de hoje;
  - linha-guia vertical `.snap-guide` aparece enquanto ancorado.
- **Camada sem efeito**: depois de carregar o preview, o Studio lê no iframe (mesma origem)
  `getComputedStyle(el).position` dos clips com `data-track` (seletor `[data-clip-id="…"]`). Se for
  `static` (e o pai não for flex/grid), mostra ⚠ na barra com `title` "camada sem efeito: elemento não
  posicionado". Os templates `title`/`subtitle` de `insertClip` passam a nascer com
  `style="position:absolute;left:0;right:0;top:45%;text-align:center"` e `data-track = maxVisual + 1`.

##### Spec
- §4, trocar a linha de `data-track` por: "`data-track` | inteiro. Num clip **visual**, define a camada: o
  compilador acrescenta `z-index:<n>` ao `style` do clip, salvo se o autor já declarou `z-index` nele.
  Faixa maior fica por cima. Só tem efeito em elemento posicionado (ou item de flex/grid). Não mexe em tempo.
  Em `<audio>` é só organização. Clip sem `data-track` segue a ordem do documento."
- §9d, novo item: "**Faixas**: a timeline agrupa clips por (tipo, `data-track`): vídeo/imagem (`V`), texto
  (`T`) e áudio (`A`). Arrastar para outra faixa grava `data-track`. As bordas grudam no playhead e nas
  bordas vizinhas (8 px; Alt desliga); sem ímã, o tempo é arredondado ao frame."

##### Passos
1. `compile.ts`: z-index em `annotateTiming`.
2. `docs/contract.md` §4 e §9d.
3. `timeline-math.js`: `snap`, `packLanes`, `trackRows(clips)`, que devolve as linhas ordenadas com `kind`, `track`, `label` e os clips por sub-linha.
4. `app.js`:
   - `renderTimeline` passa a usar `trackRows`;
   - `onDragMove` com Y→linha e ímã;
   - `onDragEnd` com o patch combinado;
   - guia de ímã;
   - checagem ⚠ de posição depois de cada `reloadPreview` (no `load` do iframe).
   - `style.css`: rótulos, zonas, sub-linhas, guia.
5. `studio-server.ts` (`insertClip`, l.450): `style` e `data-track` nos templates.

##### Testes
- `packages/producer/test/compile.test.ts` (rápido, em `FAST_TESTS`):
  1. clip `data-track="2"` sem style → HTML compilado tem `style="z-index:2"`;
  2. com `style="color:red"` → `color:red;z-index:2`;
  3. com `style="z-index:9"` → fica 9;
  4. clip sem `data-track` → sem z-index;
  5. wrapper `<div data-track="2">` (não clip) → sem z-index.
  - Falha sem o passo 1.
- `packages/contract/test/contract.test.ts`: o caso existente da l.106 continua verde (semântica de clip não mudou).
- `packages/cli/test/timeline-math.test.ts`:
  - `snap(1.03, [1, 2], 0.05)` dá `{t:1, guide:1}`; `snap(1.2, [1], 0.05)` não gruda;
  - `packLanes` com `[0–2]` e `[1–3]` dá 2 sub-linhas, e com `[0–1]` e `[1–2]` dá 1 (encostar não é sobrepor);
  - `trackRows` com V0, T1, T0, A0 e A1 dá a ordem `T1, T0, V0, A0, A1`.
- `packages/cli/test/studio-tools.test.ts`: `POST /api/clips {template:"title"}` numa composição com um vídeo `data-track="1"` dá um clip novo com `data-track="2"` e `position:absolute`.
- Teste de render opcional (Chrome, skip) em `packages/producer/test/render.test.ts`: dois `div` absolutos sobrepostos de cores diferentes. O primeiro no DOM tem `data-track="2"` e o segundo `data-track="1"`; o pixel central do frame 0 tem a cor do primeiro. Falha sem o passo 1.

##### Verificação manual
- Composição com vídeo e dois títulos: a timeline mostra `T…`/`V…` separados.
- Arrastar um título para a linha acima do vídeo → o preview mostra o título por cima. Para baixo → atrás. Ctrl+Z → volta.
- Arrastar uma borda perto do playhead → gruda, com guia visível. Com Alt, não gruda.
- Áudio não solta em linha visual.

##### Arquivos tocados
`packages/producer/src/compile.ts`, `packages/producer/test/compile.test.ts`, `packages/cli/src/studio/timeline-math.js`, `packages/cli/src/studio/app.js`, `packages/cli/src/studio/style.css`, `packages/cli/src/studio-server.ts`, `packages/cli/test/timeline-math.test.ts`, `packages/cli/test/studio-tools.test.ts`, `docs/contract.md`.
**Dependências**: Fase 0; depois de EDT-45 (px por segundo para o limiar e o reescrito de `renderTimeline`) e de EDT-42 (ímã também na borda esquerda).

##### Riscos
- Mudança de contrato: composição de terceiros com `data-track` em elementos posicionados muda de empilhamento no render. É exatamente o pedido, mas tem que estar no CHANGELOG/relato. Nenhum golden do repo muda (checado).
- `z-index` num elemento com `transform`/`opacity` animados por WAAPI já cria contexto de empilhamento; a ordem continua coerente com o número. Conferir no teste manual.

---

#### EDT-46 — Exportar do Studio (preset, destino, progresso, cancelar, abrir pasta)

##### Desenho
- **Cancelamento no render** (`packages/producer/src/render.ts`):
  - `RenderOptions.signal?: AbortSignal`;
  - checar `signal.aborted` depois de `prepare`, no `onFrame` da captura (lançar aborta os workers, que é o caminho já existente) e antes de áudio, encode e assemble;
  - repassar `{signal}` a todo `run(ffmpeg, …)` desta função e a `mixAudio` (`MixOptions.signal`, repassado aos `execFile` dela);
  - `prepare` também recebe `signal` e checa entre extrações; se `extractFrames` (engine `media.ts`) usar `execFile`/`spawn`, aceitar `signal` opcional e repassar;
  - o erro de cancelamento é `RenderError("E_CANCELED", <estágio atual>, "render cancelado")`; `E_CANCELED` entra em `RENDER_ERROR_CODES` (`producer/src/errors.ts`).
  - **Saída atômica**: o assemble grava em `<dir>/<nome>.partial<ext>` e faz `rename` para `outPath` só no fim; em erro ou cancelamento, apaga o `.partial`. Um arquivo antigo com o mesmo nome nunca é destruído por um export que falhou. O `finally` atual já remove o `workDir`; confirmar que ele roda no caminho do abort.
- **Guarda de licença compartilhada**: extrair de `cli.ts` (comando `render`) o trecho `detectFfmpeg` + `assertFfmpegAllowed` + `assertCodecAllowed({codec, allowH264: process.env.FRANKFRAMES_ALLOW_H264 === "1"})` para `packages/cli/src/render-guard.ts` (`guardEncoder({ffmpeg, codec})`), junto com `defaultOutput(entry, codec)`. O `render` da CLI e o Studio usam o mesmo código.
- **Exportador** — `packages/cli/src/studio-export.ts` (novo): `createExporter({ entry, render = renderComposition, reveal = openFolder, onEvent })`, com dependências injetáveis para testar sem Chrome.
  - `start({preset, codec, output, overwrite})`:
    - valida `preset ∈ draft|standard|high`, `codec ∈ av1|vp9|h264` (padrão `av1`), e `output` relativo à pasta da entrada ou absoluto, com extensão = `containerFor(codec)`. Senão 400 `E_EXPORT_OUTPUT_INVALID`, com hint "use .mp4 para av1/h264, .webm para vp9";
    - `loadComposition` do arquivo atual; inválido → 400 `E_CONTRACT_INVALID` com `diagnostics`, sem criar job;
    - `guardEncoder` falha → 400 com o código que o encode já usa;
    - destino existe e `overwrite !== true` → 409 `E_EXPORT_EXISTS`;
    - job rodando → 409 `E_EXPORT_BUSY`;
    - senão cria job `{id, status:"running", stage, percent, message, output}`, chama `render({…, signal, onProgress})` e emite `onEvent(job)` a cada progresso.
  - `cancel()`: sem job rodando → 409 `E_EXPORT_IDLE`; senão `abort()`, e o job termina com `status:"canceled"`.
  - `reveal()`: só com `status:"done"` (senão 409 `E_EXPORT_NOT_DONE`). Abre a pasta com `spawn` e argumentos em array, sem shell (`exec` de string não, porque o caminho vem do usuário):
    - Windows: `explorer.exe /select,<arquivo>`, que sai com código 1 mesmo quando dá certo, então não tratar como erro;
    - macOS: `open -R <arquivo>`;
    - Linux: `xdg-open <pasta>`;
    - `ENOENT` → 500 `E_REVEAL_FAILED`.
  - Falha do render → `status:"failed"`, `error: toErrorPayload(error)`, que já sanitiza caminhos e traz diagnósticos.
- **Rotas** em `studio-server.ts`, todas fora de `serial()`, porque o export lê o arquivo uma vez no `prepare` e edições depois não o afetam:
  - `GET /api/export` → `{ job | null, defaults: { output: defaultOutput(entry,"av1") relativo, codecs: ["av1","vp9", ("h264" se env)] , presets:[…] } }`;
  - `POST /api/export {preset, codec, output, overwrite?}` → `202 {id, output}`, com `output` absoluto resolvido;
  - `POST /api/export/cancel` → `200 {ok:true}`;
  - `POST /api/export/reveal` → `200 {ok:true}`.
  - Progresso pelo SSE existente: `event: export\ndata: <job JSON>\n\n` (o `EventSource` do app usa `addEventListener("export")`; a mensagem `change` sem nome continua igual).
  - Fechar o Studio com export rodando → `abort()` no `close()` do servidor.
- **UI**:
  - botão `#exportButton` "Exportar" e `<dialog id="exportDialog">` com select de preset (padrão `standard`), select de codec (de `defaults.codecs`), campo de destino (preenchido com `defaults.output`) e "Exportar";
  - o navegador não dá caminho nativo, por isso o destino é campo de texto resolvido no servidor;
  - durante o job: lista dos estágios `compile → probe → extract → capture → audio → encode → assemble` com o atual destacado, barra de `percent`, `message` e "Cancelar";
  - `done` → "Abrir pasta" (`/reveal`) e caminho final;
  - `failed` → código, mensagem e diagnósticos pelo mesmo renderizador de `toolDiagnostics`;
  - 409 `E_EXPORT_EXISTS` → `confirm("Substituir <arquivo>?")` e reenvio com `overwrite:true`;
  - o botão fica desabilitado enquanto `mutationQueue` tem edição pendente ou `inspectorDirty`, com tooltip "aplique as alterações antes".

##### Spec
- §9d, novo item: "**Exportar** (`POST /api/export {preset, codec, output, overwrite}`; botão Exportar).
  Renderiza o arquivo salvo com o mesmo pipeline e as mesmas guardas de licença do `frankframes render`.
  Contrato inválido bloqueia com `E_CONTRACT_INVALID` e diagnósticos. O progresso por estágio chega por
  `/api/events` (`event: export`). **Cancelar** (`POST /api/export/cancel`) interrompe FFmpeg e captura, apaga
  os temporários e a saída parcial. A saída é gravada como `.partial` e só ganha o nome final quando termina,
  então um arquivo existente nunca é corrompido. Substituir pede `overwrite`
  (`E_EXPORT_EXISTS`). Um export por vez (`E_EXPORT_BUSY`). **Abrir pasta** (`POST /api/export/reveal`)
  mostra o arquivo no gerenciador do sistema."
- Na seção do `render` (contract.md ou `docs/encode.md`, onde estiver descrita a saída), acrescentar a regra do `.partial` e o código `E_CANCELED`.

##### Passos
1. `producer/src/errors.ts`: `E_CANCELED`.
   - `render.ts`: `signal`, checagens, saída `.partial`;
   - `audio.ts`: `MixOptions.signal`;
   - repassar ao `prepare`/extração.
   - Conferir `packages/cli/test/errors.test.ts` (lista de códigos).
2. `cli/src/render-guard.ts` (novo): `guardEncoder`, `defaultOutput`. `cli.ts` passa a importar daqui, com o mesmo comportamento.
3. `cli/src/studio-export.ts` (novo) conforme o Desenho.
4. `studio-server.ts`: instanciar o exportador, adicionar as rotas, emitir `event: export` para os clientes SSE e abortar no `close()`.
5. `index.html`: botão e `<dialog>`. `app.js`: abrir o diálogo, carregar `GET /api/export`, enviar, ouvir `export` no `EventSource`, cancelar e abrir a pasta. `style.css`.
6. `docs/contract.md` (e `docs/encode.md` se a saída estiver lá).

##### Testes
- `packages/cli/test/studio-export.test.ts` (novo, rápido, `render` e `reveal` falsos):
  1. com o render falso preso até o `signal` abortar: 2º `start` → `E_EXPORT_BUSY`;
  2. `cancel` → o job termina `canceled`, e o render falso recebeu `signal.aborted === true`;
  3. `cancel` sem job → `E_EXPORT_IDLE`;
  4. `output` `.webm` com `av1` → `E_EXPORT_OUTPUT_INVALID`;
  5. contrato inválido → `E_CONTRACT_INVALID` com diagnósticos e o render falso **não** chamado;
  6. `codec:"h264"` sem env → erro da guarda;
  7. render falso emitindo `onProgress("capture",50)` → `onEvent` recebe `stage:"capture", percent:50`;
  8. `reveal` antes de `done` → `E_EXPORT_NOT_DONE`; depois de `done` → o `reveal` falso é chamado com o caminho absoluto;
  9. destino existente sem `overwrite` → `E_EXPORT_EXISTS`.
- `packages/producer/test/render.test.ts` (Chrome + FFmpeg, skip):
  - `renderComposition` de `examples/hello.html` com `AbortController` abortado no primeiro `onProgress("capture")` → rejeita com `code:"E_CANCELED"`;
  - o número de diretórios `ff-render-*` em `tmpdir()` volta ao de antes;
  - nem `outPath` nem `*.partial.*` existem;
  - um `outPath` preexistente (arquivo com bytes "x") fica intacto.
- `packages/cli/test/studio-tools.test.ts`:
  - `GET /api/export` → `defaults.output` termina em `.mp4`;
  - `POST /api/export` com contrato inválido (arquivo editado à mão) → 400 `E_CONTRACT_INVALID`.
- `packages/cli/test/errors.test.ts`: ajustar a lista se ela fixa os códigos.

##### Verificação manual
- Exportar `examples/hello.html` em `draft`: os estágios avançam e "Abrir pasta" abre o Explorer com o arquivo selecionado.
- Exportar de novo para o mesmo destino: pede confirmação.
- Exportar e cancelar no meio da captura: a pasta `out/` não ganha arquivo nem `.partial`, e `%TEMP%\ff-render-*` some.
- Quebrar o contrato à mão (data-start inválido) e exportar: o diálogo lista os diagnósticos e não começa.

##### Arquivos tocados
`packages/producer/src/render.ts`, `packages/producer/src/audio.ts`, `packages/producer/src/errors.ts`, (talvez `packages/engine/src/media.ts`), `packages/cli/src/render-guard.ts` (novo), `packages/cli/src/cli.ts`, `packages/cli/src/studio-export.ts` (novo), `packages/cli/src/studio-server.ts`, `packages/cli/src/studio/app.js`, `packages/cli/src/studio/index.html`, `packages/cli/src/studio/style.css`, `packages/cli/test/studio-export.test.ts` (novo), `packages/producer/test/render.test.ts`, `packages/cli/test/studio-tools.test.ts`, `packages/cli/test/errors.test.ts`, `docs/contract.md`.
**Dependências**: EDT-40 (mexe em `mixAudio` e na lista de áudio de `render.ts`; fazer depois para não conflitar).

##### Riscos
- **Abortar a captura**: se lançar no `onFrame` deixar processos do Chrome órfãos, conferir em `captureFramesInParallel` que os workers fecham a sessão no `finally`. Se não fecharem, corrigir lá e citar no relato.
- O `rename` de `.partial` para o destino falha no Windows se o arquivo de destino estiver aberto num player (EBUSY). Isso deve aparecer como `failed` com mensagem clara, nunca sumir.
- O `explorer.exe` sai com código 1 em sucesso; ver Desenho.

---

### Ordem e paralelismo

**Ordem recomendada** (serial, um item por vez no Studio):

1. **Fase 0 + EDT-39** — base comum e relógio; tudo depende disso.
2. **EDT-41 → EDT-42 → EDT-43** — os três editam `edit.ts`, o roteamento de `/api/clips/` em `studio-server.ts` e o drag e os atalhos em `app.js`. **Não paralelizar.**
3. **EDT-45** — troca a timeline de % para px e reescreve `positionBar`, a régua e o drag.
4. **EDT-44** — reescreve `renderTimeline` (linhas por faixa) e o drag (Y + ímã) sobre o sistema em px. Também mexe em `compile.ts`.
5. **Integração no Studio do EDT-40 e do EDT-46** (rotas em `studio-server.ts`, `index.html`, `app.js`), uma de cada vez, em qualquer ponto depois do passo 2. Sugiro entre EDT-43 e EDT-45, porque os trechos tocados são outros (`loadPreview`/iframe e diálogo novo) e o conflito no `app.js` fica pequeno.

**O que roda em paralelo de verdade** (sem tocar os mesmos arquivos), depois que a Fase 0 + EDT-39 estiverem no main:
- **Trilha A — timeline do Studio**: 41 → 42 → 43 → 45 → 44. Dona de `app.js`, `index.html`, `style.css`, `timeline-math.js`, `edit.ts`, `compile.ts` e do roteamento de `/api/clips/` e `/api/waveform/` no `studio-server.ts`.
- **Trilha B — back-end de áudio e export**: 40 (producer `audio.ts`, `preview-audio.ts`, `render.ts`, `index.ts`; engine `preview-audio.ts`, `inject.ts`, `preview-ui.ts`, `server.ts`; `cli.ts` preview), depois 46 (producer `render.ts`, `audio.ts`, `errors.ts`; `render-guard.ts`, `studio-export.ts`, `cli.ts` render). A trilha B **não** toca `app.js`, `index.html` nem `studio-server.ts` na fase paralela: a integração no Studio de cada um fica parada até a trilha A liberar esses arquivos (passo 5).
- 40 e 46 **não** rodam em paralelo entre si: os dois mexem em `mixAudio` e no meio de `renderComposition`.
- `inject.ts`, `preview-ui.ts` e `clock.ts` são do EDT-39 e depois só do 40, por isso o 40 começa só depois do 39 no main.

**Conflitos assumidos (honestos)**:
- `app.js` e `studio-server.ts` são tocados por 39, 40 (integração), 41, 42, 43, 44, 45 e 46 (integração). Não existe paralelismo seguro neles; a Fase 0 só reduz a área (helpers, payload e lógica pura fora do IIFE).
- `docs/contract.md` §9d recebe um item por ticket. São blocos novos e independentes, mas no mesmo trecho: em paralelo, o merge é manual e trivial. O planejador junta.
- `timeline-math.js` e `timeline-math.test.ts` crescem em 39, 44 e 45, todos na trilha A, então serial.
- `cli.ts`: 40 (preview) e 46 (render) mexem em comandos diferentes, ambos na trilha B, então serial.
- `render.ts` e `audio.ts`: 40 e depois 46, na mesma trilha.

**Gate**: o executor entrega cada item com `node scripts/ci.ts --fast` verde e a saída dos testes de Chrome/FFmpeg do item. O planejador revisa o diff, roda `node scripts/ci.ts` completo, faz o commit (Fase 0 + 39 juntos; os demais, um por ticket) e atualiza o Jira.

---

## Plano — épico Motion (EDT-48: EDT-49..56) + EDT-47

Planejador: Opus 5.5. Executor: Sonnet 5.5. Repositório: `C:\Users\rober\Sync\FrankFrames\frankframes`.

### Regras para o executor (valem em todos os itens)

- Leia `.omp/RULES.md`, `.omp/AGENTS.md`, `PROVENANCE.md` e `docs/contract.md` antes do primeiro item.
- Um item por vez, na ordem do fim deste arquivo. Não faça commit, push nem mexa no Jira.
- Spec antes do código: o texto de `docs/contract.md` de cada item entra no mesmo diff do código.
- Todo código `E_*`/`W_*` novo entra em `packages/contract/src/errors.ts` (`CODES`) e é seguido de
  `node scripts/generate-reference.ts` (senão `reference.test.ts` falha).
- Testes com `node:test`. Teste que precisa de Chrome faz `t.skip("Chrome não encontrado")` quando
  `resolveChrome()` lança (padrão de `packages/engine/test/determinism.test.ts`); teste que precisa de
  FFmpeg faz o mesmo com o resolvedor do FFmpeg usado em `packages/catalog/test/goldens.test.ts`.
- Clean-room: nenhum nome, curva, preset, texto ou código de outro framework de vídeo/animação. Sem GSAP.
  Todos os nomes e números deste plano são próprios; não os "corrija" para valores conhecidos de terceiros.
- Fim de cada item: `node scripts/ci.ts --fast` verde e os testes novos do item verdes (inclusive os de
  Chrome). Responda com o resumo do diff.
- Se algo deste plano contradisser o código (função que não existe, semântica diferente), pare e devolva
  a pergunta ao planejamento. Pontos marcados **[PARAR SE]** são esses casos previstos.

---

### Contrato de motion

Este bloco vai, revisado, para `docs/contract.md` como nova seção **§7b. Motion** (entre §7 Duração e
§8 Diagnósticos). Os itens o introduzem por partes: EDT-49 escreve §7b.1–§7b.6, §7b.11 e §7b.12; EDT-50 escreve
§7b.7; EDT-52 escreve §7b.8; EDT-53 escreve §7b.9; EDT-54 escreve §7b.10. Os presets são listados em `docs/motion.md`
(EDT-51); o contrato só remete para lá.

#### §7b.1 Princípio

Movimento é declarado em atributos `data-` com tempo **relativo ao clip**. O compilador (producer)
converte para animações WAAPI com tempo do escopo (o mesmo de `data-ff-comp-start`). O runtime só
reproduz. CSS `@keyframes` continua permitido; os atributos de motion são a forma recomendada.

#### §7b.2 Alvos

- **Clip**: o próprio elemento temporizado (§4).
- **Descendente**: qualquer elemento não temporizado dentro de um clip; o tempo dele é relativo ao
  clip temporizado mais próximo acima.
- Erros:
  - motion na raiz, fora de qualquer clip ou em `<audio>` → `E_MOTION_TARGET`;
  - `data-camera` fora de `<img>`/`<video>` → `E_MOTION_TARGET`;
  - `data-transition` fora de um clip → `E_MOTION_TARGET`.

#### §7b.3 Atributos

| Atributo | Onde | Valor |
|---|---|---|
| `data-enter` | clip ou descendente | `<preset> [chave=valor ...]` |
| `data-exit` | clip ou descendente | `<preset> [chave=valor ...]` |
| `data-emphasis` | clip ou descendente | `<preset> [chave=valor ...]` |
| `data-camera` | `<img>`/`<video>` (clip ou descendente) | `<preset> [chave=valor ...]` |
| `data-transition` | clip que **entra** | `<preset> [chave=valor ...]` (§7b.10) |
| `data-split` | clip ou descendente com texto | `word\|letter [stagger=<s>] [order=<ordem>]` (§7b.8) |
| `data-unit` | descendente de um `data-split` | vazio ou `<segundos>` (§7b.8) |
| `data-keyframes` | clip ou descendente | JSON (§7b.7); estende o formato de volume |

#### §7b.4 Gramática (EBNF)

```
valor      = preset { ws+ param } ;            (* espaços nas pontas são ignorados *)
preset     = minúscula { minúscula | dígito | "-" } ;
param      = chave "=" texto ;                 (* texto: sem espaço nem "=" *)
chave      = minúscula { minúscula } ;
segundos   = dígito+ [ "." dígito+ ] ;
âncora     = segundos | "-" segundos | segundos "%" | "end" | "end-" segundos ;
curva      = "linear" | "ease" | "ease-in" | "ease-out" | "ease-in-out"
           | "suave" | "freio" | "arranque" | "vaivem" | "mola" | "mola-firme"
           | "cubic-bezier(" num "," num "," num "," num ")"     (* sem espaços *)
           | "spring(" num "," num ")" ;                          (* ζ, ω *)
num        = [ "-" ] dígito+ [ "." dígito+ ] ;
distância  = num [ "px" | "%" ] ;              (* sem unidade = px *)
```

Chaves comuns (`dur`, `at`, `curve`) e chaves por preset (lista exata em `docs/motion.md`):

| Chave | Tipo | Regra |
|---|---|---|
| `dur` | segundos > 0 | duração do movimento (por ciclo, na ênfase) |
| `at` | âncora | §7b.5 |
| `curve` | curva | substitui a curva padrão do preset em todas as propriedades |
| `distance` | distância | deslocamento de entrada/saída |
| `amount` | num | intensidade; unidade depende do preset (fator, graus, px) |
| `dir` | `left\|right\|up\|down` | direção |
| `repeat` | inteiro 1..20 | ciclos de ênfase |
| `fx`, `fy` | num em [0,1] | foco horizontal/vertical (câmera, íris) |

Erros de gramática:
- `E_MOTION_SYNTAX`: valor vazio, token sem `=`, chave repetida ou caractere inválido. Hint:
  `use data-enter="subir dur=0.6 at=0.2"`.
- `E_MOTION_PRESET_UNKNOWN`: o hint lista os presets válidos daquele atributo.
- `E_MOTION_PARAM`: a chave não existe no preset (o hint lista as chaves aceitas) ou o valor está fora do
  tipo ou da faixa (o hint mostra a faixa).
- `E_CURVE_INVALID`: o hint traz `use cubic-bezier(0.3,0,0.2,1) ou um nome: linear, suave, freio, arranque, vaivem, mola`.
  Também vale para `cubic-bezier` com x1 ou x2 fora de [0,1] ou y fora de [-5,5], e para `spring` com ζ fora
  de [0.05,1] ou ω fora de [1,100].

#### §7b.5 Tempo

`D` é a duração do clip (`end − start`, no escopo do clip). A âncora `T` resolve assim:
- `n` → n;
- `-n` → −n (só em `data-enter`);
- `p%` → p/100·D;
- `end` → D;
- `end-n` → D − n.

Intervalo de cada atributo:

| Atributo | `at` padrão | Intervalo do movimento |
|---|---|---|
| enter | `0` | [T, T+dur] |
| exit | `end` | [T−dur, T]: a âncora marca o **fim** |
| emphasis | fim da entrada (`0` se não houver entrada) | [T, T+dur·repeat] |
| camera | `0` | [T, T+dur]; `dur` padrão = D − T |

Regras de faixa:
- Todo intervalo precisa terminar em ≤ D.
- Nenhum intervalo pode começar antes de 0; a exceção é a entrada, que pode começar antes (o trecho
  anterior a 0 não aparece, porque o clip ainda está invisível).
- Fora da faixa → `E_MOTION_OUT_OF_RANGE`; o hint mostra o intervalo calculado e D.

Âncoras `%`, `end` e câmera sem `dur` exigem D conhecida:
- Se a duração da composição ainda é `unresolved`, a validação espera o probe (o diagnóstico de duração já
  bloqueia o render).
- Se a composição resolveu mas este clip não tem fim → `E_MOTION_OUT_OF_RANGE` com hint
  `defina data-duration no clip`.

#### §7b.6 Propriedades, valores neutros e posse

| Propriedade | CSS animado | Neutro | Faixa |
|---|---|---|---|
| `opacity` | `opacity` | 1 | [0,1] |
| `x`, `y` | `--ff-x`, `--ff-y` → `translate` | 0 | px ou % da própria caixa |
| `scaleX`, `scaleY` | `--ff-sx`, `--ff-sy` → `scale` | 1 | [0,20] |
| `rotate` | `--ff-rot` → `rotate` | 0 | graus, [-3600,3600] |
| `blur` | `--ff-blur` → `filter: blur()` | 0 | px, [0,200] |
| `clip` | `clip-path` | `inset(0% 0% 0% 0%)` | `inset(t% r% b% l%)` ou `circle(r% at x% y%)` |
| `zoom` | `--ff-zoom` → `object-view-box` | 1 | [1,10], só img/video |
| `focusX`, `focusY` | `--ff-fx`, `--ff-fy` → `object-view-box` | 0.5 | [0,1], só img/video |

- `scale` é atalho para `scaleX` e `scaleY` iguais.
- O alvo com motion passa a ser **dono** das propriedades CSS que o movimento usa (`opacity`, `translate`,
  `scale`, `rotate`, `filter`, `clip-path`, `object-view-box`).
- O `transform` do autor continua valendo e compõe depois: `translate`, `rotate`, `scale` e então
  `transform`. `transform-origin` vale para escala e rotação.
- Conflitos:
  - declarar no `style` inline uma propriedade possuída → `E_MOTION_CONFLICT` (estático);
  - animação CSS do autor que anima uma propriedade possuída no mesmo elemento → `E_MOTION_CONFLICT` no
    runtime, e o render falha com `E_MOTION_RUNTIME`.
- Num mesmo alvo, dois movimentos da mesma propriedade não podem se sobrepor no tempo → `E_MOTION_OVERLAP`
  (encostar nas pontas é permitido).
- Entre movimentos, o valor fica parado; antes do primeiro, vale o valor inicial dele; depois do último, o
  valor final.
- Se um movimento começa num valor diferente do que estava parado → `W_MOTION_JUMP` (o salto é aplicado).

#### §7b.11 Curvas

- `linear`, `ease`, `ease-in`, `ease-out`, `ease-in-out`: as do CSS.
- Curvas próprias:

  | Nome | Definição |
  |---|---|
  | `suave` | `cubic-bezier(0.34,0.1,0.18,1)` |
  | `freio` | `cubic-bezier(0.18,0.72,0.28,1)` |
  | `arranque` | `cubic-bezier(0.56,0,0.84,0.42)` |
  | `vaivem` | `cubic-bezier(0.58,0.04,0.3,0.97)` |
  | `mola` | `spring(0.45,18)` |
  | `mola-firme` | `spring(0.7,14)` |

- `spring(ζ,ω)` é função fechada do tempo do trecho, τ ∈ [0, dur] em segundos:
  - ζ < 1: `x(τ) = 1 − e^(−ζωτ)·(cos(ω_d τ) + (ζω/ω_d)·sin(ω_d τ))`, com `ω_d = ω·√(1−ζ²)`;
  - ζ = 1: `x(τ) = 1 − e^(−ωτ)·(1 + ωτ)`.
- A mola precisa assentar dentro do trecho:
  - envelope `e^(−ζω·dur)/√(1−ζ²)` ≤ 0.01 (com ζ = 1: `e^(−ω·dur)(1+ω·dur)` ≤ 0.01);
  - senão `E_CURVE_INVALID`, com hint `mola precisa de dur ≥ <mín> s` (mín arredondado para cima em 0.01).
- Emissão:
  - 64 amostras em p = i/63, com τ = p·dur; i = 0 vale 0 e i = 63 é forçado a 1;
  - 4 casas decimais (`Number(v.toFixed(4))`);
  - sai como easing `linear(v0, v1, ..., v63)`.
- Nada é simulado passo a passo.

#### §7b.12 Compilação e runtime

- O compilador grava em cada alvo `data-ff-motion` com JSON:
  - formato: `{"v":1,"a":[{"p":<propriedade CSS>,"d":<atraso ms>,"n":<duração ms>,"k":[[offset,valor,easing|null],...]}],"s":[[<propriedade CSS>,<valor do binding>],...]}`;
  - `d` usa o tempo do escopo: `start` do clip no escopo, mais o tempo local, em ms com 3 casas;
  - `n` ≥ 1;
  - uma entrada em `a` por propriedade CSS;
  - `s` traz as declarações de ligação, por exemplo `["translate","var(--ff-x) var(--ff-y)"]`.
- O runtime (engine):
  - registra as propriedades `--ff-*` (`inherits:false`);
  - aplica `s` no `style` do alvo;
  - cria `el.animate(k, {delay:d, duration:n, fill:"both", easing:"linear", id:"ff-motion"})`;
  - deixa o relógio sincronizar como qualquer animação (`currentTime = agora − data-ff-comp-start`).
- Seek em qualquer ordem dá o mesmo frame.
- `<video>` com motion: as animações vão para a `<img>` que substitui o vídeo (§6); o vídeo continua
  decodificado pelo FFmpeg.

---

### EDT-49: Contrato de motion (atributos, compilador, runtime)

#### Desenho

- **Onde roda**:
  - parse, validação e montagem de trilhas ficam no **contract**, módulo puro `packages/contract/src/motion/`,
    para que `lint`, Studio e render vejam os mesmos erros;
  - a conversão para `data-ff-motion` fica no **producer** (`packages/producer/src/motion.ts`);
  - a reprodução fica no **engine** (`packages/engine/src/motion-runtime.ts`).
  - Preview e Studio herdam o mesmo resultado porque passam por `prepare()` e `injectEngine`.
- Arquivos do módulo `packages/contract/src/motion/`:
  - `grammar.ts`: tokeniza e valida `<preset> k=v`, âncoras e distâncias;
  - `curves.ts`: parse de curva, avaliação (`evaluateCurve(curve, p)`; cubic-bezier por bissecção com 40
    iterações, determinística) e emissão de easing (`emitEasing(curve, durSeconds)`);
  - `presets.ts`: tabela `PRESETS`. EDT-49 entrega só `surgir` (entrada), `apagar` (saída) e `pulsar`
    (ênfase); EDT-51 completa;
  - `targets.ts`: `motionElements(clipNode)`, o gerador compartilhado com o producer;
  - `tracks.ts`: `resolveMotion(clips, diagnostics)` monta trilhas por alvo no tempo local;
  - `index.ts`: reexporta.
- Este item entrega as curvas sem `spring`. `mola`, `mola-firme` e `spring()` entram no EDT-50; até lá dão
  `E_CURVE_INVALID` com hint `disponível no EDT-50`. Não deixe esse hint no fim do EDT-50.
- `motionElements(clipNode)` produz o próprio nó do clip (ordinal 0, sempre), depois os descendentes em ordem
  de documento que tenham algum atributo de motion. Não entra em `<template>` nem em elementos
  temporizados ou hosts. Para isso, extraia de `collectClips` em `parse.ts` o predicado
  `isTimedOrHost(node, root)` e exporte-o.
- Tipos novos em `types.ts`:
  ```ts
  export type MotionKind = "enter" | "exit" | "emphasis" | "camera" | "transition";
  export interface MotionSpec { kind: MotionKind; preset: string; params: Record<string, string>; raw: string }
  export type MotionProp = "opacity"|"x"|"y"|"scaleX"|"scaleY"|"rotate"|"blur"|"clip"|"zoom"|"focusX"|"focusY";
  export type MotionValue = number | string;          // x/y: número = px, "N%"; clip: texto
  export interface MotionFrame { time: number; value: MotionValue; easing: string } // time local (s)
  export interface MotionTrack { prop: MotionProp; frames: MotionFrame[] }          // frames em ordem
  export interface RawMotionTarget {
    ordinal: number; tag: string;
    specs: MotionSpec[];             // enter/exit/emphasis/camera/transition presentes
    inlineStyleProps: string[];      // propriedades declaradas no style inline (para E_MOTION_CONFLICT)
  }
  export interface ResolvedMotionTarget { ordinal: number; tracks: MotionTrack[] }
  ```
  - `RawClip.motion?: RawMotionTarget[]`: ausente quando o clip não tem nenhum motion.
  - `ResolvedClip.motion?: ResolvedMotionTarget[]`.
  - EDT-50 e EDT-52 acrescentam campos (keyframes e unidades).
- Convenção de trilha:
  - `easing` é a curva do trecho que **começa** naquele frame (convenção WAAPI);
  - o último frame tem `"linear"`;
  - dois frames com o mesmo `time` representam salto.
- Um preset é uma função pura:
  `(params, clipDur) => Array<{ prop, frames: Array<{ at: 0..1, value }>, curve }>`, em progresso
  relativo do trecho.
  - `tracks.ts` converte para tempo local com o intervalo de §7b.5.
  - A curva vai em cada trecho entre frames consecutivos do preset.
  - Na ênfase com `repeat=n`, o ciclo se repete n vezes dentro de [T, T+dur·n].
- Presets do EDT-49 (definitivos; o EDT-51 não muda):

  | Preset | Movimento | dur | curva |
  |---|---|---|---|
  | `surgir` | opacity 0→1 | 0.5 | `suave` |
  | `apagar` | opacity 1→0 | 0.5 | `suave` |
  | `pulsar` | scale 1→`amount`(1.08)→1 | 0.6 | `suave` |

  Chaves de `pulsar`: `amount` ∈ [0.5,3] e `repeat`.
- Códigos novos em `CODES`:
  - `E_MOTION_SYNTAX`, `E_MOTION_PRESET_UNKNOWN`, `E_MOTION_PARAM`, `E_CURVE_INVALID`,
    `E_MOTION_OUT_OF_RANGE`, `E_MOTION_OVERLAP`, `E_MOTION_TARGET` e `E_MOTION_CONFLICT`, todos `error`;
  - `W_MOTION_JUMP`, `warning`.
  - Todo diagnóstico leva `clipId` e um hint concreto.
- Em `packages/producer/src/errors.ts`, `RENDER_ERROR_CODES` ganha `"E_MOTION_RUNTIME"` (stage `capture`).
- Mapeamento: no Node, a rejeição de `__ff.ready` com mensagem que começa por `E_MOTION_` vira
  `Error` com `code = "E_MOTION_RUNTIME"`, `stage = "capture"` e a mensagem original. Faça isso no ponto de
  `capture.ts` que espera `clock.ready` (linha ~107).
- Relógio: `clock.ts` ganha `__ff.prepare(fn)`.
  - As funções registradas rodam dentro de `settle()`, antes de esperar as fontes.
  - Exceção numa delas rejeita `ready` (`readyDeferred.reject`).
  - Não muda `syncAnimations`.
- Runtime `MOTION_SOURCE` (string IIFE, como `CLOCK_SOURCE`):
  1. Registra (`CSS.registerProperty`):

     | Propriedade | Sintaxe | Inicial |
     |---|---|---|
     | `--ff-x`, `--ff-y` | `<length-percentage>` | `0px` |
     | `--ff-sx`, `--ff-sy` | `<number>` | `1` |
     | `--ff-rot` | `<angle>` | `0deg` |
     | `--ff-blur` | `<length>` | `0px` |
     | `--ff-zoom` | `<number>` | `1` |
     | `--ff-fx`, `--ff-fy` | `<number>` | `0.5` |

  2. Define `window.__ffMotion = { attach(el) }`. `attach`:
     - lê e faz o parse de `data-ff-motion`; `v !== 1` lança `E_MOTION_CONFLICT: versão`;
     - para cada `[prop, valor]` em `s`, lança `E_MOTION_CONFLICT: <prop> declarada no style de <descrição>` se
       `el.style.getPropertyValue(prop)` já tiver valor, e senão faz `el.style.setProperty(prop, valor)`;
     - para cada entrada de `a`, chama
       `el.animate(k.map(([offset,v,e]) => ({offset, [p]: v, easing: e ?? "linear"})), {delay:d, duration:n, fill:"both", easing:"linear", id:"ff-motion"})`.
  3. Registra em `__ff.prepare`:
     - para todo `[data-ff-motion]` que não seja `<video>`: primeiro verifica `el.getAnimations()` com
       `CSSAnimation`/`CSSTransition` cujas chaves de `effect.getKeyframes()` toquem uma propriedade possuída;
       se houver, lança `E_MOTION_CONFLICT: animação CSS "<animationName>" anima <prop>`; depois chama `attach(el)`;
     - para `video[data-ff-motion]`: exige que `window.__ffMedia` liste o `data-clip-id` dele, senão lança
       `E_MOTION_TARGET: vídeo sem frames extraídos`; o vínculo acontece no shim (EDT-53).
  - Antes do EDT-53, o shim ainda não chama `attach`. Por isso, neste item, `video[data-ff-motion]` lança
    `E_MOTION_TARGET: motion em vídeo chega no EDT-53` e o contract recusa motion em `<video>` com
    `E_MOTION_TARGET`. Remova as duas recusas no EDT-53.
- `inject.ts`: a ordem passa a ser estilo de fontes → `CLOCK_SOURCE` → `MOTION_SOURCE` → manifesto →
  `MEDIA_SHIM` → preview/live.
- Producer:
  - `annotateMotion(html, composition)` usa parse5, igual a `annotateTiming`. Para cada nó com
    `data-clip-id` cujo `ResolvedClip` tenha `motion`:
    - `targets = [...motionElements(node)]`;
    - casa com `clip.motion` por `ordinal`;
    - se as contagens divergirem, `throw new Error("E_INTERNAL: alvos de motion divergentes")`;
    - grava `data-ff-motion` (JSON compacto, chaves na ordem do formato) com `d`, `n` e `k` calculados de
      `MotionTrack` (offset = (time − primeiro)/span; span 0 vira n = 1 com dois frames iguais) e `s` das
      ligações das propriedades **usadas**. A ligação de câmera está em EDT-53.
  - `annotateCompiled(html, composition)` = `annotateTiming` + `annotateMotion`. Use nos **dois** caminhos:
    `compileComposition` (`compile.ts`) e `prepare()` em `packages/producer/src/render.ts` (linha ~145, onde
    hoje chama `annotateTiming`).
  - Composição sem motion sai **byte a byte igual** a hoje.
- `splitClip` (`edit.ts`) recusa clip cujo `motion` não esteja vazio, com `E_SPLIT_UNSUPPORTED` e hint
  `remova o movimento antes de dividir`. Atualize a frase do §9d.

#### Spec

- `docs/contract.md`:
  - §7b.1–§7b.6, §7b.11 (sem `spring`, `mola` e `mola-firme`, que entram no EDT-50) e §7b.12;
  - em §4, linha na tabela remetendo a §7b;
  - em §9d, a regra do split;
  - em §10 Compatibilidade, "composições sem atributos de motion compilam igual".
- `PROVENANCE.md`, Registro: `| <data> | gramática de motion, curvas suave/freio/arranque/vaivem e presets próprios (EDT-49) |`.

#### Passos

1. `types.ts`: tipos acima.
2. `errors.ts`: códigos novos. Depois `node scripts/generate-reference.ts`.
3. `motion/grammar.ts`:
   - `parseMotionAttr(kind, raw, clipId, diagnostics): MotionSpec | undefined`;
   - `parseAnchor(text, kind)`, `parseSeconds`, `parseDistance`;
   - regex ancorada por token; nada de `eval`.
4. `motion/curves.ts`:
   - `type Curve = {kind:"css", name} | {kind:"bezier", x1,y1,x2,y2} | {kind:"spring", zeta, omega}`;
   - `parseCurve(text)` lança `CurveError` com hint; quem chama converte em diagnóstico;
   - `evaluateCurve(curve, p, durSeconds)` e `emitEasing(curve, durSeconds)`;
   - `NAMED_CURVES`;
   - neste item, `spring` dá `E_CURVE_INVALID` (ver Desenho).
5. `motion/presets.ts`: a interface `PresetDef { name, kind, label, dur, curve, keys: Record<string, ParamRule>, build(params, ctx) }`,
   os 3 presets e `listPresets(kind?)`.
6. `parse.ts`:
   - em `buildClip`, depois do bloco de `data-keyframes`, percorre `motionElements(node)`, monta
     `RawMotionTarget` e lê o `style` inline;
   - acrescenta os nomes novos em `ATTRS`;
   - em `parseComposition`, varre todos os elementos da raiz e emite `E_MOTION_TARGET` para cada elemento
     com atributo de motion que nenhum clip coletou, inclusive a raiz.
7. `motion/tracks.ts`: `resolveMotion(clips: ResolvedClip[], diagnostics)`, recursivo pelos `children`.
   Para cada clip com `motion`:
   - calcula D;
   - para cada alvo: intervalos (§7b.5), faixa, trilhas por propriedade, sobreposição, `W_MOTION_JUMP` e
     `E_MOTION_CONFLICT` estático (`inlineStyleProps` × propriedades possuídas usadas);
   - exceção: `opacity` inline é permitida, porque a animação sobrepõe valor estático sem ambiguidade.
8. `index.ts` (contract): chama `resolveMotion` dentro de `loadComposition`, depois de `resolveDuration` e
   antes de calcular `ok`. Exporta `motionElements`, `isTimedOrHost`, `listPresets`, `evaluateCurve`,
   `emitEasing`, `parseCurve` e os tipos.
9. `clock.ts`: `prepare` e a chamada dos hooks em `settle()`.
10. `packages/engine/src/motion-runtime.ts`: exporta `MOTION_SOURCE`. `inject.ts` faz a inclusão.
    Exporte pelo index do engine, como os outros.
11. `capture.ts`: mapeamento `E_MOTION_RUNTIME`. `producer/src/errors.ts`: allowlist. Se existir
    `packages/cli/test/errors.test.ts` com a lista fixa, atualize.
12. `packages/producer/src/motion.ts`: `annotateMotion` e `toRuntimeSpec(track, clipStartLocal)`.
    `compile.ts`: `annotateCompiled`. `render.ts`: troca a chamada.
13. `edit.ts`: recusa em `splitClip`.
14. `scripts/ci.ts`: acrescenta `packages/contract/test/motion.test.ts` e
    `packages/producer/test/motion-compile.test.ts` a `FAST_TESTS`.

#### Testes

- `packages/contract/test/motion.test.ts` (rápido):
  - `data-enter="surgir"` num clip de 3 s → `motion[0].tracks` = opacity [0@0 suave-emitido, 1@0.5 linear];
  - `data-exit="apagar"` → frames em 2.5 e 3;
  - `at=end-0.5` → 2.0 e 2.5;
  - `at=50%` → início 1.5;
  - `data-emphasis="pulsar"` com `data-enter="surgir"` → começa em 0.5;
  - `repeat=2 dur=0.4` → 5 frames em [0.5, 1.3];
  - erros, cada um checando `code` e `hint` não vazio:
    - `"surgir dur"` → `E_MOTION_SYNTAX`;
    - `"voar"` → `E_MOTION_PRESET_UNKNOWN` (hint contém `surgir`);
    - `"surgir foo=1"` → `E_MOTION_PARAM`;
    - `"surgir dur=-1"` → `E_MOTION_SYNTAX` ou `E_MOTION_PARAM` (fixe um);
    - `"surgir curve=cubic-bezier(2,0,0,1)"` → `E_CURVE_INVALID`;
    - `data-exit="apagar at=-1"` → `E_MOTION_PARAM` (âncora negativa só em enter);
    - `"surgir dur=5"` num clip de 3 s → `E_MOTION_OUT_OF_RANGE`;
    - `data-enter="surgir"` mais `data-exit="apagar dur=3"` num clip de 3 s → `E_MOTION_OVERLAP`;
    - `data-enter` na raiz → `E_MOTION_TARGET`;
    - `data-enter` num `<div>` fora de clip → `E_MOTION_TARGET`;
    - `style="translate:1px"` + `data-emphasis="pulsar"` → sem erro, porque pulsar usa `scale`;
    - `style="scale:2"` + `pulsar` → `E_MOTION_CONFLICT`;
  - descendente: `<div data-start="1" data-duration="2"><span data-enter="surgir"></span></div>` → `motion`
    com 2 alvos (ordinal 0 sem trilhas, ordinal 1 com opacity);
  - curvas: `evaluateCurve(suave, 0)=0`, `(…,1)=1`, monotônica em 101 pontos; `emitEasing(freio)` =
    `"cubic-bezier(0.18, 0.72, 0.28, 1)"` (fixe o formato).
- `packages/producer/test/motion-compile.test.ts` (rápido, sem browser):
  - `compileComposition` de uma composição com clip `data-start="1"` e `data-enter="surgir"`: o HTML tem
    `data-ff-motion` com `d = 1000`, `n = 500`, `p = "opacity"`;
  - o mesmo dentro de uma sub-composição em `data-start="2"` (use o fixture de `subcomposition.test.ts`):
    `d` continua relativo ao escopo (1000), não 3000;
  - composição sem motion: HTML igual ao de `annotateTiming` puro (compare strings);
  - o caminho de `prepare()` também anota, a menos que ele exija Chrome; nesse caso o teste fica em
    `motion-render.test.ts`. Teste `annotateCompiled` direto e verifique, por um teste de import, que
    `render.ts` usa `annotateCompiled` (grep na fonte é aceitável como guarda).
- `packages/producer/test/motion-render.test.ts` (Chrome; padrão de `subcomposition.test.ts`):
  - `getComputedStyle(el).opacity` em t = 1.0, 1.25 e 1.5 bate com `evaluateCurve` ±0.01;
  - hash por frame: 12 frames capturados em ordem, de novo e em ordem invertida → hashes iguais por frame e
    pelo menos 6 distintos;
  - conflito: um elemento com `animation: x 1s` (keyframes de opacity) e `data-enter="surgir"` → a sessão
    falha ao abrir com mensagem contendo `E_MOTION_CONFLICT`, e `toErrorPayload` dá `code = E_MOTION_RUNTIME`.
- `packages/engine/test/clock.test.ts`: `__ff.prepare(() => { throw new Error("E_X") })` rejeita `ready`.
- Os goldens do catálogo (`goldens.test.ts`) continuam verdes sem regenerar.

#### Verificação manual

- `node packages/cli/src/cli.ts lint examples/hello.html --json`: nada muda.
- Copie `examples/hello.html` para o scratchpad, ponha `data-enter="surgir dur=1"` e
  `data-exit="apagar at=end"` no título e rode `render ... --preset draft`: o título aparece e some
  suavemente.
- Rode `preview` no mesmo arquivo e arraste o playhead para trás e para frente: mesmo quadro.

#### Arquivos tocados

- contract: `types.ts`, `errors.ts`, `parse.ts`, `index.ts`, e os novos `motion/{grammar,curves,presets,targets,tracks,index}.ts`;
- engine: `clock.ts`, `inject.ts`, `capture.ts`, novo `motion-runtime.ts`;
- producer: `errors.ts`, `compile.ts`, `render.ts`, `edit.ts`, novo `motion.ts`;
- `scripts/ci.ts`, `docs/contract.md`, `docs/reference/diagnostics.md` (gerado), `PROVENANCE.md`;
- testes novos e alterados listados acima.

#### Dependências

Nenhuma. Primeiro item do épico.

#### Riscos

- Divergência entre `motionElements` no contract e no producer se alguém mudar o HTML entre parse e
  anotação. Por isso o producer anota o **mesmo** HTML materializado que foi para `loadComposition`.
- Registro de propriedade depois de estilo aplicado: o `MOTION_SOURCE` roda no `<head>`, antes do body.
  **[PARAR SE]** `document.readyState` já não for `loading` quando o clock roda (ex.: injeção mudou de lugar).
- `CSS.registerProperty` lança se o nome já foi registrado (live reload no mesmo documento). Ignore só a
  exceção `InvalidModificationError` do mesmo nome, com comentário. Qualquer outra propaga.
- **[PARAR SE]** `ResolvedClip.start` não for o início no escopo local (ver `resolve.ts`): o cálculo de `d`
  depende disso.

---

### EDT-50: Keyframes visuais por propriedade com curva por trecho

#### Desenho

- O mesmo atributo `data-keyframes`, com pontos estendidos. Cada ponto:
  `{"time": s≥0, "volume"?, "opacity"?, "x"?, "y"?, "scale"?|"scaleX"?|"scaleY"?, "rotate"?, "blur"?, "clip"?, "zoom"?, "focusX"?, "focusY"?, "curve"?}`.
  - O tempo é relativo ao início do clip (o mesmo dos keyframes de volume).
  - `curve` vale para os trechos que **começam** neste ponto, em todas as propriedades dele. O padrão é
    `linear`.
- Compatibilidade:
  - `RawClip.keyframes` continua só com `{time, volume}`, e só dos pontos que têm `volume`. `audio.ts` não muda.
  - JSON malformado, não-array ou `time`/`volume` não finito ou negativo continuam `E_NUMBER_INVALID`
    com o hint atual.
- Novo campo `RawMotionTarget.keyframes?: VisualKeyframe[]`, com
  `VisualKeyframe = { time; values: Partial<Record<MotionProp, MotionValue>>; curve: Curve }`.
  - Vale para clip e descendente.
  - O ponto que só tem volume não entra.
- `motionElements` passa a considerar `data-keyframes` em descendentes.
- No clip, `data-keyframes` só com volume não cria alvo de motion: `RawClip.motion` fica ausente se nenhum
  alvo tiver nada.
- Códigos novos:
  - `E_KEYFRAME_INVALID` (error), para:
    - chave desconhecida;
    - valor fora da faixa de §7b.6;
    - `scale` junto com `scaleX`/`scaleY` no mesmo ponto;
    - dois pontos com o mesmo `time`;
    - ponto sem nenhuma propriedade;
    - `clip` misturando `inset` e `circle` na mesma trilha;
    - `zoom`/`focus*` fora de img/video;
    - `volume` em descendente;
  - `E_KEYFRAME_LIMIT` (error): mais de 256 pontos;
  - `W_KEYFRAME_OUT_OF_RANGE`: `time` > D; o ponto é mantido, e o hint diz que ele nunca aparece;
  - `W_KEYFRAME_CURVE_IGNORED`: `curve` num ponto só de volume, porque o volume é sempre linear.
- Trilhas:
  - cada propriedade forma uma trilha com os pontos que a têm, em ordem de `time`;
  - o intervalo da trilha é [primeiro, último];
  - entra na mesma checagem de sobreposição e de salto do EDT-49 contra os presets.
  - Ponto único: trilha constante.
- `spring`:
  - entra em `curves.ts` (§7b.11), com `NAMED_CURVES.mola` e `mola-firme`;
  - a emissão depende da duração do trecho: em keyframes, dur = `time` seguinte − `time` atual; em presets,
    dur do trecho;
  - a mola que não assenta dá `E_CURVE_INVALID` com o mínimo no hint;
  - tire o hint provisório do EDT-49.
- `clip` é animado direto em `clip-path`: o compilador normaliza o texto (`inset(0% 10% 0% 0%)`, sempre
  com `%`, 4 valores).

#### Spec

- `docs/contract.md`:
  - §7b.7 com o formato do ponto, a tabela de faixas (§7b.6), a regra da curva por trecho e um exemplo;
  - §7b.11 completo com spring;
  - §4: a linha de `data-keyframes` remete a §7b.7;
  - §10: "pontos só de volume continuam idênticos".

#### Passos

1. `types.ts`: `VisualKeyframe`, `RawMotionTarget.keyframes`.
2. `parse.ts`: reescreva o bloco de `data-keyframes` (linhas ~163–185) como `parseKeyframes(raw, ctx)` em
   `motion/keyframes.ts`, devolvendo `{ volume: Array<{time, volume}>, visual: VisualKeyframe[] }`.
   Mantenha a mensagem e o hint atuais nos casos `E_NUMBER_INVALID`.
3. `motion/curves.ts`: `spring` (avaliação fechada, checagem de assentamento, emissão `linear(...)`).
4. `motion/tracks.ts`: trilhas de keyframes, faixas e avisos.
5. `producer/src/motion.ts`: valores CSS:
   - `x`/`y` numérico vira `"<n>px"`;
   - `rotate` vira `"<n>deg"`;
   - `blur` vira `"<n>px"`;
   - `scale*`, `zoom` e `focus*` são números;
   - `clip` é normalizado.
6. Erros em `errors.ts` e `generate-reference`.

#### Testes

- `motion.test.ts`:
  - `[{"time":0,"volume":1},{"time":2,"volume":0.2}]` → `RawClip.keyframes` igual ao de hoje e `motion` ausente;
  - `[{"time":0,"opacity":0,"curve":"freio"},{"time":1,"opacity":1,"x":"10%"}]` → trilhas `opacity` (2 frames;
    o primeiro com o easing de freio) e `x` (1 frame, constante);
  - cada caso de `E_KEYFRAME_INVALID` acima, um por asserção;
  - 257 pontos → `E_KEYFRAME_LIMIT`;
  - `time` 9 num clip de 3 s → `W_KEYFRAME_OUT_OF_RANGE`;
  - keyframes de opacity em [0,1] com `data-enter="surgir"` → `E_MOTION_OVERLAP`;
  - spring:
    - `evaluateCurve(mola, 0)=0`, `(…,1)=1`;
    - com ζ=0.45 passa de 1 em algum ponto (overshoot);
    - com ζ=1 é monotônica;
    - `emitEasing(spring(0.45,18), 0.8)` começa com `linear(0, ` e tem 64 valores;
    - snapshot exato da string (protege o determinismo);
    - `spring(0.45,18)` com dur 0.3 → `E_CURVE_INVALID` com hint contendo `0.59` (valor calculado; fixe o que
      a fórmula der e confira à mão no teste).
  - `audio.test.ts` continua verde sem mudança.
- `motion-render.test.ts`:
  - composição 640×360 com um `<div>` de clip e keyframes de todas as propriedades visuais (opacity, x em px
    e %, scale, rotate, blur, clip inset; um trecho com `mola`);
  - nos tempos 0.25/0.5/0.75 de cada trecho, o computado bate com `evaluateCurve` (opacity ±0.01; `translate`
    ±0.5 px; `scale` ±0.005; `rotate` ±0.1°; blur pelo `filter` ±0.1 px);
  - hash por frame: 20 frames em ordem, repetido e invertido.

#### Verificação manual

Arquivo no scratchpad com keyframes de x (0→400px com `mola`) e clip `inset(0% 100% 0% 0%)`→`inset(0% 0% 0% 0%)`.
Rode `render` e confira o overshoot e o recorte.

#### Arquivos tocados

- contract: `parse.ts`, `types.ts`, `errors.ts`, `motion/{curves,tracks}.ts`, novo `motion/keyframes.ts`;
- producer: `motion.ts`;
- `docs/contract.md`, `docs/reference/diagnostics.md`;
- testes.

#### Dependências

EDT-49.

#### Riscos

- Teste antigo que espere `E_NUMBER_INVALID` para ponto sem volume: agora é `E_KEYFRAME_INVALID`.
  **[PARAR SE]** algum teste existente quebrar por isso; o planejamento decide.
- `linear()` com valores acima de 1 é válido no Chrome 158. **[PARAR SE]** o teste de render mostrar
  clamping.

---

### EDT-51: Presets próprios de entrada, saída e ênfase

#### Desenho

- 26 presets: 12 de entrada, 8 de saída e 6 de ênfase.
- Entrada vai do deslocamento até o neutro; saída vai do neutro até o deslocamento; ênfase sai do neutro e
  volta a ele.
- Nomes ASCII em `kebab-case`; o `label` em português com acento é só para a UI.
- Tabela definitiva (dur em s; `d` = distance; `a` = amount):

| Nome | Label | Tipo | Movimento | dur | curva | chaves extras (padrão) |
|---|---|---|---|---|---|---|
| `surgir` | Surgir | entrada | opacity 0→1 | 0.5 | suave | — |
| `subir` | Subir | entrada | opacity 0→1; y d→0 | 0.6 | freio | distance (32px) |
| `descer` | Descer | entrada | opacity 0→1; y −d→0 | 0.6 | freio | distance (32px) |
| `chegar-esquerda` | Chegar da esquerda | entrada | opacity 0→1; x −d→0 | 0.6 | freio | distance (48px) |
| `chegar-direita` | Chegar da direita | entrada | opacity 0→1; x d→0 | 0.6 | freio | distance (48px) |
| `crescer` | Crescer | entrada | opacity 0→1; scale a→1 | 0.5 | freio | amount (0.8) |
| `assentar` | Assentar | entrada | opacity 0→1; scale a→1 | 0.6 | suave | amount (1.12) |
| `focar` | Focar | entrada | opacity 0→1; blur a→0 | 0.7 | suave | amount (12) px |
| `girar` | Girar | entrada | opacity 0→1; rotate −a→0; scale 0.9→1 | 0.6 | freio | amount (12) graus |
| `abrir` | Abrir | entrada | clip por dir → `inset(0% 0% 0% 0%)` | 0.7 | vaivem | dir (right) |
| `erguer` | Erguer | entrada | opacity 0→1; y 24px→0; scale 0.96→1; blur 6→0 | 0.8 | suave | — |
| `saltar` | Saltar | entrada | opacity 0→1 (suave); scale a→1 (mola) | 0.7 | mola | amount (0.6) |
| `apagar` | Apagar | saída | opacity 1→0 | 0.5 | suave | — |
| `partir-cima` | Partir para cima | saída | opacity 1→0; y 0→−d | 0.5 | arranque | distance (32px) |
| `partir-baixo` | Partir para baixo | saída | opacity 1→0; y 0→d | 0.5 | arranque | distance (32px) |
| `partir-esquerda` | Partir para a esquerda | saída | opacity 1→0; x 0→−d | 0.5 | arranque | distance (48px) |
| `partir-direita` | Partir para a direita | saída | opacity 1→0; x 0→d | 0.5 | arranque | distance (48px) |
| `recuar` | Recuar | saída | opacity 1→0; scale 1→a | 0.5 | arranque | amount (0.85) |
| `desfocar` | Desfocar | saída | opacity 1→0; blur 0→a | 0.6 | suave | amount (12) px |
| `fechar` | Fechar | saída | clip `inset(0% 0% 0% 0%)` → por dir | 0.6 | vaivem | dir (left) |
| `pulsar` | Pulsar | ênfase | scale 1→a→1 | 0.6 | suave | amount (1.08), repeat (1) |
| `balancar` | Balançar | ênfase | rotate 0→a→−a→0 | 0.8 | vaivem | amount (4) graus, repeat (1) |
| `tremer` | Tremer | ênfase | x 0→a→−a→a/2→−a/2→0 | 0.4 | linear | amount (6) px, repeat (1) |
| `respirar` | Respirar | ênfase | scale 1→a→1 | 2.0 | vaivem | amount (1.03), repeat (1) |
| `piscar` | Piscar | ênfase | opacity 1→a→1 | 0.4 | vaivem | amount (0.2), repeat (1) |
| `quicar` | Quicar | ênfase | y 0→−d (freio) →0 (arranque) | 0.5 | freio/arranque | distance (16px), repeat (1) |

- Recorte por `dir`:
  - em `abrir`, o valor inicial é right `inset(0% 100% 0% 0%)`, left `inset(0% 0% 0% 100%)`, up `inset(100% 0% 0% 0%)` e
    down `inset(0% 0% 100% 0%)`;
  - `fechar` usa o mesmo mapa como valor final; o padrão left fecha em direção à esquerda.
- `curve=` do usuário substitui todas as curvas do preset, inclusive as mistas de `saltar` e `quicar`.
- Todo preset aceita `dur`, `at` e `curve`, mais as chaves da tabela.
- Faixas: `distance` com |n| ≤ 2000px ou ≤ 200%; `amount` com faixa por preset no `keys` do `PresetDef`
  (escalas [0.05,5]; graus [0,180]; blur [0,100]; opacity [0,1]).
- Cada `PresetDef.build` recebe params já validados e devolve os frames em progresso.
- Miniaturas:
  - `scripts/generate-motion-thumbs.ts` gera `catalog/motion/thumbs/<nome>.gif`;
  - cena: 320×180, 15 fps, fundo `#14161a`, cartão 140×70 `#e8e4da` com o texto "Aa" numa fonte do catálogo
    (ex.: a primeira família de `vendor/fonts` usada pelo `font-catalog`);
  - duração: dur do preset + 0.3 s antes e depois; ênfase sobre o cartão parado; saída começa visível;
  - captura com a sessão do engine (padrão de `goldens.ts`/`captureFrameAt`) num diretório do scratchpad do SO
    (`mkdtemp`);
  - GIF pelo FFmpeg de `vendor/ffmpeg`:
    `-framerate 15 -i %04d.png -vf "split[a][b];[a]palettegen=max_colors=48[p];[b][p]paletteuse=dither=none" -loop 0`;
  - teto: 200 KB por arquivo; o script falha se passar.
- `docs/motion.md`: uma tabela por tipo com nome, label, o que faz, dur/curva padrão, chaves e miniatura
  (`![subir](../catalog/motion/thumbs/subir.gif)`). Abre com os exemplos de §7b.
- Catálogo: `packages/catalog/src/index.ts` exporta `MOTION_THUMBS_DIR` e `motionThumbPath(name)`, que valida
  o nome com a regex `SLUG` e lança se não existir.

#### Spec

- `docs/motion.md` (novo, fonte de verdade da lista).
- `docs/contract.md` §7b.3 remete a ele.
- `PROVENANCE.md`, Registro: `| <data> | 26 presets de motion e miniaturas geradas pelo próprio engine (EDT-51) |`.
- `skills/frankframes/SKILL.md`, seção "Animação":
  - recomendar `data-enter`/`data-exit`/`data-emphasis`/`data-keyframes` antes de CSS;
  - 3 exemplos curtos;
  - nomes dos presets;
  - "CSS `@keyframes` continua valendo para o que motion não cobre (cor, stroke, largura)";
  - depois: `node scripts/sync-skill.ts`.

#### Passos

1. `presets.ts`: os 23 restantes (EDT-49 já entregou 3), usando um helper de deslocamento, `offsetEnter(props)`,
   para não repetir código.
2. Teste unitário de cada preset (abaixo).
3. `generate-motion-thumbs.ts`, rodar, commitar os GIFs (o titular faz o commit).
4. `docs/motion.md`.
5. `packages/catalog/src/index.ts`.
6. SKILL e sync.
7. `scripts/ci.ts`: `packages/catalog/test/motion-thumbs.test.ts` em `FAST_TESTS`.

#### Testes

- `motion.test.ts`:
  - `listPresets("enter").length === 12`, `exit` 8, `emphasis` 6;
  - nomes únicos e ASCII `^[a-z][a-z0-9-]*$`;
  - todo preset com params padrão monta trilhas sem diagnóstico num clip de 5 s;
  - entrada termina no neutro e saída começa no neutro (compare o último ou primeiro frame com a tabela de
    neutros);
  - ênfase começa e termina no neutro;
  - `abrir dir=up` dá o primeiro frame `inset(100% 0% 0% 0%)`;
  - `saltar dur=0.3` → `E_CURVE_INVALID` (mola não assenta).
- `packages/catalog/test/motion-thumbs.test.ts` (rápido):
  - para cada preset de `listPresets()` (todos os tipos existentes no momento) existe
    `catalog/motion/thumbs/<nome>.gif`, começa com `GIF89a` e tem ≤ 200 KB;
  - nenhum GIF órfão;
  - `docs/motion.md` contém cada nome.
- `skill-sync.test.ts` verde.

#### Verificação manual

- Abra `docs/motion.md` num visualizador de Markdown: todas as miniaturas animam e batem com a descrição.
- Confira três presets em `render` real.

#### Arquivos tocados

- `packages/contract/src/motion/presets.ts`;
- `scripts/generate-motion-thumbs.ts` (novo), `catalog/motion/thumbs/*.gif` (novos);
- `docs/motion.md`, `docs/contract.md`, `PROVENANCE.md`;
- `packages/catalog/src/index.ts`, `skills/frankframes/SKILL.md`, `packages/cli/skill/SKILL.md` (sync);
- `scripts/ci.ts`, testes.

#### Dependências

EDT-50 (por causa de `mola`).

#### Riscos

- Nome que lembre preset de terceiros: os nomes acima são verbos em português escolhidos aqui. Não traduza
  nomes de outra ferramenta.
- O GIF depende do Chrome e da fonte. Ele não é teste de determinismo: regenerar muda bytes, e isso é
  aceitável.

---

### EDT-52: Tipografia cinética (split por palavra ou letra)

#### Desenho

- `data-split="word|letter [stagger=<s>] [order=forward|reverse|center]"`.
  - Padrões: stagger 0.06 s (word) ou 0.03 s (letter); order `forward`.
  - Exige no mesmo elemento pelo menos um entre `data-enter`, `data-exit` e `data-emphasis`; senão
    `E_MOTION_TARGET` com hint `data-split precisa de data-enter, data-exit ou data-emphasis`.
  - Esses três atributos passam a valer **por unidade**, não no elemento.
  - `data-keyframes` no mesmo elemento continua valendo para o elemento inteiro.
- Segmentação, em `packages/contract/src/motion/split.ts`, compartilhada pelo contract (contagem e
  validação) e pelo producer (reescrita):
  - `splitText(text, mode): Array<{ text: string; unit: boolean; word?: number }>`;
  - `new Intl.Segmenter("und", { granularity })`: locale fixo `"und"` para determinismo.
  - `word`:
    - segmento `isWordLike` vira unidade;
    - espaço em branco vira texto solto, preservado byte a byte;
    - pontuação colada (sem espaço entre) gruda na unidade anterior;
    - se não houver anterior (ex.: `“` ou `¿` no começo), gruda na seguinte.
  - `letter`:
    - granularidade `grapheme`, um grafema por unidade (`é` decomposto, emoji com modificador ou ZWJ
      contam como uma unidade);
    - espaço em branco vira texto solto;
    - cada palavra (sequência sem espaço) fica envolta num span `white-space:nowrap`, para a linha não
      quebrar no meio.
- Texto alvo: os nós de texto descendentes do elemento, em ordem, cada um segmentado separadamente. Uma
  palavra dividida por `<b>` vira duas unidades (documentado).
  - Elementos internos com atributo de motion → `E_MOTION_TARGET`.
  - Sem nenhuma unidade → `E_MOTION_TARGET` com hint `data-split sem texto`.
- Unidades explícitas: se algum descendente tiver `data-unit`, não há segmentação. As unidades são esses
  elementos, em ordem de documento.
  - `data-unit="<s>"` fixa o início da entrada daquela unidade (tempo local ao clip).
  - Vazio segue o stagger.
  - Valor inválido → `E_MOTION_PARAM`.
- Posto `r` da unidade i entre n:
  - `forward`: r = i;
  - `reverse`: r = n−1−i;
  - `center`: r = ⌊|i − (n−1)/2|⌋;
  - R = maior posto.
- Tempo por unidade:
  - entrada começa em `T + r·stagger`, ou no `data-unit` explícito;
  - saída termina em `T − (R−r)·stagger`;
  - ênfase começa em `T + r·stagger`;
  - faixa e sobreposição como em §7b.5, por unidade;
  - o padrão de `at` da ênfase é o fim da última entrada.
- Tipos:
  - `RawMotionTarget.split?: { mode; stagger; order; explicit: boolean; units: Array<{ anchor?: number }> }`;
  - `ResolvedMotionTarget.units?: MotionTrack[][]`, as trilhas por unidade, na ordem do documento.
- Producer, em `annotateMotion`:
  - para alvo com split, depois de gravar o `data-ff-motion` do próprio elemento (se ele tiver keyframes),
    reescreve os nós de texto com `splitText`;
  - cada unidade vira `<span data-ff-unit="<i>" style="display:inline-block">texto</span>`, mais o span
    `nowrap` no modo letter;
  - no modo explícito, só acrescenta `data-ff-unit` e `display:inline-block` aos elementos de `data-unit`;
  - grava `data-ff-motion` em cada unidade;
  - texto escapado pelo serializer do parse5 (nada de concatenar HTML);
  - a fonte é herdada; nenhum estilo de fonte é tocado.
- Legendas: `buildCaptionComposition(segments, options)` (`packages/producer/src/captions.ts`) ganha
  `options.motion?: { enter: string; exit?: string }`. Com ela:
  - o div `.caption` recebe `data-split="word"`, `data-enter` e `data-exit` (sem stagger, porque as unidades
    são explícitas);
  - no karaokê, cada `<span class="w">` recebe `data-unit="<word.start − segment.start>"` (3 casas);
  - sem palavras, as spans `.w` não existem: as unidades viram automáticas por palavra;
  - a animação de cor do karaokê continua em CSS (cor não é propriedade possuída);
  - a CLI de legendas ganha `--motion "<preset de entrada>"`. Veja onde `captions-cli.test.ts` monta as
    opções; o nome da flag é `--motion`.

#### Spec

- `docs/contract.md` §7b.8: gramática, segmentação, tempo por unidade, modo explícito, limitações (scripts
  cursivos, como árabe, perdem a ligação entre letras no modo letter; ligaduras entre unidades se perdem).
- `docs/` das legendas (se houver doc da CLI de captions): a flag nova.

#### Passos

1. `split.ts` e os testes de segmentação.
2. `parse.ts`/`tracks.ts`: split, unidades, tempo.
3. `producer/src/motion.ts`: reescrita.
4. `captions.ts` e a CLI.
5. Docs.

#### Testes

- `motion.test.ts`, `splitText`:
  - `"Olá, mundo!"` em word → unidades `["Olá,", "mundo!"]` e o espaço preservado;
  - `"ação  já"` (dois espaços) → os espaços intactos;
  - `"e\u0301 👍🏽 👨‍👩‍👧"` em letter → 3 unidades;
  - `"“Sim”"` → uma unidade `“Sim”`;
  - a soma dos textos reconstrói a entrada exatamente, também numa propriedade aleatória: 50 strings com
    seed fixa, misturando acentos e emoji.
- `motion.test.ts`, tempo:
  - 3 palavras com `stagger=0.1`, `surgir` → inícios 0, 0.1 e 0.2;
  - `order=reverse` → 0.2, 0.1 e 0;
  - `center` com 4 → postos 1, 0, 0, 1;
  - saída `apagar` com stagger: a última unidade termina em D;
  - stagger que estoura D → `E_MOTION_OUT_OF_RANGE`.
- `motion-compile.test.ts`:
  - o HTML compilado tem n spans `data-ff-unit`;
  - o `textContent` do elemento é igual ao original (acentos, espaços);
  - cada span tem `data-ff-motion` com `d` crescente.
- `captions.test.ts`: com `motion: {enter:"subir"}`, as spans `.w` têm `data-unit` igual a
  `word.start − segment.start`, e `loadComposition` do HTML gerado é `ok`.
- `motion-render.test.ts`:
  - frase com acentos numa fonte do catálogo: `innerText` após `__ff.ready` igual ao original;
  - `getComputedStyle(span).fontFamily` igual ao do pai;
  - hash por frame em ordem, repetido e invertido;
  - a legenda gerada com motion renderiza sem erro de página (`session.pageErrors` vazio).

#### Verificação manual

- `render` de uma frase "Coração, ação e emoção 👍🏽" com `data-split="letter"` e `data-enter="subir"`:
  nenhum acento solto, emoji inteiro, linha sem quebra no meio da palavra.
- Legendas com `--motion subir` num áudio curto.

#### Arquivos tocados

- contract: `motion/{split,tracks}.ts`, `parse.ts`, `types.ts`;
- producer: `motion.ts`, `captions.ts`;
- CLI de captions (arquivo do comando em `packages/cli/src/`);
- docs, testes.

#### Dependências

EDT-51 (presets usados nos testes e nas legendas).

#### Riscos

- A versão do ICU do Node muda a segmentação. O contract e o producer rodam no mesmo processo, então não há
  divergência interna; entre versões do Node, o hash dos goldens que usarem split pode mudar. Ponha a
  versão do Node no relatório do teste.
- `display:inline-block` muda a quebra de linha (espaço entre inline-blocks se mantém porque o espaço fica
  como texto).

---

### EDT-53: Câmera em imagem e vídeo (pan, zoom, deriva)

#### Desenho

- `data-camera="<preset> [dur=] [at=] [curve=] [amount=] [fx=] [fy=]"`, só em `<img>`/`<video>`.
- Propriedades `zoom`, `focusX` e `focusY` (também via `data-keyframes`).
- Ligação (`s` de `data-ff-motion`), com `m = (100% − 100% / var(--ff-zoom))`:
  `object-view-box: inset(calc(var(--ff-fy) * m) calc((1 − var(--ff-fx)) * m) calc((1 − var(--ff-fy)) * m) calc(var(--ff-fx) * m))`.
  - Escreva a expressão expandida, sem variável `m`.
  - A imagem é reamostrada a partir da resolução de origem (os frames de vídeo saem do FFmpeg em
    resolução de origem, ver `media.ts`). Não há serrilhado de transform sobre bitmap já reduzido.
- Presets (`kind: "camera"`):

  | Nome | Label | Movimento | curva | chaves (padrão) |
  |---|---|---|---|---|
  | `aproximar` | Aproximar | zoom 1→a, foco fixo | suave | amount (1.15), fx (0.5), fy (0.5) |
  | `afastar` | Afastar | zoom a→1, foco fixo | suave | amount (1.15), fx, fy |
  | `panoramica-esquerda` | Panorâmica à esquerda | zoom a fixo; focusX 0.75→0.25 | linear | amount (1.12), fy (0.5) |
  | `panoramica-direita` | Panorâmica à direita | zoom a fixo; focusX 0.25→0.75 | linear | amount (1.12), fy (0.5) |
  | `deriva` | Deriva | zoom 1.06→1.10; focusX 0.45→0.55; focusY 0.48→0.52 | linear | — |

  - `amount` ∈ [1,4].
  - `dur` padrão = D − at (câmera ocupa o clip inteiro).
- Shim de mídia (`packages/engine/src/media-shim.ts`, em `swap()`):
  1. Copia também `data-ff-comp-start` e `data-ff-motion` do vídeo para a `<img>`.
  2. Troca o `object-fit:contain` fixo pelo `object-fit` e `object-position` **computados** do vídeo.
     É correção de comportamento: vídeo com `object-fit:cover` hoje sai `contain`. Atualize §6.
  3. Depois de inserir a img, se ela tem `data-ff-motion`, chama `window.__ffMotion.attach(img)`.
     Sem `__ffMotion`, lança `E_MOTION_TARGET`.
  4. A medida `getBoundingClientRect()` do vídeo continua igual, porque o runtime nunca anima `<video>`.
- Tire as duas recusas provisórias do EDT-49 (motion em `<video>`).
- Motion de entrada, saída ou ênfase em `<video>` também passa a valer pela img.

#### Spec

- `docs/contract.md`:
  - §7b.9: câmera, a fórmula de `object-view-box`, "zoom ≥ 1";
  - §6: a img substituta herda `object-fit`/`object-position` e o motion;
  - limitação: img substituta é `position:fixed`, então motion num **ancestral** do vídeo não move o vídeo.
    Isso já valia para animação CSS; documente.

#### Passos

1. **Sonda primeiro**: teste no Chrome pinado com uma `<img>` com a ligação e `--ff-zoom` animado. Confira
   que `getComputedStyle(img).objectViewBox` muda entre dois seeks.
   **[PARAR SE]** o Chrome 158 não aceitar `calc()` com `var()` dentro de `inset()` de `object-view-box`.
2. `presets.ts` (câmera), `tracks.ts` (dur padrão), `producer/src/motion.ts` (ligação).
3. `media-shim.ts`.
4. Testes e docs.

#### Testes

- `motion.test.ts`:
  - `data-camera` num `<div>` → `E_MOTION_TARGET`;
  - `zoom` 0.5 em keyframe → `E_KEYFRAME_INVALID`;
  - `aproximar` num img de 4 s → zoom 1@0 e 1.15@4;
  - `deriva` → 3 trilhas.
- `packages/producer/test/motion-camera.test.ts` (Chrome + FFmpeg):
  - imagem de teste gerada no teste com o FFmpeg (`-f lavfi -i color=c=0x202020:s=3840x2160` +
    `drawbox` vermelho 80×80 no centro, 1 frame PNG);
  - composição 1920×1080 com `<img data-camera="panoramica-direita" data-duration="2">`;
  - 30 frames: centróide x do vermelho (PNG → `rgb24` cru pelo FFmpeg, média ponderada dos pixels com
    R>200, G<60) estritamente monotônico (decrescente na tela, porque a vista vai para a direita), com
    |Δ²x| ≤ 1.0 px (sem tremor);
  - hash por frame em ordem, repetido e invertido.
- Mesmo arquivo, vídeo:
  - vídeo de teste gerado como os fixtures de `packages/engine/test/media.test.ts` ou
    `producer/test/nested-media.test.ts` (reuse o helper);
  - `<video data-camera="aproximar">`: depois do primeiro seek, `video.style.display === "none"`;
  - `document.getAnimations().filter(a => a.id === "ff-motion" && a.effect.target.tagName === "IMG").length ≥ 1`;
  - nenhum `ff-motion` no `<video>`;
  - frames distintos;
  - reaproveite a asserção já existente desses testes de que o Chrome não decodifica o vídeo.
- `object-fit`: `<video style="object-fit:cover">` → img com `object-fit: cover`.
- Goldens do catálogo verdes. **[PARAR SE]** algum bloco com vídeo mudar por causa do `object-fit`.

#### Verificação manual

- `render` 1080p de uma foto de verdade com `deriva` e de um vídeo com `aproximar`.
- Assista em tela cheia: sem degraus nem tremor.

#### Arquivos tocados

- engine: `media-shim.ts`, `motion-runtime.ts` (sem a recusa);
- contract: `presets.ts`, `tracks.ts`, `parse.ts` (sem a recusa);
- producer: `motion.ts`;
- `docs/contract.md`, `docs/motion.md` (+ miniaturas de câmera via `generate-motion-thumbs.ts`, com uma
  foto gerada pelo FFmpeg `testsrc2` em 1280×720);
- testes.

#### Dependências

EDT-51 (a infraestrutura de miniaturas e o teste de órfãos passam a incluir câmera).

#### Riscos

- `object-view-box` com `object-fit:contain` mostra barras se a proporção mudar. A view box mantém a
  proporção da origem, então isso não acontece; confira no teste visual.
- Movimento sub-pixel em vídeo comprimido pode parecer "nadar". Aceito, porque é a própria imagem.

---

### EDT-54: Transições entre clips adjacentes

#### Desenho

- **Representação no HTML**: sobreposição explícita.
  - O clip que **entra** (B) declara `data-transition="<preset> [chave=valor]"`.
  - O `data-start` de B precisa ser `"<id de A> - <d>"` (referência ao fim de A com deslocamento negativo),
    em que A é irmão no mesmo escopo e vem antes de B no documento.
  - `d` é a duração da transição; **não existe chave `dur`** (`E_MOTION_PARAM` com hint
    `a duração da transição é a sobreposição em data-start`).
  - Uma fonte de verdade só: mudar a duração é mudar o `data-start`.
- Validação em `tracks.ts`, que tem acesso aos irmãos:
  - `startExpr.kind !== "reference"`, `offset >= 0`, A inexistente no mesmo escopo ou A depois de B →
    `E_TRANSITION_PARTNER`, com hint `use data-start="<id-anterior> - 0.5"`;
  - d > min(D_A, D_B) → `E_MOTION_OUT_OF_RANGE`.
  - **[PARAR SE]** o `refId` de `TimeExpr` não for o identificador que o Studio consegue escrever (veja
    `resolve.ts`: qual atributo a referência casa).
- Segmentos de transição vão para o alvo ordinal 0 de B e, quando o preset mexe em A, para o ordinal 0 de A,
  com a mesma checagem de sobreposição e salto. A ordem de documento garante B por cima de A (mesmo
  contexto de empilhamento; documente).
- Presets (`kind: "transition"`), intervalos B [0,d] e A [D_A−d, D_A]:

  | Nome | Label | B | A | curva | chaves (padrão) |
  |---|---|---|---|---|---|
  | `dissolver` | Dissolver | opacity 0→1 | — | suave | — |
  | `cortina` | Cortina | clip por dir → `inset(0% 0% 0% 0%)` (mapa de `abrir`) | — | vaivem | dir (right) |
  | `empurrar` | Empurrar | x ±100%→0 | x 0→∓100% | vaivem | dir (left: B vem da direita) |
  | `zoom` | Zoom | scale 1.2→1; opacity 0→1 | — | freio | — |
  | `iris` | Íris | clip `circle(0% at X% Y%)`→`circle(R% at X% Y%)` | — | arranque | fx (0.5), fy (0.5) |

  - Em `iris`, R = 75 quando fx = fy = 0.5; senão R = 150.
  - Em `empurrar`, os sinais seguem `dir`: left B +100%→0 e A 0→−100%; right o oposto; up/down no y.
- Studio:
  - **Endpoint** `POST /api/clips/<id>/transition`, corpo
    `{ "preset": "<nome>" | null, "dur": <s>, "params"?: {..} }`, executado por função pura
    `applyTransition(source, { clipId, preset, dur, params })` em `packages/producer/src/edit.ts`:
    - acha A, o irmão cujo fim resolvido == início resolvido de B (±1e-6), ou o A já referenciado por uma
      transição existente; nenhum → `EditError("E_TRANSITION_GAP", "nenhum clip termina onde este começa")`;
    - com preset: grava `data-start="<refA> - <dur>"` e `data-transition="<preset>[ k=v]"`; se A não tiver o
      identificador que a referência usa, grava-o em A no mesmo patch (com `applyPatches`);
    - `preset: null`: remove `data-transition` e grava `data-start="<refA>"`, ou seja, adjacente sem sobreposição;
    - o servidor valida com `validated()` e grava com `commit("transição", ...)`, entrando no desfazer.
  - Payload: cada clip ganha `transition?: { preset, params, dur, partner }`.
  - Timeline: faixa hachurada `.ff-transition` no começo da barra de B, com largura `dur` na escala da
    timeline. Clique seleciona B e rola o inspetor até "Transição".
  - Inspetor (clip selecionado com A adjacente ou transição existente): seção "Transição" com lista de
    presets (com prévia GIF, componente do EDT-55), `dur` numérico (padrão 0.5) e `dir` quando o preset
    aceitar.
- `docs/transitions.md` reescrito para `data-transition`. A curva `cubic-bezier(0.65, 0, 0.35, 1)` sai (sem
  substituto em CSS: o exemplo novo usa `vaivem`).

#### Spec

- `docs/contract.md`:
  - §7b.10: representação, validação, presets por referência a `docs/motion.md`, empilhamento, e o efeito
    de que transição encurta a duração total em `d` (B e tudo que referencia B andam d para trás);
  - §9d: endpoint de transição.
- `docs/transitions.md`.
- `PROVENANCE.md`, Registro: `| <data> | transições próprias por data-transition; curva de terceiros removida de docs/transitions.md (EDT-54) |`.

#### Passos

1. Contract: presets de transição, validação de parceiro, trilhas em A e B.
2. Miniaturas de transição: cena com dois cartões de cores diferentes, via o script do EDT-51.
3. `applyTransition` + `EditError` codes `E_TRANSITION_GAP`.
4. Servidor: rota e payload (ver os conflitos em "Ordem e paralelismo").
5. UI: faixa na barra e seção no inspetor (em `packages/cli/src/studio/motion.js`, ver EDT-55).
6. Docs.

#### Testes

- `motion.test.ts`:
  - A (0–3 s) e B `data-start="a - 0.5"` com `dissolver` → B opacity 0@0 e 1@0.5;
  - `empurrar` → A x 0@2.5 e −100%@3; B x 100%@0 e 0@0.5;
  - B com `data-start="2.5"` → `E_TRANSITION_PARTNER`;
  - B com `data-start="a + 0.5"` → `E_TRANSITION_PARTNER`;
  - d = 4 → `E_MOTION_OUT_OF_RANGE`;
  - `dur=1` na transição → `E_MOTION_PARAM`;
  - `empurrar` + `data-exit="partir-esquerda"` em A → `E_MOTION_OVERLAP`.
- `edit.test.ts`:
  - `applyTransition` em clips adjacentes grava os dois atributos;
  - de novo com outro `dur` só muda o deslocamento;
  - `preset: null` volta a adjacente;
  - B com vão antes → `E_TRANSITION_GAP`;
  - o resultado passa em `loadComposition`.
- `studio-server.test.ts`:
  - `POST /api/clips/b/transition` → 200, o arquivo muda e `/api/undo` volta ao anterior;
  - corpo inválido (`dur` −1) → 400 com código.
- `packages/producer/test/motion-transition.test.ts` (Chrome):
  - cada um dos 5 presets, frame no meio da transição, diferente dos frames de só A e só B;
  - hash por frame em ordem, repetido e invertido.

#### Verificação manual

- No Studio, dois clips encostados: escolher "Dissolver", ver a faixa hachurada, mudar a duração, desfazer.
- `render` e assistir.

#### Arquivos tocados

- contract: `presets.ts`, `tracks.ts`, `errors.ts`;
- producer: `edit.ts`;
- `packages/cli/src/studio-server.ts`, `packages/cli/src/studio/{motion.js,app.js,style.css}`;
- `docs/contract.md`, `docs/transitions.md`, `docs/motion.md`, `PROVENANCE.md`;
- `catalog/motion/thumbs/` (5 GIFs);
- testes.

#### Dependências

- Parte de contrato: EDT-51.
- Parte de Studio: EDT-55 (componente de lista com prévia).

#### Riscos

- Transição muda tempos de tudo que depende de B; o usuário pode estranhar. A spec documenta, e o Studio
  mostra o total novo.
- Duplicar B (EDT-43) copia `data-transition` com referência a A, e a cópia fica sem parceiro adjacente →
  `E_TRANSITION_PARTNER` no save. Combine com o plano do Studio (ver o fim).

---

### EDT-55: Inspetor de presets no Studio

#### Desenho

- Servidor (`packages/cli/src/studio-server.ts`):
  - `GET /api/motion/presets` →
    `{ enter: [...], exit: [...], emphasis: [...], camera: [...], transition: [...] }`; cada item é
    `{ name, label, dur, curve, keys: { <chave>: { type, default, min?, max?, values? } } }`, a partir de
    `listPresets()` do contract;
  - `GET /__ff_motion/<nome>.gif` → arquivo de `motionThumbPath(nome)`, `image/gif` (acrescente `.gif` em
    `MIME`); nome fora da lista → 404;
  - `STUDIO_FILES` ganha `"/motion.js": "motion.js"` e, se ainda não estiver lá, `"/timeline-math.js"`;
  - `compositionPayload()`: cada clip ganha `motion: { enter?, exit?, emphasis?, camera?, split? }`, cada
    um `{ preset, params }` do `RawMotionTarget` ordinal 0 (texto bruto também em `raw`).
- Escrita: escolher um preset usa a rota existente `POST /api/clips/<id>` com
  `{ attributes: { "data-enter": "<texto>" | null } }`. Ela já valida (`validated`) e entra no histórico.
  Nenhuma rota nova de escrita.
- Cliente: novo `packages/cli/src/studio/motion.js`, módulo ESM sem estado global, no padrão de
  `timeline-math.js`.
  - Funções puras, testáveis no Node:
    - `formatMotionAttr(preset, params)`: ordem `dur`, `at`, `curve`, depois as demais em ordem
      alfabética; omite valor igual ao padrão;
    - `swapPreset(current, nextPreset, presets)`: mantém `dur`, `at` e `curve` e descarta chaves que o novo
      preset não aceita.
  - Funções de DOM, que recebem os elementos por parâmetro:
    - `renderMotionSection(container, clip, presets, onChange)`;
    - `createPresetPicker(kind, presets, value, onPick)`.
- Componente de escolha:
  - botão com o label atual que abre uma lista `role="listbox"`; itens `role="option"`, primeiro
    "Nenhum";
  - `mouseenter` ou destaque por teclado (setas) mostra num popover fixo a
    `<img src="/__ff_motion/<nome>.gif">` (prévia ao passar o mouse);
  - Enter ou clique escolhe; Esc fecha. Não use `<select>`, porque `<select>` não dá prévia ao passar o mouse.
- Seção "Movimento" no inspetor: linhas Entrada, Saída e Ênfase (e Câmera se `tag` for img/video). Cada linha
  tem o picker e dois campos, `dur` e `curve` (texto, validado no servidor).
  - Mudança → `queuePatch(id, { "data-enter": formatMotionAttr(...) })`.
  - Erro do servidor (`E_CONTRACT_INVALID` com diagnósticos) aparece na área de erro existente do inspetor
    com o `hint` do diagnóstico.
- `app.js`: o carregamento passa para `<script type="module" src="/app.js">` em `index.html`, e `app.js`
  faz `import { ... } from "./motion.js"`. O IIFE atual continua dentro do módulo.
  Ganchos mínimos:
  - em `normalizeClip`, copiar `motion` e `keyframes`;
  - em `fillInspector`, chamar `renderMotionSection`;
  - buscar `/api/motion/presets` uma vez no início.
  - Nada mais em `app.js`.

#### Spec

`docs/contract.md` §9d: rotas `GET /api/motion/presets` e `/__ff_motion/`, e "escolher preset grava o
atributo validado e entra no desfazer".

#### Passos

1. Servidor: rotas, MIME, payload, `STUDIO_FILES`.
2. `motion.js`: puras e depois DOM.
3. `index.html` (módulo), `app.js` (ganchos), `style.css` (lista, popover).
4. Testes.

#### Testes

- `packages/cli/test/studio-motion.test.ts`, padrão de `studio-server.test.ts`:
  - `GET /api/motion/presets` tem os 12/8/6 (+5 câmera, +5 transição se já existirem), cada um com `label`;
  - `GET /__ff_motion/subir.gif` → 200 `image/gif`; `/__ff_motion/../x.gif` e `/__ff_motion/naoexiste.gif` →
    404;
  - `POST /api/clips/<id>` com `data-enter: "subir dur=0.7"` → 200, o arquivo contém o atributo, e
    `/api/undo` remove;
  - `data-enter: "voar"` → 4xx com diagnóstico `E_MOTION_PRESET_UNKNOWN` e o arquivo intacto;
  - `GET /api/composition` traz `motion.enter.preset === "subir"`.
- `packages/cli/test/studio-motion-math.test.ts`:
  - `formatMotionAttr("subir", {dur:"0.6"})` → `"subir"` (padrão omitido);
  - `{dur:"0.8", distance:"40px"}` → `"subir dur=0.8 distance=40px"`;
  - `swapPreset` de `"subir dur=0.8 distance=40px"` para `"crescer"` → `"crescer dur=0.8"`.

#### Verificação manual

- `studio` num projeto de exemplo: passar o mouse pela lista anima a prévia.
- Escolher "Subir" atualiza o preview.
- Ctrl+Z volta.
- Digitar curva inválida mostra o hint.

#### Arquivos tocados

- `packages/cli/src/studio-server.ts`;
- `packages/cli/src/studio/{motion.js (novo), app.js, index.html, style.css}`;
- `docs/contract.md`, testes.

#### Dependências

EDT-51 (presets e GIFs), EDT-53 e EDT-54 (só para as linhas de câmera e transição; sem elas a seção
mostra só entrada, saída e ênfase).

#### Riscos

- A mudança de `app.js` para módulo conflita com o plano do Studio (ver o fim).
- Prévia em GIF não reflete `dur`/`curve` personalizados. Aceito: a prévia é do preset padrão, e o preview
  real mostra o resultado.

---

### EDT-47: Keyframes no Studio (visuais e volume)

#### Desenho

- Edição pura em `packages/producer/src/keyframes-edit.ts`:
  `editKeyframes(source: string, request: KeyframeRequest): string`, com

  ```ts
  type KeyframeRequest =
    | { clipId: string; op: "add"; time: number; prop: MotionProp | "volume"; value?: MotionValue; curve?: string }
    | { clipId: string; op: "move"; time: number; to: number }
    | { clipId: string; op: "remove"; time: number; prop?: MotionProp | "volume" }
    | { clipId: string; op: "edit"; time: number; prop?: MotionProp | "volume"; value?: MotionValue; curve?: string | null };
  ```

  - `time` é local ao clip (s), arredondado a ms; casa pontos existentes com tolerância 0.0005.
  - `add`:
    - sem `value`, usa o valor corrente: `sampleTracks` (nova função do contract em `tracks.ts`, que avalia
      a trilha resolvida num tempo) ou o neutro;
    - para volume, a interpolação linear dos pontos ou `data-volume`;
    - se já houver ponto no tempo, acrescenta a propriedade nele.
  - `move` leva o ponto inteiro (todas as propriedades).
  - `remove` sem `prop` apaga o ponto; com `prop`, apaga a propriedade, e o ponto se ficar vazio.
  - `edit` muda valor e/ou curva (`curve: null` remove a curva).
  - Erros (`EditError`):
    - `E_KEYFRAME_NOT_FOUND`;
    - `E_KEYFRAME_EXISTS` (`move` para tempo ocupado);
    - `E_KEYFRAME_PROP` (propriedade desconhecida, `volume` em clip sem áudio, `zoom`/`focus*` fora de img/video);
    - `E_KEYFRAME_OUT_OF_RANGE` (time < 0 ou > D).
  - Serialização canônica do atributo: pontos ordenados por `time`; chaves na ordem `time, volume, opacity,
    x, y, scale, scaleX, scaleY, rotate, blur, clip, zoom, focusX, focusY, curve`; `JSON.stringify` sem
    espaços; escrita por `applyPatches`.
  - Só o clip (alvo ordinal 0) é editável pelo Studio. Keyframes de descendentes aparecem como somente
    leitura (marcas cinzas).
- Servidor:
  - `POST /api/clips/<id>/keyframes` com `KeyframeRequest` sem `clipId`;
  - `validated()` e depois `commit("keyframe", ...)`;
  - `400` com o código para `EditError`; `422`/`E_CONTRACT_INVALID` com diagnósticos (ex.:
    `E_MOTION_OVERLAP` com preset), no padrão das outras rotas.
  - O payload do clip ganha `keyframes: Array<{ time, ...props, curve? }>`, a lista crua mesclada
    (volume + visual) do ordinal 0.
- UI (`motion.js`, mais ganchos em `app.js`):
  - **Marcas**: um losango (quadrado 8 px girado em CSS) por `time` distinto, posicionado com a **mesma
    função tempo→x** da timeline, `decorateBar(bar, clip, timeToX)`. Selecionado = destacado.
  - **Adicionar**: na seção "Keyframes" do inspetor, um seletor de propriedade (Opacidade, Posição X,
    Posição Y, Escala, Rotação, Desfoque, Recorte, Volume, e Zoom, Foco X e Foco Y para img/video) e o botão
    "Adicionar no playhead"; atalho `K` repete a última propriedade. `time = playhead − clip.start`
    (absoluto → local); fora do clip, o botão fica desabilitado.
  - **Mover**: arrastar a marca, com encaixe no frame (`roundToFrame` de `timeline-math.js`); no
    `pointerup`, `op: "move"`.
  - **Remover**: Delete/Backspace com marca selecionada manda `op: "remove"` e **não** apaga o clip.
    Precedência sobre EDT-41. Também há um botão "Remover" no inspetor.
  - **Editar**: com a marca selecionada, o inspetor lista as propriedades daquele ponto com campo de valor
    e campo de curva (texto com sugestões: linear, suave, freio, arranque, vaivem, mola, mola-firme);
    mudança → `op: "edit"`.
  - Estado novo em `app.js`: `state.selectedKeyframe = { clipId, time } | null`, limpo ao trocar de clip.
  - Desfazer: vem do `commit`; depois de undo/redo, se o ponto selecionado sumiu, limpa a seleção.

#### Spec

`docs/contract.md` §9d: rota de keyframes, operações, códigos, "keyframes de descendentes são somente
leitura no Studio".

#### Passos

1. `sampleTracks(target, time)` no contract (`tracks.ts`), com teste.
2. `keyframes-edit.ts` e testes.
3. Rota e payload no servidor.
4. `motion.js`: `keyframeMarks(clip, timeToX)` (pura: posições) e `renderKeyframeSection`.
5. Ganchos em `app.js`: `decorateBar`, teclado, estado.
6. `style.css`.

#### Testes

- `packages/producer/test/keyframes-edit.test.ts` (rápido; em `FAST_TESTS`):
  - `add` opacity em 1.0 num clip sem keyframes → `data-keyframes='[{"time":1,"opacity":1}]'` (neutro);
  - `add` com `data-enter="surgir"` em 0.25 → valor amostrado ≈ `evaluateCurve` (±0.001);
  - `add` volume num clip com `[{"time":0,"volume":1}]` → o mesmo array mais o ponto novo;
  - `audio.ts` gera a mesma expressão para os pontos de volume (compare `keyframeExpression` antes e depois
    de um `add` visual: igual);
  - `move` para tempo ocupado → `E_KEYFRAME_EXISTS`;
  - `remove` da última propriedade remove o atributo inteiro;
  - `edit curve:"mola"` num trecho curto → o resultado falha em `loadComposition` com `E_CURVE_INVALID`
    (a função não valida, o servidor sim);
  - `volume` num `<div>` → `E_KEYFRAME_PROP`;
  - a serialização é estável: `add` e depois `remove` devolvem a string original byte a byte quando ela já
    era canônica.
- `studio-motion.test.ts`:
  - `POST .../keyframes {op:"add", time:1, prop:"opacity", value:0.5}` → 200 e payload com o ponto;
  - `/api/undo` volta;
  - `op:"add"` que sobrepõe o preset → 4xx com `E_MOTION_OVERLAP`, arquivo intacto, nenhuma versão nova
    no histórico.
- `studio-motion-math.test.ts`: `keyframeMarks` junta propriedades no mesmo tempo numa marca só e usa o
  `timeToX` recebido (teste com uma função de escala 2×).

#### Verificação manual

- No Studio:
  - adicionar opacidade em dois tempos, mudar a curva para `mola`, ver no preview;
  - arrastar a marca;
  - Delete remove o keyframe e não o clip;
  - Ctrl+Z desfaz cada passo;
  - volume com keyframes muda o áudio no preview (depende do EDT-40).

#### Arquivos tocados

- contract: `motion/tracks.ts`, `index.ts`;
- producer: `keyframes-edit.ts` (novo), `edit.ts` (só o tipo de `EditError`);
- `packages/cli/src/studio-server.ts`, `packages/cli/src/studio/{motion.js,app.js,style.css}`;
- `docs/contract.md`, `scripts/ci.ts`, testes.

#### Dependências

EDT-50 e EDT-55 (seção do inspetor, `motion.js` e o carregamento como módulo).

#### Riscos

- **[PARAR SE]** `applyPatches` não escapar aspas em valor de atributo (JSON contém `"`). Se não escapar,
  é bug a corrigir em `edit.ts` com teste; avise antes de mexer.
- O mapeamento tempo→x depende do zoom do EDT-45 e da altura e linhas das faixas do EDT-44.

---

### EDT-56: Migrar os 48 blocos para atributos de motion

#### Desenho

- Migrar onde o CSS do bloco anima `opacity`, `transform: translate*/scale*/rotate`, `filter: blur()` ou
  `clip-path: inset()` com tempo finito.
  - De/para de 2 frames: preset quando o movimento bate **exatamente** com um da tabela (com `distance`/
    `amount`/`curve`/`at`); senão `data-keyframes` (percentuais do `@keyframes` viram pontos).
  - Curva preservada: `curve=cubic-bezier(...)` com os números atuais do bloco; nada de trocar por curva
    própria, para não mudar o visual.
  - Tempo: `at = animation-delay − data-start do clip` do alvo. Negativo é permitido só em `data-enter`;
    em keyframes, se negativo, fica em CSS.
- Fica em CSS: cor, `stroke-dash*`, `width`/`height`, `background-position`, contadores,
  `animation-iteration-count: infinite`, `steps()` e `transform` com `skew`/`matrix`.
- `@keyframes` sem uso são removidos.
- Transform composto: o `transform` estático do autor (ex.: `translate(-50%,-50%)` para centralizar)
  continua; o movimento vai para `translate` individual. A ordem muda: individual antes de `transform`.
  Para translações puras o resultado é igual; com rotação ou escala no `transform`, confira o PSNR.

#### Spec

- `skills/frankframes/SKILL.md`: troque as instruções de `animation-delay` absoluto (linhas ~60–65 e ~119–123)
  por atributos de motion; `node scripts/sync-skill.ts`.
- `catalog/README.md`, se citar CSS de animação.
- `docs/contract.md` não muda.

#### Passos

1. `scripts/generate-goldens.ts` ganha:
   - `--only <slug,slug>`: regenera só esses;
   - `--compare <slug,slug>`: captura, compara com os PNGs guardados e imprime PSNR por frame, sem gravar.
   Reaproveite o `psnr` de `goldens.test.ts`, movido para `packages/producer/src/goldens.ts` e importado
   pelos dois.
2. Inventário: `grep -l "@keyframes" catalog/blocks/*/index.html` e, para cada bloco, a lista das animações
   migráveis. Guarde no scratchpad; não versione.
3. Por bloco:
   1. edite;
   2. `node packages/cli/src/cli.ts lint catalog/blocks/<slug>/index.html --json` → `ok`;
   3. `node scripts/generate-goldens.ts --compare <slug>`;
   4. todo frame ≥ 45 dB passa; abaixo disso, abra o PNG novo e o antigo lado a lado, corrija ou justifique.
4. No fim:
   - `node scripts/generate-goldens.ts --only <migrados>`;
   - `node scripts/generate-thumbs.ts`;
   - `node scripts/generate-catalog.ts` (sha256 do `meta.json`).
5. SKILL e sync.
6. No resumo do diff, uma tabela com bloco, animações migradas, o que ficou em CSS e o PSNR mínimo antes de
   regenerar. É a revisão dos goldens que o planejador faz.

#### Testes

- `goldens.test.ts`, `catalog.test.ts` e `thumbs.test.ts` verdes depois da regeneração.
- Teste novo em `catalog.test.ts`: todo bloco migrado (lista no teste) tem pelo menos um atributo de motion
  e `loadComposition` dele é `ok`.
- `node scripts/ci.ts` completo verde (o item mexe em goldens; o `--fast` não basta).

#### Verificação manual

- `node packages/cli/src/cli.ts blocks` + `render` de 4 blocos migrados (dois 16:9, dois 9:16), assistidos
  contra o MP4 de antes (render feito antes de migrar, guardado no scratchpad).

#### Arquivos tocados

- `catalog/blocks/*/index.html`, `meta.json`, `thumb.png`;
- `catalog/goldens.json`, `catalog/goldens/**`;
- `scripts/generate-goldens.ts`, `packages/producer/src/goldens.ts`, `packages/catalog/test/goldens.test.ts`;
- `skills/frankframes/SKILL.md`, `packages/cli/skill/SKILL.md`, testes.

#### Dependências

EDT-49, 50, 51, 52 (blocos de texto que hoje animam por palavra com spans manuais podem usar `data-split`
com `data-unit`), 53 e 54. Último item do épico.

#### Riscos

- Goldens trocados escondem regressão. Por isso: `--compare` antes, limiar de 45 dB e tabela no resumo.
- Bloco com `animation-delay` menor que `data-start` (ex.: lower-third, delay 0.18 com start 0.25) dá `at`
  negativo. Em `data-enter` é permitido; confira que o primeiro frame visível continua igual.
- Curvas de blocos existentes podem coincidir com curvas conhecidas de terceiros. Não é escopo deste item
  trocá-las (mudaria o visual). Liste as suspeitas no resumo para o titular decidir.

---

### Ordem e paralelismo

#### Sequência

1. **EDT-49**: base (contract, producer, engine).
2. **EDT-50**: keyframes e spring.
3. **EDT-51**: presets, miniaturas, `docs/motion.md`, SKILL.
4. **EDT-52**: split e legendas.
5. **EDT-53**: câmera e shim.
6. **EDT-54 (contrato)**: presets de transição, validação, miniaturas, `docs/transitions.md`.
7. **EDT-55**: inspetor de presets (primeiro item que toca o Studio).
8. **EDT-54 (Studio)**: endpoint, faixa hachurada e seção "Transição".
9. **EDT-47**: keyframes no Studio.
10. **EDT-56**: migração dos blocos (pede `ci.ts` completo).

#### Paralelismo dentro do épico

- 51, 52, 53 e 54 (contrato) mexem todos em `presets.ts`, `tracks.ts`, `docs/motion.md`,
  `generate-motion-thumbs.ts` e no teste de órfãos. Faça-os **em série**.
- Se o titular quiser paralelizar, a única dupla segura é 52 ∥ 53, e só depois de 51, com `presets.ts`
  dividido em `presets/{entrada-saida,camera,transicao}.ts` antes de abrir os dois.
- 55 e 47 tocam os mesmos arquivos do Studio: em série.

#### Conflitos com o plano do Studio (EDT-39..46, outro planejador)

| Arquivo / ponto | Itens deste plano | Itens do Studio | Como resolver |
|---|---|---|---|
| `studio/index.html`: `<script>` de `app.js` vira `type="module"` | 55 | 39 (se já ligou `timeline-math.js`) | **Resolvido no EDT-39** (commit f773dba): `app.js` já é módulo e importa `/timeline-math.js`. O EDT-55 só importa. |
| `studio-server.ts` `STUDIO_FILES`, `MIME`, rotas, `compositionPayload()` | 55, 54, 47 | 40, 44, 45, 46 | Mudanças aditivas; aplicar em cima da versão mais nova; nenhum renomeio. |
| `app.js` teclado (Delete/Backspace) | 47 | 41 | Keyframe selecionado tem precedência sobre apagar clip. O handler do EDT-41 precisa checar `state.selectedKeyframe` antes; combinar a ordem. |
| `app.js` mapeamento tempo→x e geometria da barra | 47, 54 | 44 (faixas), 45 (zoom) | Marcas e faixa de transição usam a função de escala da timeline, nunca `px/s` próprio. Se 45 ainda não existe, use a escala atual por parâmetro (`decorateBar(bar, clip, timeToX)`). |
| `app.js` arraste da borda esquerda | — | 42 | Aparar à esquerda move o início do conteúdo: os `time` de `data-keyframes` (volume e visual) precisam deslocar −Δ e descartar < 0. Pedir ao EDT-42 ou fazer junto do EDT-47 (decisão do planejador). |
| copiar, colar e duplicar | — | 43 | A cópia leva os atributos de motion (texto). Cópia de clip com `data-transition` fica sem parceiro → `E_TRANSITION_PARTNER`. Sugestão para o EDT-43: remover `data-transition` e normalizar `data-start` na cópia. |
| automação de volume no preview | 47 | 40 | **Resolvido no EDT-40** (commit 379d6c6): o mix usa `clip.keyframes` do contrato, nunca o atributo cru. O EDT-50 precisa manter `clip.keyframes` só com os pontos de volume. |
| `edit.ts` (`splitClip`, `EditError`) | 49, 54, 47 | 42, 43 | Aditivo: códigos novos numa união; a recusa de split com motion vem do EDT-49. |
| exportar MP4 | — | 46 | A falha `E_MOTION_RUNTIME` precisa aparecer na UI de exportação como os outros códigos de `RENDER_ERROR_CODES`. |
| `docs/contract.md` §9d | 49, 54, 55, 47 | 39–46 | Parágrafos novos no fim de §9d; não reescrever os existentes. |

Regra para o executor: antes de tocar `app.js`, `studio-server.ts`, `index.html` ou `style.css`, confira se
há mudanças não commitadas ou recentes do outro plano. Se houver conflito real, que não seja só aditivo, pare
e devolva ao planejamento.

---

## Plano — Geração (EDT-57) e Versão 1.0 (EDT-60)

Escopo: EDT-58, EDT-59, EDT-61, EDT-62, EDT-63 (só esboço, pós-1.0), EDT-64, EDT-65.
Planejador: Opus 5.5. Executor: Sonnet 5.5, que só tem este texto e o repositório.

Regras que valem para todos os itens (repetidas porque o executor não tem outro contexto):
`.omp/RULES.md` e `.omp/AGENTS.md` mandam. Spec/docs no mesmo trabalho da mudança. Erros com código
`E_*` estável e `hint`. Nada de catch vazio, fallback silencioso ou retry cego. Teste `node:test` que
falharia sem a mudança; teste que precisa de Chrome/FFmpeg faz `t.skip("motivo")` explícito quando o
binário não existe. Ao terminar cada item: `node scripts/ci.ts --fast` e os testes do pacote tocado.
Sem commit, push ou Jira. GitHub Actions proibido. Nada de GPL/GSAP/código alheio.

### Fatos levantados no código (base para as decisões)

| Fato | Onde | Consequência |
|---|---|---|
| `parseCli` aceita só 1 positional depois do comando e rejeita flag desconhecida | `packages/cli/src/cli.ts:75` | comandos novos com flags próprias entram por despacho antecipado, antes do `parseCli` (menos conflito entre executores paralelos) |
| `blocks publish` já gera diretório estático (`index.json` + `<slug>/{index.html,meta.json,thumb.png}`); `blocks add <url>` já confere `sha256` do `meta.json` | `packages/cli/src/catalog-server.ts`, `packages/catalog/src/remote.ts` | EDT-63 é incremento pequeno; hash vem do mesmo host que o HTML (protege corrupção, não host malicioso) |
| `seekFrame` já chama `settle()` e `capture()` chama `settlePaint()` de novo quando `required === 1` | `packages/engine/src/capture.ts:142-185`, `clock.ts:176` | candidato forte de otimização (2 rAF + setTimeout redundantes por frame) — só depois de medir |
| `settlePaint` tem teto de 80 ms se o rAF não disparar | `packages/engine/src/clock.ts:186` | se a medição mostrar ~80 ms por settle, o rAF não está disparando e esse é o gargalo |
| `preset` só muda o encode (`svtPreset` 10/8/6, `crf` 42/32/26); captura é igual nos 3 | `packages/encode/src/policy.ts:42` | "por preset" = tempo total; fps de captura é um número por modo de GPU |
| Captura grava PNG em disco e o encode só começa depois da captura inteira | `packages/producer/src/render.ts` | encode em streaming é hipótese de ganho grande em `standard`/`high` |
| `extractFramesCached` faz `rm(dir)` e extrai no diretório final; `evictCache` pode apagar diretório em uso | `packages/engine/src/cache.ts:80-108` | corrida em lote com o mesmo vídeo em dois jobs — corrigir no EDT-61 |
| Node 24.14.1 recusa TypeScript dentro de `node_modules` (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`) — verificado nesta máquina | — | **os pacotes atuais (exports para `src/*.ts`) não funcionam instalados**; a 1.0 precisa de JS compilado |
| `@frankframes/cli` importa `engine`, `encode`, `producer` sem declarar; não tem `files`/`engines`; `@frankframes/catalog` aponta para `../../../catalog/blocks/`, fora do pacote | `packages/*/package.json`, `packages/catalog/src/index.ts:16` | pacote atual não é instalável; release precisa de layout próprio |
| `puppeteer-core` (Apache-2.0) e dependências transitivas não estão em `THIRD-PARTY-NOTICES.md` nem em `PROVENANCE.md` | — | EDT-65 |
| Codex CLI 0.170.0 em `%APPDATA%\npm\codex.cmd` (shim que chama `node_modules\@openai\codex\bin\codex.js`); `codex exec` tem `--output-schema`, `-o`, `-C`, `--ephemeral`, `-s read-only`, `--ignore-user-config`, prompt por stdin com `-`; `codex login status` → "Logged in using ChatGPT", exit 0 | — | EDT-59 |
| Vídeo do titular: H.264 1920×1080 24 fps, 68,164583 s, AAC estéreo 48 kHz, 155 MB | `C:\Users\rober\Downloads\A001_11181126_H685.MOV` | EDT-64 |
| Vídeo de teste do titular: H.264 1080×1920 30 fps, 8,08 s, AAC estéreo 44,1 kHz, 10 MB | `C:\Users\rober\Downloads\video-teste.mp4` | testes com vídeo real de qualquer item |
| `preview --open` usa `exec('start "<url>"')`: no Windows o primeiro argumento entre aspas vira título da janela, não abre o navegador | `packages/cli/src/cli.ts:440` | o `generate` usa `spawn("cmd", ["/c","start","",url])`; corrigir o preview junto (1 linha) |
| `<style>` de sub-composição externa é içado para o `<head>` sem escopo | `packages/producer/src/compile.ts:80` | composição gerada é **um arquivo só**, com CSS prefixado por cena (padrão de `examples/cena-dupla`) |

---

#### EDT-58 — Skill de geração: pedido em texto até MP4 conferido

- **Desenho**:
  - Skill nova e separada da atual: `skills/frankframes-generate/SKILL.md` (nome `frankframes-generate`).
    A skill atual (`skills/frankframes/SKILL.md`) continua sendo a referência do contrato; a nova é o
    roteiro de produção. A mesma skill é o contexto que o `frankframes generate` (EDT-59) entrega ao
    Codex — uma fonte só, nada duplicado no código.
  - Comando novo `frankframes frames <video.mp4|.webm> [--at 10%,50%,90%|1.5,3] [-o dir] [--json]`,
    necessário para "conferir frames-chave" sem o agente improvisar FFmpeg. Extrai PNG de cada instante
    e calcula estatística de luma numa miniatura 64×36 cinza (sem dependência nova: FFmpeg devolve
    `rawvideo` gray, o JS calcula média e desvio). Saída `--json`:
    `{"file":"…","durationSeconds":4,"frames":[{"t":2,"png":"out/frames/x/t-2000.png","meanLuma":41.2,"stdLuma":18.7,"uniform":false}]}`.
    `uniform = stdLuma < 2` (frame chapado: tela preta, fundo sem texto). Códigos: `E_FRAMES_INPUT`
    (arquivo ausente ou ilegível; hint "renderize antes: `frankframes render … --preset draft`"),
    `E_FRAMES_TIME` (instante fora de `[0, duração)` ou forma inválida; hint "use segundos ou
    porcentagem, ex. `--at 10%,2.5`"). Padrão `--at 10%,50%,90%`, `-o out/frames/<nome>/`.
  - `blocks index --json` ganha `width`/`height` por bloco (lidos com `loadComposition` do HTML), para
    a skill e o Codex escolherem 16:9 × 9:16 sem adivinhar pelo slug.
  - Instalação: `scripts/sync-skill.ts` passa a copiar **todas** as pastas de `skills/` para
    `packages/cli/skill/<nome>/`; `frankframes skill install` instala as duas
    (`.claude/skills/<nome>/SKILL.md`; Cursor: `.cursor/rules/<nome>.mdc`).
  - Conteúdo da skill (texto próprio, em português; nada copiado de outra skill/framework):
    1. Decidir formato (16:9 = 1920×1080, 9:16 = 1080×1920, 1:1 = 1080×1080), fps 30, duração
       (pedido explícito ou soma das cenas), tom.
    2. Escolher blocos: `frankframes blocks index --json`, filtrar por `width/height`, `tags`,
       `durationSeconds`; ler o HTML dos escolhidos (`catalog/blocks/<slug>/index.html`).
    3. Montar **um arquivo**: cada cena é um clip `data-clip-id="cena-N"` com `data-duration`,
       encadeado por `data-start="cena-(N-1)"`; CSS prefixado por cena (`.cena-1 .titulo`), nomes de
       `@keyframes` únicos por cena; textos do pedido no lugar dos textos do bloco, respeitando o
       comprimento que o layout comporta.
    4. Animação: seção "Movimento" — até o EDT-49/51 fechar, `animation-delay` igual ao início absoluto
       da cena (regra atual da skill); depois, os atributos de motion e a lista de presets (passo 9).
    5. Laço: `frankframes lint x.html --json` até `ok: true`, no máximo 5 voltas; tabela código → correção
       (`E_NO_ROOT`, `E_DUPLICATE_ID`, `E_REF_UNKNOWN`, `E_REF_CYCLE`, `E_START_INVALID`,
       `E_DURATION_UNRESOLVED`, `E_FPS_INVALID`, `E_SIZE_INVALID`) tirada de
       `packages/contract/src/errors.ts` e `docs/reference/diagnostics.md`.
    6. `frankframes render x.html -o out/x-draft.mp4 --preset draft --json`.
    7. `frankframes frames out/x-draft.mp4 --json`: nenhum `uniform: true` fora de cena
       intencionalmente chapada; abrir os PNGs e conferir com o pedido (texto legível, nada cortado,
       área segura no 9:16).
    8. Entregar: caminho do HTML e do MP4, duração, blocos usados; render final `--preset standard` só
       se pedido.
    9. Proibições: `<script>`, URL externa, GSAP, `data-media-start`, fonte fora do catálogo.
- **Spec/docs**: `docs/getting-started.md` ganha seção "Conferir frames" (`frames`) e "Skills"
  (as duas skills, `skill install`). `docs/contract.md` não muda. HELP do `cli.ts` lista `frames`.
- **Passos**:
  1. `packages/producer/src/frames.ts`: `parseFrameTimes(spec: string, durationSeconds: number): number[]`
     (pura; `%` relativo à duração; ordena e deduplica; lança `FramesError("E_FRAMES_TIME")`) e
     `inspectFrames({ffmpeg, ffprobe, input, times, outDir}): Promise<FrameStat[]>` — duração via
     `probeDuration` do engine; por instante, `ffmpeg -ss t -i in -frames:v 1 -y <png>` e
     `ffmpeg -ss t -i in -frames:v 1 -vf scale=64:36,format=gray -f rawvideo -` (stdout `Buffer` de
     2304 bytes; tamanho diferente → `E_FRAMES_INPUT`). Exportar em `packages/producer/src/index.ts`.
     `FramesError` com `code` e `hint`.
  2. `packages/cli/src/frames-command.ts`: `runFramesCommand(argv: string[]): Promise<number>` com parser
     próprio (`--at`, `-o`, `--json`), usa `resolveFfmpeg()`; imprime texto ou JSON; erro → `erro <code>: msg\n  → hint`, exit 1.
  3. `cli.ts`: no topo de `main()`, antes de `parseCli`: `if (argv[0] === "frames") { process.exitCode = await runFramesCommand(argv.slice(1)); return; }`. Atualizar `HELP`.
  4. `catalog-server.ts`: `CatalogEntry` ganha `width: number; height: number` (de `loadComposition(html)`;
     bloco sem dimensão → erro alto `"<slug>: bloco sem data-width/data-height"`). Atualizar a saída
     texto de `blocks index` com `WxH`.
  5. Escrever `skills/frankframes-generate/SKILL.md` (frontmatter `name`/`description`) com as seções
     do desenho, menos o conteúdo de motion (deixar a seção 4 com a regra atual e um marcador
     `<!-- motion: EDT-49/51 -->` que o passo 9 substitui).
  6. `scripts/sync-skill.ts`: copiar recursivamente `skills/<nome>/` → `packages/cli/skill/<nome>/`,
     apagando o que não existe mais na fonte; mover `packages/cli/skill/SKILL.md` para
     `packages/cli/skill/frankframes/SKILL.md`.
  7. `onboarding.ts`: `skillSource()` vira `skillSources(): Array<{name, file}>` (pacote:
     `../skill/<nome>/SKILL.md`; monorepo: `../../../skills/<nome>/SKILL.md`); `runSkillInstall`
     instala todas e imprime uma linha por skill.
  8. `skills/frankframes-generate/evals/pedidos.json`: os 5 pedidos de aceite, cada um com
     `{id, pedido, format, durationSeconds}`:
     (1) "abertura 16:9 de 6 s para o 'Relatório do 3º trimestre', subtítulo 'Resultados e próximos passos'";
     (2) "vertical 9:16 de 15 s com 3 dicas para gravar com o celular";
     (3) "gráfico de barras 16:9 de 10 s: vendas jan 120, fev 150, mar 90, abr 180, título 'Vendas 2026'";
     (4) "depoimento 16:9 de 12 s de 'Ana, cliente desde 2024' e chamada final 'Agende uma demo'";
     (5) "contagem regressiva vertical de 5 a 1 e assinatura 'FrankFrames', 8 s".
  9. **Depois do EDT-51**: substituir o marcador da seção 4 pela regra de motion e pela lista de presets
     (gerada do código da biblioteca de presets, não escrita à mão — usar a função de listagem que o
     EDT-51 criar; se não existir, pedir ao planejador).
  10. **Depois do EDT-59 e do passo 9**: `scripts/generate-eval.ts [--real] [--only id]`: sem `--real`
      sai com 2 e a mensagem "este script chama o Codex real; passe --real" (nunca roda no gate). Com
      `--real`, para cada pedido chama `runGenerate` (EDT-59) com `codexAgent`, `--no-studio`, e grava
      `out/generate-eval/<id>/` e `out/generate-eval/report.json`. Critério por pedido: `ok`,
      MP4 existe, duração do ffprobe = duração do lint ± 1 frame, `width/height` = formato pedido,
      duração = pedida ± 0,5 s, nenhum frame `uniform` em `10%,50%,90%`, e **nenhuma edição manual**.
  11. `node scripts/sync-skill.ts`.
- **Testes**:
  - `packages/producer/test/frames.test.ts`: `parseFrameTimes` (puro: `"10%,50%"` em 4 s → `[0.4, 2]`;
    `"5"` em 4 s → `E_FRAMES_TIME`; `"abc"` → `E_FRAMES_TIME`; duplicados somem). Com FFmpeg (skip
    explícito sem ele): gerar em tmp um vídeo de 2 s com `lavfi` (`color=black:s=320x180:d=1` seguido de
    `testsrc2=s=320x180:d=1`, `concat`, `-c:v libvpx-vp9` ou `mjpeg`) → `t=0.5` `uniform: true`,
    `t=1.5` `uniform: false`, PNG existe; arquivo inexistente → `E_FRAMES_INPUT`.
  - `packages/cli/test/frames-cli.test.ts`: spawn `cli.ts frames <inexistente> --json` → exit 1 e
    `E_FRAMES_INPUT` no stderr; com FFmpeg, saída JSON válida.
  - `packages/cli/test/skill-sync.test.ts`: passa a comparar **cada arquivo** de `skills/` com
    `packages/cli/skill/` (falha se a nova skill não for sincronizada).
  - `packages/cli/test/onboarding.test.ts`: `skill install` em tmp cria as duas `SKILL.md`.
  - `packages/cli/test/catalog-server.test.ts`: toda entrada tem `width`/`height` inteiros > 0.
- **Verificação manual**: `node packages/cli/src/cli.ts render examples/hello.html -o out/h.mp4 --preset draft`
  e `node packages/cli/src/cli.ts frames out/h.mp4 --json`; abrir os PNGs. Seguir a skill à mão em 1
  pedido. Aceite final do item = `node scripts/generate-eval.ts --real` com 5/5 (executado pelo
  planejador/titular, porque usa a conta ChatGPT).
- **Arquivos tocados**: `packages/producer/src/frames.ts` (novo), `packages/producer/src/index.ts`,
  `packages/cli/src/frames-command.ts` (novo), `packages/cli/src/cli.ts` (despacho + HELP),
  `packages/cli/src/catalog-server.ts`, `packages/cli/src/onboarding.ts`, `scripts/sync-skill.ts`,
  `scripts/generate-eval.ts` (novo), `skills/frankframes-generate/**` (novo),
  `packages/cli/skill/**`, testes citados, `docs/getting-started.md`.
- **Dependências**: passos 1–8 e 11 adiantam já (não dependem de motion nem de Studio). Passo 9
  depende do EDT-49/50/51 (outro planejador). Passo 10 depende do EDT-59 e do passo 9.
- **Riscos**: skill longa demais vira ruído para o modelo — manter ≤ 250 linhas e mandar ler blocos sob
  demanda; o limiar `stdLuma < 2` pode marcar cena escura legítima (fica como aviso na skill, e no
  `generate` vira diagnóstico de reparo — ver EDT-59); mover `packages/cli/skill/SKILL.md` quebra quem
  dependia do caminho antigo (só `onboarding.ts` e o teste, ambos atualizados).

---

#### EDT-59 — Comando `frankframes generate` via Codex CLI (conta ChatGPT do titular)

- **Desenho**:
  - Uso: `frankframes generate "<pedido>" [-o <dir>] [--format 16:9|9:16|1:1] [--duration S]
    [--attempts N] [--model M] [--timeout S] [--project <dir>] [--no-render] [--no-studio] [--force]
    [--keep-context] [--json]`. Padrões: `-o out/gerado-<slug-do-pedido>`, `--format 16:9`, fps 30,
    `--attempts 3` (1 geração + 2 reparos; faixa 1–6), `--timeout 600` por chamada.
  - Agente injetável (é o que torna o teste possível sem o Codex real):
    ```ts
    interface GenerationAgent {
      readonly name: string;                       // "codex" ou "fake"
      check(): Promise<{ version: string }>;      // lança E_CODEX_MISSING / E_CODEX_AUTH
      run(input: { prompt: string; contextDir: string; schemaPath: string; timeoutMs: number; logPath: string }): Promise<string>; // última mensagem
    }
    ```
    `runGenerate(options & { agent })` só fala com essa interface. O CLI cria `codexAgent()`.
  - Descoberta do binário (`resolveCodex({ env, platform, pathExists })`, sem shell, nunca `shell: true`):
    1. `FRANKFRAMES_CODEX` definido → usa só ele. Inexistente → `E_CODEX_MISSING` (sem cair para o PATH).
       Se termina em `.js/.mjs/.cjs/.ts` → `{ command: process.execPath, args: [arquivo] }` (é assim que o
       teste injeta o codex falso pelo caminho real de spawn).
    2. Varre `PATH` (separador `path.delimiter`): no `win32`, em cada diretório, `codex.exe` e depois
       `codex.cmd` (ignora `codex.ps1` e o `codex` sem extensão, que é script sh); fora do Windows, `codex`
       executável.
    3. `codex.cmd` → não executa o `.cmd` (exigiria `cmd /c` e aspas do prompt): resolve
       `<dir>\node_modules\@openai\codex\bin\codex.js` e roda `node` (`<dir>\node.exe` se existir, senão
       `process.execPath`) com esse arquivo. `.cmd` sem o `codex.js` → `E_CODEX_MISSING` com hint
       "reinstale: `npm i -g @openai/codex`".
    4. Nada achado → `E_CODEX_MISSING`, hint "instale o Codex CLI (`npm i -g @openai/codex`) e rode
       `codex login`, ou aponte FRANKFRAMES_CODEX para o executável".
  - Autenticação: `codex login status`; exit 0 **e** stdout contém `Logged in using ChatGPT` → ok. Qualquer
    outra saída (deslogado, ou logado com chave de API) → `E_CODEX_AUTH`, hint "rode `codex login` e entre
    com a conta ChatGPT; o FrankFrames não usa chave de API". Versão via `codex --version` (vai no relatório).
  - Execução (uma chamada nova por tentativa, sem `resume`):
    `exec --ephemeral --skip-git-repo-check -s read-only --ignore-user-config --color never -C <contextDir>
    --output-schema <schemaPath> -o <lastMessagePath> [-m <model>] -`, prompt por **stdin** (o contexto
    passa de 8 KB, limite do `cmd`). Nunca passar `-i/--image`. `env` do filho = `process.env` **sem**
    `OPENAI_API_KEY`, `CODEX_API_KEY`, `GROQ_API_KEY` e qualquer `FRANKFRAMES_*` (o Codex não pode cair
    para chave de API nem ver segredo do projeto). `windowsHide: true`. stdout/stderr vão para
    `<out>/.generate/attempt-N.log`. Timeout/Ctrl+C: `taskkill /pid <pid> /T /F` no Windows (o `codex.js`
    abre um binário nativo filho que sobreviveria a `child.kill()`); fora dele, `detached: true` e
    `process.kill(-pid, "SIGKILL")`.
  - Schema de saída (arquivo escrito no `contextDir`; formato estrito exigido pela API de saída
    estruturada):
    `{"type":"object","additionalProperties":false,"required":["html","blocks","notes"],"properties":{"html":{"type":"string"},"blocks":{"type":"array","items":{"type":"string"}},"notes":{"type":"string"}}}`.
  - Contexto (só texto, em diretório temporário `ff-generate-*`, apagado no fim salvo `--keep-context`):
    `SKILL.md` (cópia de `skills/frankframes-generate/SKILL.md`), `contract.md` (cópia de
    `docs/contract.md`), `catalog/index.json` (`buildCatalogIndex()`, com `width/height` do EDT-58),
    `catalog/blocks/<slug>/index.html` (só HTML; **sem `thumb.png`**), `motion/presets.json` (depois do
    EDT-51), `project.json` quando `--project`: lista `{path, kind, durationSeconds}` dos arquivos de
    mídia do projeto — nomes e durações medidas localmente por `probeDuration`, **nunca os bytes**. Em
    reparo: `previous.html` e `diagnostics.json`. `-C <contextDir>` faz desse diretório a raiz do agente.
  - Prompt (`buildPrompt`): papel; pedido do usuário entre delimitadores (`<<<PEDIDO … PEDIDO>>>`,
    máx. 4000 caracteres → senão `E_GEN_REQUEST_INVALID`); formato exigido (`WxH`, 30 fps, duração);
    "siga SKILL.md, consulte contract.md e catalog/; não execute comandos que escrevam; devolva só o JSON
    do schema". Em reparo: "corrija previous.html; diagnósticos em diagnostics.json (mesmo formato do
    `frankframes lint --json`)" + resumo dos códigos no próprio prompt.
  - Laço por tentativa: (a) `agent.run` → parse do JSON (inválido/sem `html` → diagnóstico
    `E_CODEX_OUTPUT`, conta como tentativa); (b) `lintReport(html)` — **a mesma função** que passa a
    gerar o `lint --json`; (c) `checkGeneratedHtml(html, format)` → `E_GEN_FORBIDDEN` (`<script`,
    `http://`, `https://`, `//cdn`, `gsap`, `data-media-start`), `E_GEN_FORMAT_MISMATCH` (raiz ≠ `WxH`),
    `E_GEN_DURATION_MISMATCH` (|duração − pedida| > 0,5 s); (d) se ok e sem `--no-render`: grava
    `<out>/index.html`, `renderComposition` preset `draft` → `<out>/draft.mp4`; `RenderError` vira
    diagnóstico de reparo; (e) `inspectFrames` em `10%,50%,90%`; frame `uniform` → diagnóstico
    `W_GEN_FRAME_BLANK` com o instante (texto, não imagem) e conta como reparo **uma vez**; se persistir,
    entrega com aviso. Esgotou tentativas → `E_GEN_EXHAUSTED`, hint "veja <out>/.generate/attempt-N.html
    e os diagnósticos; corrija com `frankframes lint` ou rode de novo com --attempts"; `index.html`
    **não** é gravado nesse caso (nada "quase certo" no lugar do resultado).
  - Saída: `<out>/index.html`, `<out>/draft.mp4`, `<out>/.generate/attempt-N.{html,log}`,
    `<out>/generate.json`:
    `{"ok":true,"request":"…","format":{"width":1920,"height":1080,"fps":30},"agent":{"name":"codex","version":"codex-cli 0.170.0"},"attempts":[{"n":1,"ms":41000,"ok":false,"diagnostics":[{"code":"E_REF_UNKNOWN","severity":"error","clipId":"cena-2","message":"…"}]}],"entry":"…/index.html","render":{"outPath":"…/draft.mp4","frames":180,"durationSeconds":6},"frames":[{"t":0.6,"uniform":false,"meanLuma":40.1}],"studio":"http://127.0.0.1:5xxxx/"}`.
    `--json` imprime esse objeto. `<out>/index.html` já existente → `E_GEN_OUT_EXISTS` (hint `--force`).
  - Depois do render, sem `--no-studio`: `startStudio({ entry })`, imprime a URL, abre o navegador com
    `spawn("cmd", ["/c", "start", "", url])` no Windows (`open`/`xdg-open` fora), fica rodando até Ctrl+C
    como o comando `studio`.
  - Códigos (classe `GenerateError { code, hint, attempts? }`): `E_CODEX_MISSING`, `E_CODEX_AUTH`,
    `E_CODEX_FAILED` (exit ≠ 0; hint com o caminho do log), `E_CODEX_TIMEOUT` (hint "aumente --timeout"),
    `E_CODEX_OUTPUT`, `E_GEN_REQUEST_INVALID`, `E_GEN_OUT_EXISTS`, `E_GEN_EXHAUSTED`; diagnósticos de
    reparo `E_GEN_FORBIDDEN`, `E_GEN_FORMAT_MISMATCH`, `E_GEN_DURATION_MISMATCH`, `W_GEN_FRAME_BLANK`.
    `E_CODEX_FAILED`/`E_CODEX_TIMEOUT` não são repetidos (falhar alto, sem retry cego).
- **Spec/docs**: `docs/generate.md` (novo): uso, flags, o que sai da máquina (pedido, skill, contrato,
  HTML do catálogo, nomes e durações de mídia — nunca bytes de mídia, nunca segredo), o que o Codex pode
  ler (`read-only` permite leitura de disco: por isso `-C` num diretório só com texto, e o prompt manda
  não sair dele), conta ChatGPT obrigatória, códigos e hints. `docs/getting-started.md`: seção curta
  "Gerar a partir de texto". HELP do `cli.ts`. `docs/contract.md` não muda.
- **Passos**:
  1. Extrair o bloco do `lint --json` de `cli.ts:236-253` para `packages/cli/src/lint-report.ts`:
     `lintReport(html: string, file: string)` devolvendo exatamente o objeto de hoje; `cli.ts` passa a usá-lo
     (sem mudança de saída).
  2. `packages/cli/src/generate-errors.ts`: `GenerateError` e a lista dos códigos.
  3. `packages/cli/src/generate-codex.ts`: `resolveCodex`, `checkCodexAuth`, `codexVersion`,
     `runCodexExec` (spawn, stdin, log, timeout, kill de árvore, env saneado) e `codexAgent(options)`.
  4. `packages/cli/src/generate-context.ts`: `buildContextDir({ format, project?, previous? })`,
     `OUTPUT_SCHEMA`, `buildPrompt(...)`, `checkGeneratedHtml(html, format)`. Ler a skill de
     `packages/cli/skill/frankframes-generate/SKILL.md` se existir (pacote), senão de `skills/…` (monorepo),
     como `onboarding.ts` faz.
  5. `packages/cli/src/generate.ts`: `runGenerate({ request, outDir, format, durationSeconds?, attempts,
     timeoutMs, render: boolean, project?, force, keepContext, agent, renderImpl = renderComposition,
     onEvent? }): Promise<GenerateReport>`. `renderImpl` injetável para o teste sem Chrome.
  6. `packages/cli/src/generate-command.ts`: `runGenerateCommand(argv)` — parser próprio, monta
     `codexAgent`, chama `agent.check()` **antes** de qualquer escrita, roda `runGenerate`, abre Studio.
  7. `cli.ts`: despacho antecipado `if (argv[0] === "generate") …` (como `frames`); HELP.
  8. Corrigir `preview --open` (`cli.ts:440`) para `spawn("cmd", ["/c","start","",url])` no Windows.
  9. **Depois do EDT-51**: incluir `motion/presets.json` no contexto (passo 4).
- **Testes** (nenhum chama o Codex real; todos rodam no gate):
  - `packages/cli/test/fixtures/fake-codex.mjs`: implementa `--version`, `login status` (saída controlada
    por `FAKE_CODEX_LOGIN`: `chatgpt` | `apikey` | `none`) e `exec` (lê stdin, grava em `FAKE_CODEX_TRACE`
    um JSON com `argv`, `stdin`, `cwd`, lista de arquivos do `-C` e se `OPENAI_API_KEY` chegou; escreve no
    `-o` a resposta n-ésima de `FAKE_CODEX_REPLIES` (arquivo JSON com array); `FAKE_CODEX_SLEEP_MS` para timeout).
  - `generate-codex.test.ts`: `resolveCodex` com diretórios temporários e `platform` injetado — `.cmd` +
    `codex.js` → `node codex.js`; `.cmd` sem `codex.js` → `E_CODEX_MISSING`; PATH vazio → `E_CODEX_MISSING`
    com hint de instalação; `FRANKFRAMES_CODEX` inexistente com PATH válido → `E_CODEX_MISSING` (prova que
    não há fallback); `.ps1` sozinho é ignorado. `checkCodexAuth` com o falso: `chatgpt` ok, `apikey` e
    `none` → `E_CODEX_AUTH`. `runCodexExec`: argv contém `--ephemeral`, `-s read-only`,
    `--skip-git-repo-check`, `--output-schema`, `-o`, `-`, não contém `-i`/`--image`; prompt chegou por
    stdin; `OPENAI_API_KEY` definido no pai não chega ao filho; `FAKE_CODEX_SLEEP_MS=10000` com timeout
    300 ms → `E_CODEX_TIMEOUT` e o pid não está mais vivo (`process.kill(pid, 0)` lança).
  - `generate.test.ts` (agente falso em memória, `render: false` ou `renderImpl` falso):
    1ª resposta sem `data-composition-id`, 2ª válida → `ok`, 2 tentativas, o prompt da 2ª contém `E_NO_ROOT`
    e `previous.html` existe no contexto; sempre inválida → `E_GEN_EXHAUSTED`, `<out>/index.html` não
    existe, `attempt-3.html` existe; resposta com `<script>` → diagnóstico `E_GEN_FORBIDDEN`; texto que não
    é JSON → `E_CODEX_OUTPUT` como diagnóstico; raiz 1080×1920 pedida 16:9 → `E_GEN_FORMAT_MISMATCH`;
    `<out>/index.html` pré-existente sem `force` → `E_GEN_OUT_EXISTS`.
    **Privacidade**: projeto com `assets/clip.mp4` contendo o marcador `MEDIA-BYTES-7f3a` → o marcador não
    aparece no prompt nem em nenhum arquivo do contexto; `project.json` lista `assets/clip.mp4` (com
    `probeDuration` injetado para não precisar de FFmpeg).
  - `generate-cli.test.ts`: spawn `cli.ts generate "abertura" -o <tmp> --no-render --no-studio --json` com
    `FRANKFRAMES_CODEX=fake-codex.mjs` → exit 0, JSON com `ok: true`; com `FAKE_CODEX_LOGIN=none` → exit 1
    e `E_CODEX_AUTH` + `codex login` no stderr; com `FRANKFRAMES_CODEX=<inexistente>` → `E_CODEX_MISSING`.
  - Com Chrome+FFmpeg (skip explícito sem eles): `generate` com o falso devolvendo `examples/hello.html`
    → `draft.mp4` existe, `frames` com 3 entradas.
  - `lint-report.test.ts`: `lintReport` igual byte a byte ao `lint --json` de `examples/hello.html`.
- **Verificação manual** (titular/planejador, conta real): `node packages/cli/src/cli.ts generate
  "abertura de 6 s para o relatório do trimestre" -o out/g1`; conferir que abre o Studio, que
  `out/g1/generate.json` registra as tentativas e que `--ignore-user-config` não quebrou a autenticação
  (se quebrar, tirar a flag e registrar no `docs/generate.md`). Testar `codex logout` → `E_CODEX_AUTH`.
- **Arquivos tocados**: `packages/cli/src/{lint-report,generate-errors,generate-codex,generate-context,generate,generate-command}.ts`
  (novos), `packages/cli/src/cli.ts`, `packages/cli/test/{fixtures/fake-codex.mjs,generate-codex,generate,generate-cli,lint-report}.test.ts`,
  `docs/generate.md` (novo), `docs/getting-started.md`.
- **Dependências**: usa `frames`/`inspectFrames` e a skill do EDT-58 (passos 1–8) e `width/height` do
  índice. Studio: só `startStudio`, que já existe — não depende de EDT-41..47. Motion (EDT-49..51) só
  melhora o resultado: tudo menos o passo 9 adianta já.
- **Riscos**: `read-only` do Codex ainda lê o disco inteiro — mitigado por `-C`, prompt e ausência de
  mídia no contexto, mas não é barreira técnica (documentar); o Codex pode mudar flags (`--output-schema`,
  `--ignore-user-config`) — o falso cobre o nosso lado, a verificação manual cobre o dele, e `codexVersion`
  vai no relatório; limite de uso da conta ChatGPT → `E_CODEX_FAILED` com o log; prompt grande (48 blocos
  ≈ 220 KB) fica no disco, não no prompt; kill de árvore no Windows precisa de `taskkill` (existe em todo
  Windows 10/11).

---

#### EDT-61 — Exportação em lote

- **Desenho**:
  - Duas entradas: `frankframes render a.html b.html c.html [-o <dir>/] [--concurrency N] [opções de render]`
    (várias entradas → lote; `-o` tem que ser diretório; saída `<dir>/<nome>.mp4`) e
    `frankframes render --batch lote.json [--concurrency N] [--json]`.
  - Formato do lote (caminhos relativos ao arquivo do lote):
    ```json
    {
      "version": 1,
      "concurrency": 2,
      "defaults": { "preset": "standard", "codec": "av1", "gpu": "auto", "loudness": true },
      "jobs": [
        { "id": "cliente-a", "entry": "promo/index.html", "out": "out/cliente-a.mp4",
          "vars": { "titulo": "Oferta A", "foto": "assets/a.jpg" }, "preset": "draft" }
      ]
    }
    ```
    `id` `^[a-z0-9][a-z0-9-]*$` único; `out` único; `vars` texto→texto. Erro de formato →
    `E_BATCH_INVALID` (hint com o campo e o índice do job) **antes** de começar qualquer render.
  - Variações de dados (spec nova, sem tocar no parser do contrato — passo de compilação do producer):
    `data-var="titulo"` troca o **texto** do elemento (escapado, elemento precisa ter só texto);
    `data-var-attr="src:foto; data-duration:tempo"` troca atributos. Sem `vars` (render normal, preview,
    Studio) o valor autoral fica. Chave usada no HTML e ausente no job → `E_VAR_MISSING`; chave do job que
    nenhum elemento usa → `E_VAR_UNKNOWN` (erro: erro de digitação não pode passar); chave com forma
    inválida ou elemento com filhos → `E_VAR_INVALID`. Variáveis entram **antes** do contrato, então
    duração/tempo alterados por variável são validados normalmente.
  - Fila: `--concurrency` padrão 1 (cada render já usa `defaultWorkerCount()` workers); com N > 1,
    `workers` por job = `max(1, floor(defaultWorkerCount() / N))`. Falha de um job não para a fila.
    Ctrl+C: para de tirar jobs, os em andamento limpam pelo caminho de cancelamento existente.
  - Relatório: sempre `<dir do lote ou do -o>/batch-report.json`, e `--json` imprime o mesmo:
    `{"ok":false,"total":3,"succeeded":2,"failed":1,"elapsedMs":81234,"jobs":[{"id":"cliente-a","entry":"…","out":"…","ok":true,"frames":180,"durationSeconds":6,"elapsedMs":30211,"warnings":[]},{"id":"cliente-b","ok":false,"elapsedMs":120,"error":{"ok":false,"code":"E_VAR_MISSING","stage":"compile","message":"…","diagnostics":[]}}]}`.
    `error` é o `toErrorPayload` existente. Resumo em texto: uma linha por job + `2/3 ok · 81,2 s`.
    Exit 0 se todos ok, 1 se algum falhou.
- **Spec/docs**: `docs/contract.md` nova seção **§11 Variáveis** (`data-var`, `data-var-attr`, códigos,
  "aplicadas antes da validação; sem lote, vale o valor autoral"). `docs/batch.md` (novo): formato do lote,
  concorrência, relatório, exit code. `docs/getting-started.md`: exemplo curto. HELP.
- **Passos**:
  1. `packages/producer/src/variables.ts`: `applyVariables(html, vars): { html; used: string[] }` com parse5
     e emenda por `sourceCodeLocation` (mesma técnica de `edit.ts`, preserva o resto do arquivo);
     `collectVariables(html): string[]`; `VariableError { code: "E_VAR_MISSING"|"E_VAR_UNKNOWN"|"E_VAR_INVALID", hint }`.
  2. `render.ts`: `PrepareOptions` e `RenderOptions` ganham `html?: string` (fonte já resolvida; o `entry`
     continua definindo o diretório base) e `vars?: Record<string,string>`; em `prepare`, `source =
     options.html ?? readFile(entry)`, depois `applyVariables` quando `vars` existir — `VariableError` vira
     `RenderError(code, "compile", …)`.
  3. `errors.ts`: incluir `E_VAR_MISSING`, `E_VAR_UNKNOWN`, `E_VAR_INVALID`, `E_BATCH_INVALID` em
     `RENDER_ERROR_CODES`.
  4. `packages/engine/src/cache.ts` (corrida do lote): trava em processo por chave
     (`Map<string, Promise<CachedExtraction>>`); extrair para `<dir>.tmp-<pid>-<rand>`, escrever
     `.complete`, `rename` para `<dir>`; se o `rename` falhar porque `<dir>` já está completo, apagar o tmp
     e usar o existente; `evictCache` recebe `inUse: Set<string>` e pula esses diretórios.
  5. `packages/producer/src/batch.ts`: `parseBatchFile(text, baseDir): BatchSpec` (validação completa,
     `E_BATCH_INVALID`), `runBatch({ jobs, concurrency, render = renderComposition, onJob? }):
     Promise<BatchReport>` (fila com limite, `allSettled` por job, nunca lança por job).
  6. `cli.ts`: `parseCli` passa a guardar todos os positionals (`files: string[]`) e reconhece
     `--batch <arquivo>` e `--concurrency N`; no ramo `render`, 2+ entradas ou `--batch` → caminho de lote
     (monta os jobs, `runBatch`, escreve `batch-report.json`, imprime resumo/JSON); 1 entrada → caminho atual
     sem mudança. `-o` com várias entradas e sem barra final/diretório → erro de uso (exit 2).
  7. Docs e HELP.
- **Testes**:
  - `packages/producer/test/variables.test.ts`: texto trocado e escapado (`<b>` vira `&lt;b&gt;`);
    atributo trocado; resto do arquivo byte a byte igual (comentário e indentação preservados);
    `E_VAR_MISSING`, `E_VAR_UNKNOWN`, `E_VAR_INVALID` (elemento com filho); `data-duration` via variável
    muda a duração resolvida por `loadComposition`.
  - `packages/producer/test/batch.test.ts` (render falso, sem Chrome): job 2 falha e 3 roda (continua após
    falha); com `concurrency: 2` e render que espera, o pico de jobs simultâneos é exatamente 2; relatório
    com `succeeded/failed` e `error.code`; `out` duplicado e `id` inválido → `E_BATCH_INVALID` antes de
    chamar o render (contador = 0).
  - `packages/engine/test/cache.test.ts`: duas `extractFramesCached` simultâneas para o mesmo arquivo
    (FFmpeg, skip sem ele) → mesma `dir`, uma extração só (`hit` de uma é `true` ou o ffmpeg é chamado 1×),
    nenhum diretório `.tmp-` sobra; `evictCache` com `inUse` não apaga o diretório em uso (puro, sem FFmpeg).
  - `packages/cli/test/batch-cli.test.ts` (Chrome+FFmpeg, skip explícito): lote de 2 jobs sobre uma
    composição de 0,5 s com `data-var`, preset `draft`, `--workers 1`, um job com `vars` faltando →
    exit 1, um MP4 gerado, `batch-report.json` com 1 ok e 1 `E_VAR_MISSING`.
- **Verificação manual**: lote com 3 variações de `examples/hello.html` (adicionar `data-var` numa cópia em
  tmp), `--concurrency 2`; conferir os 3 MP4 e o relatório; Ctrl+C no meio e ver que `%TEMP%\ff-render-*`
  não sobra.
- **Arquivos tocados**: `packages/producer/src/{variables,batch}.ts` (novos), `render.ts`, `errors.ts`,
  `index.ts`, `packages/engine/src/cache.ts`, `packages/cli/src/cli.ts`, testes citados,
  `docs/contract.md` (§11), `docs/batch.md` (novo), `docs/getting-started.md`.
- **Dependências**: nenhuma de motion/Studio. Conflito de arquivo: `render.ts` (EDT-62) e `cli.ts`
  (EDT-58/59 só no despacho antecipado) — ver ordem. O botão de exportar do Studio (EDT-46, outro
  planejador) pode reutilizar `runBatch` depois.
- **Riscos**: `docs/contract.md` também é editado pelo planejador de motion — §11 é seção nova no fim,
  conflito só de posição; muitos jobs × workers estouram memória (a divisão de workers cobre o padrão;
  `--workers` explícito vale por job e é responsabilidade do usuário — documentar).

---

#### EDT-62 — Desempenho de captura medido e otimizado

- **Desenho**: medir primeiro, com script reproduzível que **não muda o produto**; registrar baseline;
  só então otimizar, uma hipótese por vez, cada uma com o gate (determinismo + goldens) verde e nova
  medição. Parar quando a próxima hipótese render < 5%.
  - `scripts/bench-capture.ts [--label baseline] [--presets draft,standard,high] [--gpu auto,software]
    [--workers 2,4,6,8|default] [--runs 3] [--seconds 10] [--scenario motion,video] [--out out/bench]`.
    Cenários: `scripts/bench/motion-1080p.html` (novo, 1920×1080, 30 fps, 10 s: 6 cenas com texto em
    fontes do catálogo, gradiente, `transform`/`opacity`/`clip-path`/`filter: blur`) e
    `scripts/bench/video-1080p.html` (vídeo de 10 s gerado na hora em `out/bench/src-1080p.mkv` pelo FFmpeg
    vendorizado: `-f lavfi -i testsrc2=s=1920x1080:r=30:d=10 -c:v mjpeg -q:v 3`; mais um título por cima).
    Por execução usa `renderComposition` e carimba o tempo de cada mudança de estágio pelo `onProgress`
    (compile/probe/extract/capture/audio/encode/assemble). Execução 1 do vídeo com cache frio (apaga a
    entrada do cache antes), as outras quentes; relata as duas.
    Métricas: `captureFps = frames / s_capture`; `sPorMinuto = s_total / (s_video / 60)`; `s_encode`;
    mediana e min/max das `--runs`. Máquina: `os.cpus()[0].model`, núcleos, RAM, renderer de GPU
    (`probeRenderer`), Node, `PINNED_BROWSER.version`, versão do FFmpeg (`detectFfmpeg`).
    Saída: `out/bench/<label>-<AAAAMMDD-HHMM>.json` + tabela Markdown no stdout.
  - `scripts/bench-frame.ts [--frames 120] [--gpu software|hardware]`: uma sessão (`openSession`),
    cenário motion, mede por frame: `seekFrame` (seek + settle), `settlePaint` isolado, `captureScreenshot`
    (CDP), decodificação base64 + SHA-256; e as variantes de screenshot `optimizeForSpeed: true` e
    `false` (só medição). Mediana por fase em ms. É o que confirma ou derruba H1/H2/H4 antes de tocar no motor.
  - Hipóteses (ordem **a priori** por ganho esperado; reordenar pelos números do baseline antes de
    implementar — o executor registra a ordem final no `docs/perf.md`):
    - **H0 — rAF não dispara e o settle cai no teto de 80 ms.** Se `bench-frame` mostrar `settlePaint` ≈ 80 ms,
      é o gargalo dominante; correção: descobrir por que (aba em background/headless) antes de qualquer outra.
    - **H1 — settle duplicado.** `capture()` com `required === 1` (frame não-primeiro) chama `settlePaint`
      de novo depois do `seekFrame`, que já fez `settle`. Remover a segunda (e juntar seek + settle num
      `evaluate` só). Esperado: até ~metade do tempo por frame se o settle domina.
    - **H2 — encode em série depois da captura.** Em `standard`/`high` o encode AV1 1080p deve pesar.
      Trocar `splitIntoChunks` (blocos contíguos por worker) por fila dinâmica de lotes pequenos em ordem
      (ex. 8 frames) e alimentar o FFmpeg por `image2pipe` na ordem à medida que os frames ficam prontos
      (buffer de reordenação limitado). Tempo total ≈ max(captura, encode) em vez da soma; fila dinâmica
      também equilibra cenas pesadas.
    - **H3 — PNG em disco.** Com H2, os frames vão direto para o pipe; o disco só guarda o buffer de
      reordenação. Ganho de I/O (~3–6 MB por frame 1080p).
    - **H4 — `optimizeForSpeed` no `Page.captureScreenshot`.** PNG mais rápido, pixel igual, bytes
      diferentes → os SHA-256 de `catalog/goldens.json` mudam (PSNR continua passando): exige regenerar
      goldens com `scripts/generate-goldens.ts` e conferir PSNR ≥ 50 dB contra os PNG antigos antes.
    - **H5 — número de workers.** Varredura 2/4/6/8/12 por modo de GPU; ajustar `defaultWorkerCount` só se a
      curva mostrar joelho diferente do atual (metade dos núcleos, teto 8, 768 MB por browser).
    - **H6 — BeginFrame controlado** (`HeadlessExperimental.beginFrame`): elimina esperas de rAF, mas é
      refatoração grande do relógio; só se H0/H1 não bastarem. Fora do escopo 1.0 salvo decisão do titular.
    - Não entra: tirar `--disable-gpu-compositing` ou forçar hardware em vídeo — trocaria determinismo
      por velocidade (contract §9).
- **Spec/docs**: `docs/perf.md` (novo): máquina, método, comandos, tabela baseline
  (`captureFps` por GPU; `s/min` e `s_encode` por preset; vídeo frio/quente), tabela por hipótese
  (antes/depois) e número final. `docs/contract.md` §9 só muda se H1/H2/H6 mudarem a promessa de captura
  (ex.: "uma espera de paint por frame"); `docs/ci.md` atualiza tempos se o gate ficar mais rápido.
- **Passos**:
  1. Criar `scripts/bench/motion-1080p.html` e `scripts/bench/video-1080p.html`
     (`<video src="../../out/bench/src-1080p.mkv">` — o script gera o arquivo antes), ambos passando no `lint`.
  2. Criar `scripts/bench-capture.ts` e `scripts/bench-frame.ts` (só APIs públicas de
     `@frankframes/producer`/`engine`; nenhum arquivo de `packages/` muda neste passo).
  3. Rodar baseline nesta máquina, sem outra carga:
     `node scripts/bench-capture.ts --label baseline --runs 3` e `node scripts/bench-frame.ts --gpu software`
     e `--gpu hardware`. Escrever `docs/perf.md` com os números. **Parar e devolver os números ao
     planejador**, que fixa a ordem das hipóteses (é a "otimização guiada pela medição").
  4. Para cada hipótese na ordem fixada: implementar (H1: `packages/engine/src/capture.ts`; H2/H3:
     `packages/engine/src/parallel.ts` + `packages/producer/src/render.ts` + `packages/encode/src/policy.ts`
     com `buildFramePipeArgs`; H4: `capture.ts` + goldens; H5: `parallel.ts`), rodar
     `node scripts/ci.ts` completo (determinismo e goldens), medir com `--label h<N>`, anotar em `docs/perf.md`.
  5. Número final em `docs/perf.md` (o planejador copia para o Jira).
- **Testes**:
  - Os existentes são a rede: `packages/engine/test/determinism.test.ts`, `parallel.test.ts`,
    `packages/catalog/test/goldens.test.ts`, `packages/producer/test/render.test.ts`.
  - H1: teste em `packages/engine/test/determinism.test.ts` que conta chamadas de `settle` por frame
    (expor contador em `__ff` só quando `FRANKFRAMES_CAPTURE_PROFILE=1`) → 1 por frame não-primeiro; falha
    hoje (são 2).
  - H2: `parallel.test.ts` — com fila dinâmica, `onFrame` recebe frames de forma que o alimentador ordenado
    entrega `0..n-1` em ordem e sem buraco mesmo com workers fora de ordem (função pura
    `orderedFeeder(push, total)` testada sem Chrome); `render.test.ts` (Chrome+FFmpeg, skip) — MP4 com
    `nb_frames` exato e hashes por frame iguais ao caminho antigo.
  - Script de bench: `scripts/bench-capture.ts --runs 1 --seconds 1 --presets draft --gpu software` roda
    na verificação manual, não no gate (o gate não mede desempenho).
- **Verificação manual**: comparar `out/bench/baseline-*.json` com o último `h<N>`; render real de
  `examples/cena-dupla` antes/depois com hashes iguais (`render --json` → `frameHashes`).
- **Arquivos tocados**: `scripts/bench-capture.ts`, `scripts/bench-frame.ts`, `scripts/bench/*.html`
  (novos), `docs/perf.md` (novo); depois, conforme hipótese: `packages/engine/src/{capture,clock,parallel}.ts`,
  `packages/producer/src/render.ts`, `packages/encode/src/policy.ts`, `catalog/goldens.json` +
  `catalog/goldens/**` (só H4), testes citados.
- **Dependências**: passos 1–3 adiantam já, em paralelo com tudo. Passo 4 depois do EDT-61 (mesmo
  `render.ts`) e antes do EDT-64 (o aceite de 68 s em software é o caso que mais sente).
- **Riscos**: medição ruidosa (antivírus, Sync do OneDrive/Syncthing no repo) → 3 execuções, mediana,
  máquina parada, `out/` fora de pasta sincronizada se possível; H1/H2 podem reintroduzir frame instável
  em hardware — os goldens rodam em software, então verificar também `determinism.test.ts` em `auto`;
  H4 muda todos os hashes de golden (avisar no commit).

---

#### EDT-63 — Publicar o catálogo remoto — **PÓS-1.0 (esboço; fora da ordem de execução da 1.0)**

Decisão do titular: fica para depois da 1.0. Nada deste item é executado agora; o EDT-65 o lista como
pendência conhecida.

- **Desenho (independente de hospedagem)**: `blocks publish <dir>` (já existe) gera diretório estático
  servível por qualquer host. Incrementos previstos: `index.json` com envelope versionado
  `{"format":"frankframes-catalog","version":1,"blocks":[{slug,name,summary,durationSeconds,tags,width,height,files:{"index.html":{sha256,size},"meta.json":{…},"thumb.png":{…}}}]}`,
  ordenado e sem timestamp (duas publicações geram bytes idênticos); `blocks add <slug> --from <url-do-catálogo>`
  usa o `index.json` como âncora e recusa `meta.json`/HTML/thumb divergentes; `blocks add <url> --sha256 <hex>`
  permite fixar o hash vindo de canal confiável (hoje o hash vem do mesmo host do HTML: protege corrupção,
  não host malicioso); erros `E_BLOCK_HASH_MISSING`, `E_BLOCK_HASH_MISMATCH`, `E_BLOCK_NOT_FOUND`,
  `E_BLOCK_HTTP`, `E_BLOCK_TOO_LARGE`, `E_BLOCK_INVALID`, `E_CATALOG_INDEX_INVALID` com hint; teto de
  tamanho por arquivo; token opcional `FRANKFRAMES_CATALOG_TOKEN` (de `.env`, nunca impresso) se o catálogo
  for privado. O envio ao host fica **fora** do produto até a decisão.
- **Opções de hospedagem** (nenhuma depende de workflow):
  | Opção | Prós | Contras |
  |---|---|---|
  | Cloudflare Pages (upload direto com `wrangler pages deploy` rodado localmente) ou R2 + domínio | CDN global, HTTPS, plano gratuito, sem integração com git | conta e token Cloudflare em `.env`; catálogo público salvo Cloudflare Access |
  | VPS própria (a mesma prevista no EDT-34) com Caddy/nginx, envio por `rsync`/`scp` | controle total, autenticação simples, alinhado ao EDT-34 | manter servidor, TLS e backup; depende do EDT-34 sair do stand-by |
  | Bucket S3-compatível (Backblaze B2 ou S3 + CloudFront), envio pela CLI do provedor | barato, durável | CORS/cache a configurar; credencial de escrita em `.env` |
  GitHub Pages fica de fora: o modo "deploy from branch" publica por um run interno do Actions
  (`pages-build-deployment`), o que conflita com `.omp/RULES.md`, e repositório privado exige plano pago.
- **Pendente de decisão do titular**: host; catálogo público ou privado (os blocos são proprietários).

---

#### EDT-64 — Aceite de ponta a ponta com vídeo real

- **Desenho**: último item antes do release. Roteiro fixo + script de verificação que não depende de
  olho humano para duração, loudness e frames-chave. O vídeo nunca é copiado para o repositório: o projeto
  de aceite fica em `out/aceite-a001/` (ignorado) e o Studio copia para `out/aceite-a001/assets/`.
  - Roteiro (Studio, nada editado à mão no HTML):
    1. `frankframes init out/aceite-a001` e, no HTML, nada mais; `frankframes studio out/aceite-a001/index.html`.
    2. Importar `C:\Users\rober\Downloads\A001_11181126_H685.MOV` no playhead 0 → clip de 68,164583 s
       (medido pelo ffprobe).
    3. Dividir em 8 s e em 38 s; apagar o primeiro e o terceiro pedaço (EDT-41). Resultado esperado: um clip
       de vídeo com `data-offset="8"` e `data-duration="30"` começando em 0 (se o EDT-41 não reancorar o
       pedaço seguinte em 0, mover pela timeline; registrar o comportamento).
    4. Remover os clips do `init` (kicker/título/régua) ou encurtá-los para 4 s; inserir o bloco
       `lower-third` em 5 s e aplicar um preset de entrada e de saída pelo inspetor (EDT-55) no título.
    5. Legendas: extrair o trecho de áudio
       `ffmpeg -ss 8 -t 30 -i A001….MOV -vn -ac 1 -ar 16000 out/aceite-a001/trecho.wav` e rodar
       `frankframes captions out/aceite-a001/trecho.wav -o out/aceite-a001/legendas.html --size 1920x1080`;
       inserir como sub-composição em 0 com duração 30 s. Provedor: **Groq** (decisão do titular), com
       `GROQ_API_KEY` no `.env`; só o trecho de 30 s sai da máquina. Se a chave faltar, falhar alto com o
       código de erro do `transcribe`, sem cair para outro provedor.
    6. Exportar pelo Studio (EDT-46), preset `standard`, para `out/aceite-a001/final.mp4`.
  - `scripts/accept-video.ts <final.mp4> --entry <index.html> --source <MOV> --spec <keyframes.json>`
    (novo, fora do gate porque precisa do vídeo do titular):
    - **Duração**: `lint --json` da entrada (`duration.seconds`, esperado 30,000) × ffprobe do MP4
      (`format=duration` e `nb_frames`): |diferença| ≤ 1/fps e `nb_frames = frameCountFor(30, fps)`.
    - **Loudness**: `measureLoudness(ffmpeg, final.mp4)` (já existe em `audio.ts`): `input_i` em
      [−15, −13] LUFS e `input_tp` ≤ −0,9 dBTP; stream de áudio presente e com duração = vídeo ± 1 frame.
    - **Frames-chave** (`keyframes.json` escrito pelo executor a partir do roteiro):
      `[{"t":1,"source":9,"region":"0,0,1920,700","minPsnr":30},{"t":29.5,"source":37.5,"region":"0,0,1920,700","minPsnr":30},{"t":0.3,"expect":"motion-enter"},{"t":6,"expect":"lower-third","region":"0,700,1920,380"},{"t":"palavra","expect":"caption","region":"0,860,1920,220"}]`.
      Vídeo: frame do MP4 em `t` × frame da fonte em `source` (prova corte e `data-offset`), PSNR por
      `ffmpeg -lavfi "[0]crop=…[a];[1]crop=…[b];[a][b]psnr" -f null -` na região sem sobreposição, ≥ 30 dB
      (AV1 com perda). Motion: frames em 0,1 s e 0,9 s do título diferem (PSNR < 40 dB na região do título)
      e o de 0,9 s não é `uniform`. Lower-third/legenda: região do frame difere da fonte no mesmo instante
      (PSNR < 30 dB) — prova que a camada está lá. Instante da legenda = início de um segmento do
      `legendas.html`.
    - Saída `out/aceite-a001/aceite.json` com cada verificação `{name, ok, medido, esperado}` e exit 1 se
      alguma falhar.
- **Spec/docs**: `docs/aceite.md` (novo): roteiro, comando do script, resultado da execução (números),
  data e versão. Nenhuma mudança de contrato.
- **Passos**:
  1. `scripts/accept-video.ts` com funções puras exportadas (`checkDuration`, `checkLoudness`,
     `parseKeyframeSpec`) e as chamadas de FFmpeg isoladas; usa `inspectFrames` (EDT-58) para `uniform`.
  2. `scripts/accept/keyframes-a001.json` com o spec acima.
  3. Executar o roteiro (titular ou planejador acompanhando; o executor só roda se o planejador mandar).
  4. Rodar o script; registrar `aceite.json` e o resumo em `docs/aceite.md`.
- **Testes**: `scripts/test/accept-video.test.ts` (entra no glob do gate? hoje o gate só pega
  `packages/*/test/*.test.ts` — colocar em `packages/producer/test/accept-checks.test.ts` importando de
  `scripts/accept-video.ts`): `checkDuration` aceita ±1 frame e recusa 2 frames; `checkLoudness` recusa
  −16 LUFS e TP −0,5; `parseKeyframeSpec` recusa região fora do quadro. Com FFmpeg (skip): MP4 sintético de
  2 s com tom de 1 kHz normalizado por `mixAudio` passa no `checkLoudness`.
- **Verificação manual**: o próprio roteiro; abrir `final.mp4` num player e conferir sincronia de lábio
  nos 30 s (o script não mede sincronia fina).
- **Arquivos tocados**: `scripts/accept-video.ts`, `scripts/accept/keyframes-a001.json`,
  `packages/producer/test/accept-checks.test.ts` (novos), `docs/aceite.md` (novo).
- **Dependências**: EDT-36/38 (já feitos), EDT-41 (apagar), EDT-46 (exportar), EDT-55 (motion no
  inspetor), EDT-49..51 (motion), captions pela Groq, EDT-58 (`inspectFrames`), EDT-62
  (68 s → 30 s em software é lento hoje). Adianta já: passos 1–2 e o teste.
- **Riscos**: H.264 da câmera decodifica no FFmpeg LGPL (decodificador nativo), mas 24 fps numa composição
  30 fps duplica frames — aceitável, documentar; se o Studio não deixar mudar `data-fps` da raiz, não é
  defeito deste item; legenda depende da Groq estar acessível (erro de rede falha alto, sem retry cego); PSNR ≥ 30 dB pode falhar em cena com muito movimento por
  causa do AV1 `standard` — se falhar, comparar também contra frame vizinho ±1 antes de concluir defeito.

---

#### EDT-65 — Release 1.0

- **Desenho**:
  - **Bloqueio real**: Node 24 não executa `.ts` dentro de `node_modules`; os 7 pacotes atuais exportam
    `src/*.ts` e o `@frankframes/cli` não declara `engine/encode/producer`; o catálogo é lido de fora do
    pacote. Decisão proposta: **um tarball só**, `@frankframes/cli-1.0.0.tgz` (nome mantido porque o
    `upgrade` consulta `@frankframes/cli`), compilado, instalável com `npm i -g <tgz>`; os pacotes do
    monorepo continuam TS sem build para desenvolvimento. Motivo: layout de estágio espelhando o repo
    mantém todos os `new URL("../../../catalog/blocks/", import.meta.url)` funcionando sem tocar no código;
    publicar 7 pacotes compilados exigiria trocar `exports` por pacote e manter dois modos de resolução.
  - Estágio `out/release/stage/`:
    `package.json` (gerado: `name @frankframes/cli`, `version 1.0.0`, `type module`, `bin.frankframes =
    packages/cli/src/cli.js`, `engines.node >=22.18`, `dependencies` = dependências de produção reais com
    versão exata do `package-lock.json` — hoje `parse5` e `puppeteer-core`, `files`), `packages/<pkg>/src/**/*.js`
    (tsc com `rewriteRelativeImportExtensions: true`, `noEmit: false`, `allowImportingTsExtensions: true`),
    `packages/<pkg>/package.json` (cópia com `type module` e versão; o `upgrade` lê `../package.json`),
    imports `@frankframes/<x>` reescritos para caminho relativo `…/<x>/src/index.js` (só especificadores
    estáticos; o build falha se sobrar algum `@frankframes/` ou `.ts"` no JS), arquivos estáticos
    (`packages/cli/src/studio/**`, `packages/cli/skill/**`), `catalog/blocks/**`, `catalog/README.md`,
    `docs/**`, `LICENSE`, `THIRD-PARTY-NOTICES.md`, `CHANGELOG.md`. Nada de `vendor/` (o `setup` baixa) nem
    `catalog/goldens*` (só teste).
  - `frankframes --version` (novo, lê a versão do `package.json` do pacote cli).
  - Avisos: `scripts/third-party.ts [--check]` lista a árvore de produção (`npm ls --omit=dev --all --json`
    + `license` de cada `node_modules/<pkg>/package.json`); `--check` falha se uma dependência de produção
    não aparece em `THIRD-PARTY-NOTICES.md` ou tem licença fora de MIT/ISC/Apache-2.0/BSD-2-Clause/
    BSD-3-Clause/0BSD/BlueOak-1.0.0. Acrescentar `puppeteer-core` (Apache-2.0) e as transitivas; linha no
    `PROVENANCE.md`.
  - `CHANGELOG.md`: escrito à mão por épico a partir de `git log` (Empacotamento, Preview, Determinismo,
    Catálogo, Legendas, Mix, Falhas, Onboarding, Studio, Motion, Geração, Versão 1.0), com seção
    **Pendências conhecidas**: EDT-5 (doctor em VM Windows limpa), EDT-13 (gate em duas máquinas em
    software), EDT-19 (whisper.cpp embarcado), EDT-34 (CI em servidor próprio), EDT-63 (catálogo remoto,
    pós-1.0) — cada uma com uma frase de impacto.
  - Gate: `node scripts/ci.ts --release` troca os 7 `npm pack --dry-run` por: `build release`
    (`node scripts/build-release.ts`), `avisos` (`node scripts/third-party.ts --check`), `instalar tarball`
    (`node scripts/verify-release.ts out/release/frankframes-cli-1.0.0.tgz`: `npm install --prefix <tmp>`
    do tgz sem rede além do registro para `parse5`/`puppeteer-core`; com `FRANKFRAMES_HOME=<repo>/vendor`
    roda o bin instalado: `--version` = 1.0.0, `doctor`, `init`, `lint --json`, `render --preset draft
    --workers 2` de 1 s e ffprobe do MP4; no Windows chama o shim `frankframes.cmd` via `cmd /c` com
    argumentos fixos e também `node <prefix>/node_modules/@frankframes/cli/packages/cli/src/cli.js`).
- **Spec/docs**: `docs/release.md` (novo: como gerar, verificar e instalar o tarball; por que não há
  pacotes por workspace); `docs/ci.md` (etapas do `--release` e tempos); `docs/getting-started.md`
  (instalação pelo tarball além do clone); `.omp/AGENTS.md` linha "Distribuição" da tabela de decisões
  (o planejador atualiza — é arquivo de instrução); `THIRD-PARTY-NOTICES.md`, `PROVENANCE.md`,
  `CHANGELOG.md` (novo).
- **Passos**:
  1. `tsconfig.build.json` (estende o raiz; `noEmit: false`, `rewriteRelativeImportExtensions: true`,
     `outDir` do estágio, `rootDir: "."`, `include: ["packages/*/src/**/*.ts"]`, sem testes/scripts).
  2. `scripts/build-release.ts`: limpa `out/release/`, roda `tsc -p tsconfig.build.json`, reescreve
     `@frankframes/*`, copia estáticos e docs, gera o `package.json` do estágio a partir do lockfile, valida
     (nenhum `.ts"`/`@frankframes/` no JS; todo arquivo de `files` existe; shebang em `cli.js`) e roda
     `npm pack` no estágio para `out/release/`.
  3. `packages/cli/src/cli.ts`: `--version`/`-v` antes do `parseCli`; HELP.
  4. `scripts/verify-release.ts` (etapas do desenho; falha alto em cada uma, imprime o comando que falhou).
  5. `scripts/third-party.ts` e atualização de `THIRD-PARTY-NOTICES.md` + `PROVENANCE.md`.
  6. `scripts/ci.ts`: etapas novas do `--release` no lugar dos `pack` por workspace.
  7. **Por último, depois do EDT-64**: versão `1.0.0` no `package.json` raiz e nos 7 pacotes; dependência
     `"@frankframes/contract": "0.1.0"` do catálogo vira `"*"` como os outros; `CHANGELOG.md` com as
     pendências conhecidas; `docs/release.md`.
  8. `node scripts/ci.ts --release` verde.
- **Testes**:
  - `packages/cli/test/release-build.test.ts` (marcado lento; roda na suíte completa): roda
    `build-release.ts` num `outDir` temporário e confere: `package.json` do estágio com `bin`, `engines`,
    dependências só de produção; nenhum `.ts` em `packages/*/src`; `catalog/blocks/title-card/index.html`
    presente; `node <estágio>/packages/cli/src/cli.js lint <bloco> --json` funciona **de dentro de um
    `node_modules`** (copiar o estágio para `<tmp>/node_modules/@frankframes/cli/`) — falha hoje com
    `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`.
  - `packages/cli/test/version.test.ts`: `cli.ts --version` imprime a versão do `package.json`.
  - `packages/cli/test/third-party.test.ts`: `third-party.ts --check` passa no repo; com uma dependência
    falsa de licença `GPL-3.0` injetada na lista (função pura `checkLicenses(entries, notices)`) falha.
  - A instalação real do tarball fica no `ci.ts --release` (precisa de `npm install`, que é rede).
- **Verificação manual**: `npm i -g out/release/frankframes-cli-1.0.0.tgz` numa pasta fora do repo, sem
  `FRANKFRAMES_HOME`: `frankframes setup`, `frankframes doctor`, `frankframes init x && frankframes render
  x/index.html -o x.mp4 --preset draft`, `frankframes studio x/index.html`, `frankframes generate "…"
  --no-studio`; depois `npm rm -g @frankframes/cli`.
- **Arquivos tocados**: `tsconfig.build.json`, `scripts/{build-release,verify-release,third-party}.ts`
  (novos), `scripts/ci.ts`, `packages/cli/src/cli.ts`, `package.json` (raiz) e `packages/*/package.json`
  (versão), `THIRD-PARTY-NOTICES.md`, `PROVENANCE.md`, `CHANGELOG.md` (novo), `docs/{release,ci,getting-started}.md`,
  testes citados.
- **Dependências**: passos 1–6 adiantam já (não dependem de nada do escopo; só tocam `scripts/`,
  `tsconfig.build.json` e o `--version` no `cli.ts`). Passo 7 depende de EDT-64 e de todo o resto da 1.0.
  **Não depende do EDT-63**, que entra como pendência conhecida.
- **Riscos**: reescrita de `@frankframes/*` por texto pega só import estático — `import()` dinâmico com
  string montada quebraria em silêncio; por isso a validação do passo 2 e o teste dentro de `node_modules`;
  arquivos lidos por caminho relativo a `import.meta.url` fora dos listados (ex. outro diretório estático)
  só aparecem no teste de instalação — rodar `verify-release` com `render`, `studio` e `blocks list`;
  `puppeteer-core` traz transitivas com licenças a revisar; EDT-2 ("dist compilado para Node 20+") conflita
  com `engines >=22.18` — a 1.0 mantém 22.18 (o código usa APIs recentes; o titular confirma ou o planejador
  reabre o EDT-2).

---

### Ordem e paralelismo

Arquivos de alto conflito: `packages/cli/src/cli.ts` (todos), `packages/producer/src/render.ts`
(EDT-61, EDT-62), `docs/contract.md` (EDT-61 e o planejador de motion), `packages/engine/src/*`
(EDT-61 cache, EDT-62). Comandos novos (`frames`, `generate`, `--version`) entram por despacho antecipado
de 2–3 linhas no topo de `main()`, para que executores paralelos só colidam nessas linhas.

| Onda | Itens (executores em paralelo) | Condição |
|---|---|---|
| 1 | **A** EDT-62 passos 1–3 (bench + baseline; só `scripts/` e `docs/perf.md`) · **B** EDT-61 completo · **C** EDT-58 passos 1–8, 11 · **D** EDT-65 passos 1–6 | já; B, C e D tocam `cli.ts` em blocos diferentes — o planejador integra na ordem B → C → D |
| 2 | **E** EDT-59 passos 1–8 · **F** EDT-64 passos 1–2 + teste | E depois de C (usa `inspectFrames`, skill, `width/height`); F depois de C |
| 3 | **G** EDT-62 passo 4 (hipóteses, uma por vez, na ordem fixada pelo planejador a partir do baseline) | depois de B (mesmo `render.ts`/`cache.ts`) e do retorno de A |
| 4 | EDT-58 passo 9 e EDT-59 passo 9 (motion na skill e no contexto) | depois do EDT-49/50/51 (outro planejador) |
| 5 | EDT-58 passo 10 (`generate-eval.ts --real`, 5/5) | depois da onda 4; roda com a conta ChatGPT do titular |
| 6 | EDT-64 passos 3–4 (roteiro com o vídeo do titular) | depois de EDT-41, 46, 55 (Studio), motion, G e da `GROQ_API_KEY` (já no `.env`); **último item antes do release** |
| 7 | EDT-65 passos 7–8 (versão 1.0.0, CHANGELOG, `ci.ts --release`) | depois do EDT-64 |
| pós-1.0 | EDT-63 | decisão de host e de público/privado |

Decisões que este plano levantou (situação atual em "Ordem global" abaixo):
1. Provedor das legendas no aceite (EDT-64): **Groq**, decidido pelo titular.
2. Release como tarball único `@frankframes/cli` em vez de 7 pacotes (EDT-65) — proposto; confirmar.
3. `engines` 22.18 (atual) contra "Node 20+" do EDT-2.
4. Rejeitar login do Codex com chave de API (só conta ChatGPT) — proposto conforme o EDT-59.
5. EDT-63 pós-1.0: host e catálogo público ou privado.

---

## Ordem global

Uma sessão de execução, um item por vez (`app.js`, `studio-server.ts` e `docs/contract.md` são
tocados por quase tudo). Cada item vira um commit depois de revisão e `node scripts/ci.ts` verde.

1. **A — Fase 0 + EDT-39** (relógio do preview).
2. **A — EDT-40** (áudio fiel no player).
   - **EDT-66** (achado no EDT-40): faixa toda em silêncio quebra o `loudnorm` (`measured_I=-inf`). Em
     `mixAudio`, quando a medição dá `-inf`, pular a normalização e devolver um aviso. Teste com
     `anullsrc`. Só toca `packages/producer/src/audio.ts`, os testes dele e o §9c, se mudar texto visível.
3. **B — Motion, em série:** EDT-49 (+ EDT-67, achado no gate: animação do autor corria em tempo real
   antes do primeiro seek; corrigido em `clock.ts` e goldens regenerados no mesmo commit) → **EDT-68**
   (`face.load().catch(() => {})` vira falha alta da prontidão com código e `hint`; só `clock.ts`, spec
   §9 e um teste com `@font-face` quebrado) → **EDT-69** (`.gitattributes` com `eol=lf` e binários marcados; causa do CRLF é `core.autocrlf=true` no gitconfig do sistema sem `.gitattributes`) → **EDT-70** (browser que cai rejeita tudo pendente com `E_BROWSER_CLOSED`; timeout explícito em seek/captura/prontidão; `ci.ts` com timeout por etapa que imprime o fim do log antes de matar) → 50 → 51 → 52 → **EDT-71** (CLI sem `process.exit()` no caminho de sucesso depois de I/O de rede: `captions` e qualquer outro comando que faça fetch passam a `process.exitCode`, como `setup`/`transcribe` já fazem; teste com processo filho contra servidor HTTP local) → 53 → 54 (contrato) → 55 → 54 (Studio) → 47 → 56.
4. **A — Studio, em série:** EDT-41 → 42 → 43 → 45 → 44 → 46.
5. **C — Onda 1:** EDT-62 medição (o executor para e devolve os números) → EDT-61 lote → EDT-58 skill e `frames`.
6. **C — EDT-59** `frankframes generate` (Codex), depois EDT-62 otimizações guiadas pela medição.
7. **C — EDT-64** aceite com o vídeo do titular (último antes do release).
8. **C — EDT-65** release 1.0.
- **Pós-1.0:** EDT-63.

Decisões já tomadas pelo planejamento (técnicas): release como tarball único `@frankframes/cli`;
`engines` Node ≥ 22.18; `generate` aceita só login do Codex com conta ChatGPT (nunca chave de API).
Decidido pelo titular: legendas do aceite (EDT-64) pela Groq, com `GROQ_API_KEY` no `.env` (o áudio do vídeo sai da máquina só nesse passo).

---

## EDT-77 — hardware com vários workers não reproduz hash na mesma máquina

**Medição (2026-11-24, `scripts/bench/hw-determinism-lab.ts`, 5 rodadas intercaladas, 240 frames):**
`base-w6` 110 frames instáveis · `w6-settle0` 103 · `w6-settle2` 128 · `w6-delay100` 152 · `w6-shared`
208 · `w1` 0 · **`w6-nogpucomp` 0** (com a CPU em 61–69%). O teto de 80 ms do `settlePaint` dispara em
≤ 2,3% das esperas e 108 dos 110 frames instáveis divergem sem ele: esperar mais (opção A) não resolve.
Custo da opção D: 47,8 → 45,7 fps (~5%).

**Decisão: opção D** — `--disable-gpu-compositing` também em hardware. O ANGLE continua no driver real
(WebGL e canvas na GPU); só o compositor passa a ser software, como já é em `software`. Não muda o padrão
`auto` nem a promessa do §9 ("igual nesta máquina" em hardware).

Passos:
1. `packages/engine/src/args.ts`: `gpuFlags("hardware", …)` inclui `--disable-gpu-compositing` em win32,
   darwin e linux. Teste unitário dos três: falha sem a mudança.
2. Medir no lab `w6-nogpucomp` contra `w6-nogpucomp-settle0` (sem a espera extra da captura em hardware,
   `capture.ts:404`). Se o settle0 der 0 instáveis em 5 rodadas, apagar a espera extra (menos código, mais
   rápido) e o comentário de `capture.ts:83`; se não der, manter.
3. `docs/contract.md` §9 item 6: hardware também com `--disable-gpu-compositing`, com o motivo e os números
   acima; reescrever a frase da "espera a mais" conforme o passo 2. Composição com vídeo continua em
   software (não medido com D; fica como está).
4. `packages/producer/test/hw-determinism.test.ts` entra no commit e fica verde; o lab
   (`scripts/bench/hw-determinism-lab.ts`) entra também, com os experimentos atuais.
5. Robustez: rodar o `hw-determinism.test.ts` 3× com carga artificial de CPU em paralelo (o sintoma
   original aparecia sob carga) e 1× `FF_GPU=1` em `determinism.test.ts` ("determinismo em hardware forçado").
6. Goldens rodam em `software` (`packages/catalog/test/goldens.test.ts`): não mudam. Gate completo verde.

---

## EDT-13 — gate em modo software em duas máquinas (Windows + Linux x64 em Docker)

Decisão do titular (2026-11-24): a segunda máquina é Linux nesta mesma máquina; ele autorizou os downloads
num contêiner Docker (WSL2): `node:24-bookworm`, libs do Chrome pelo apt, `chrome-headless-shell`
158.0.8127.36 linux64 e o FFmpeg LGPL linux64 do BtbN. Limitação declarada: mesma CPU. EDT-5, 19, 34 e 63
ficam pós-1.0.

Fatos: o browser (`packages/engine/src/pin.ts`) e o FFmpeg (`packages/encode/src/ffmpeg-build.ts`) só
têm pin `win64`. O FFmpeg aponta para `releases/download/latest/…`, que é móvel: o SHA-256 pinado deixa de
bater quando o BtbN publica outro build, e uma instalação nova falha (alto, mas falha). Isso bloqueia o
release do EDT-65 também.

Passos:
1. **Pins por plataforma.** `PINNED_BROWSER` e `FFMPEG_BUILD` viram tabelas por plataforma
   (`win64`, `linux64`), com um seletor que falha alto com código e `hint` em plataforma sem pin
   (`E_PLATFORM_UNSUPPORTED` ou equivalente, registrado no catálogo de diagnósticos). Mesma versão do Chrome
   nas duas.
2. **FFmpeg em tag imutável.** Trocar `latest` por uma release datada do BtbN (`autobuild-AAAA-MM-DD-…`) que
   tenha `win64-lgpl-8.1` e `linux64-lgpl-8.1`. Se a versão atual (`n8.1.3-39-g660b5aa7db`) não existir em tag
   datada, re-pinar as duas plataformas na mesma tag nova; registrar em `PROVENANCE.md`/`THIRD-PARTY-NOTICES.md`.
   O tar.xz do Linux precisa de extração (`tar -xJf`); a guarda de licença (sem `--enable-gpl`) roda nos dois.
3. **Linux funcionando.** `setup`, `doctor`, `browser install`, `render` e o gate completo no contêiner.
   Dockerfile em `scripts/linux/Dockerfile` (só libs do sistema e Node; nada de npm global além do
   projeto), e `scripts/linux/gate.ps1` ou `.ts` que monta o checkout **somente leitura** (cópia para
   dentro do contêiner, `node_modules` próprio) e roda `node scripts/ci.ts`. Sem GitHub Actions, sem
   serviço externo.
4. **Comparação.** O gate em `software` dos dois lados; `catalog/goldens.json` é o manifest. Relatório
   em `docs/determinismo-plataformas.md`: quantos frames com hash idêntico entre Windows e Linux, quantos
   só passam por PSNR (≥ 50 dB) e quais falham. Diferença por fonte/rasterização vira achado documentado,
   não ajuste de golden. Se algum golden falha no Linux, parar e devolver ao planejador.
5. Spec: `docs/contract.md` §9 (GPU/plataformas) diz que Linux x64 é suportado e o que foi medido.
6. Teste unitário dos seletores de pin (plataforma sem pin falha alto) e do caminho tar.xz. Gate completo
   verde no Windows e no Linux.
