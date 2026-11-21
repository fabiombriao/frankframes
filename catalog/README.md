# Catálogo

36 blocos prontos. Gerado por `node scripts/generate-catalog.ts` a partir de
`meta.json`, `index.html` e `thumb.png` de cada bloco. Não edite à mão.

```bash
frankframes blocks list
frankframes blocks add <slug> <destino>
frankframes blocks add https://exemplo/bloco <destino>   # exige sha256 no meta.json
```

| Bloco | Formato | Duração | Descrição | Thumb |
|---|---|---:|---|---|
| [`chapter-transition`](blocks/chapter-transition/index.html) | 16:9 | 3.2s | Transição de capítulo — Número de capítulo em Anton deslizando sobre vermelho chapado, com filete amarelo e saída em fade. | ![chapter-transition](blocks/chapter-transition/thumb.png) |
| [`chart-bars`](blocks/chart-bars/index.html) | 16:9 | 4s | Gráfico de barras — Barras horizontais com rótulos fortes e crescimento escalonado sobre grade editorial. | ![chart-bars](blocks/chart-bars/thumb.png) |
| [`code-snippet`](blocks/code-snippet/index.html) | 16:9 | 4.5s | Trecho de código — Painel escuro monoespaçado com linhas numeradas por contador CSS, realce de sintaxe e nota técnica. | ![code-snippet](blocks/code-snippet/thumb.png) |
| [`comparison`](blocks/comparison/index.html) | 16:9 | 4s | Comparação antes/depois — Duas colunas em contraste direto, separadas por costura vermelha, com duração em numeral gigante. | ![comparison](blocks/comparison/thumb.png) |
| [`countdown`](blocks/countdown/index.html) | 16:9 | 3s | Contagem 3–2–1 — Três números em Anton, um clip por segundo, com anel de mira e legendas curtas de set. | ![countdown](blocks/countdown/thumb.png) |
| [`cta`](blocks/cta/index.html) | 16:9 | 3.6s | Chamada com botão — Chamada de ação com headline, botão de borda e preenchimento animado, linha de apoio e preço. | ![cta](blocks/cta/thumb.png) |
| [`image-frame`](blocks/image-frame/index.html) | 16:9 | 3.5s | Moldura de imagem — Paisagem abstrata em CSS dentro de passe-partout, com legenda de arquivo e marcas de corte. | ![image-frame](blocks/image-frame/thumb.png) |
| [`list-reveal`](blocks/list-reveal/index.html) | 16:9 | 4s | Lista revelada — Três notas numeradas entram em sequência sobre verde profundo, separadas por fios finos. | ![list-reveal](blocks/list-reveal/thumb.png) |
| [`logo-lockup`](blocks/logo-lockup/index.html) | 16:9 | 3s | Assinatura de marca — Monograma em CSS com hastes e braço, wordmark grande, assinatura do estúdio e rodapé de contato. | ![logo-lockup](blocks/logo-lockup/thumb.png) |
| [`lower-third`](blocks/lower-third/index.html) | 16:9 | 3s | Legenda de identificação — Faixa amarela de alto contraste para nome e cargo, com entrada deslizada. | ![lower-third](blocks/lower-third/thumb.png) |
| [`news-ticker`](blocks/news-ticker/index.html) | 16:9 | 4.2s | Faixa de manchetes — Faixa horizontal escura que desliza por três manchetes com separadores, relógio estático e indicadores. | ![news-ticker](blocks/news-ticker/thumb.png) |
| [`outro`](blocks/outro/index.html) | 16:9 | 3s | Cartão final — Encerramento em vermelho com tipografia gigante, monograma preto e assinatura da marca. | ![outro](blocks/outro/thumb.png) |
| [`photo-grid`](blocks/photo-grid/index.html) | 16:9 | 4.2s | Mosaico de fotos — Quatro retângulos chapados em mosaico, revelados por máscara de corte com legendas curtas. | ![photo-grid](blocks/photo-grid/thumb.png) |
| [`progress-bar`](blocks/progress-bar/index.html) | 16:9 | 4s | Barra de progresso — Barra que preenche de 0 a 100% com escala, marcação de ticks e legenda técnica de render. | ![progress-bar](blocks/progress-bar/thumb.png) |
| [`pull-quote`](blocks/pull-quote/index.html) | 16:9 | 4s | Citação em destaque — Citação longa em serifa itálica sobre fundo tinta, com barra vermelha e atribuição em duas colunas. | ![pull-quote](blocks/pull-quote/thumb.png) |
| [`quote`](blocks/quote/index.html) | 16:9 | 4.5s | Citação editorial — Citação em serifa grande sobre papel, com aspas descomunais e atribuição em monoespaçada. | ![quote](blocks/quote/thumb.png) |
| [`section-header`](blocks/section-header/index.html) | 16:9 | 4s | Cabeçalho de seção — Abertura de capítulo com índice gigante, título em duas linhas reveladas por máscara e fio superior. | ![section-header](blocks/section-header/thumb.png) |
| [`stat-counter`](blocks/stat-counter/index.html) | 16:9 | 3.5s | Contador estatístico — Número gigante com dígitos em odômetro CSS, sublinhado vermelho e leitura de contexto. | ![stat-counter](blocks/stat-counter/thumb.png) |
| [`subtitles`](blocks/subtitles/index.html) | 16:9 | 4.5s | Legendas sequenciais — Três legendas encadeadas por referência de tempo, sobre cena escura com marcação de segurança. | ![subtitles](blocks/subtitles/thumb.png) |
| [`testimonial`](blocks/testimonial/index.html) | 16:9 | 4.2s | Depoimento serifado — Citação em Lora sobre fundo escuro, aspas em vermelho e atribuição com nome e empresa. | ![testimonial](blocks/testimonial/thumb.png) |
| [`timeline`](blocks/timeline/index.html) | 16:9 | 4.5s | Linha do tempo — Quatro marcos sobre eixo horizontal: anos em condensada, rótulos centrados e progressão animada. | ![timeline](blocks/timeline/thumb.png) |
| [`title-card`](blocks/title-card/index.html) | 16:9 | 4s | Cartão de título — Abertura editorial de alto contraste com tipografia condensada e régua de metadados. | ![title-card](blocks/title-card/thumb.png) |
| [`vertical-captions`](blocks/vertical-captions/index.html) | 9:16 | 3.6s | Legendas empilhadas — Três legendas verticais entram em sequência com falante, tempo e margem segura de 96 px. | ![vertical-captions](blocks/vertical-captions/thumb.png) |
| [`vertical-chart`](blocks/vertical-chart/index.html) | 9:16 | 4s | Gráfico vertical — Colunas 9:16 crescendo sobre linha de base, com grade discreta, rótulos e destaque no melhor trimestre. | ![vertical-chart](blocks/vertical-chart/thumb.png) |
| [`vertical-countdown`](blocks/vertical-countdown/index.html) | 9:16 | 3s | Contagem vertical — Contagem 3–1 em retrato, número centralizado em Anton com anel duplo, legenda por segundo e trilha de progresso. | ![vertical-countdown](blocks/vertical-countdown/thumb.png) |
| [`vertical-cta`](blocks/vertical-cta/index.html) | 9:16 | 3.4s | Chamada vertical — CTAs em retrato com headline grande, botão de preenchimento ascendente e seta em círculo desenhada em CSS. | ![vertical-cta](blocks/vertical-cta/thumb.png) |
| [`vertical-gallery`](blocks/vertical-gallery/index.html) | 9:16 | 3.8s | Galeria vertical — Três blocos de foto em CSS empilhados em retrato, entrando em stagger com recorte e numeração. | ![vertical-gallery](blocks/vertical-gallery/thumb.png) |
| [`vertical-image`](blocks/vertical-image/index.html) | 9:16 | 3.5s | Imagem vertical — Moldura 9:16 com paisagem desenhada em CSS — sol, serras e primeiro plano — e legenda de arquivo. | ![vertical-image](blocks/vertical-image/thumb.png) |
| [`vertical-list`](blocks/vertical-list/index.html) | 9:16 | 4.5s | Lista vertical — Lista numerada 9:16 com quatro regras, títulos grandes e filetes de separação escalonados. | ![vertical-list](blocks/vertical-list/thumb.png) |
| [`vertical-lower-third`](blocks/vertical-lower-third/index.html) | 9:16 | 3.5s | Crédito vertical — Identificação 9:16 com nome em condensada sobre faixa amarela, função e ficha em rodapé. | ![vertical-lower-third](blocks/vertical-lower-third/thumb.png) |
| [`vertical-outro`](blocks/vertical-outro/index.html) | 9:16 | 3s | Encerramento vertical — Cartão final 9:16 com monograma, despedida em serifa, assinatura manuscrita e chamada do próximo episódio. | ![vertical-outro](blocks/vertical-outro/thumb.png) |
| [`vertical-process`](blocks/vertical-process/index.html) | 9:16 | 4.2s | Processo vertical — Três passos em retrato com conector vertical que se desenha, números grandes e etiquetas de etapa. | ![vertical-process](blocks/vertical-process/thumb.png) |
| [`vertical-quote`](blocks/vertical-quote/index.html) | 9:16 | 4.5s | Citação vertical — Citação 9:16 em serifa itálica sobre tinta, aspas sangradas e atribuição com fio superior. | ![vertical-quote](blocks/vertical-quote/thumb.png) |
| [`vertical-stat`](blocks/vertical-stat/index.html) | 9:16 | 4s | Número vertical — Indicador 9:16 com numeral gigante, frase de apoio e medidor proporcional com escala. | ![vertical-stat](blocks/vertical-stat/thumb.png) |
| [`vertical-testimonial`](blocks/vertical-testimonial/index.html) | 9:16 | 4s | Depoimento vertical — Citação grande em Lora sobre preto, aspas vermelhas e atribuição com iniciais e regra de alto contraste. | ![vertical-testimonial](blocks/vertical-testimonial/thumb.png) |
| [`vertical-title`](blocks/vertical-title/index.html) | 9:16 | 3.5s | Título vertical — Abertura 9:16 com título condensado em três linhas mascaradas, grade lateral e ficha técnica no pé. | ![vertical-title](blocks/vertical-title/thumb.png) |
