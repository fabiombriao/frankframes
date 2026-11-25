// FrankFrames — proprietário. Ver LICENSE na raiz.
/**
 * Rastro das etapas de um seek e da captura: o que transforma "o seek do frame 41 não respondeu" em "parou no
 * img.decode() de tal imagem" (EDT-91).
 *
 * A página anuncia cada etapa ANTES de entrar nela, por um binding do CDP (`__ff.stage`). A mensagem chega ao
 * Node mesmo que a thread fique presa logo depois, caso em que sonda nenhuma responde: perguntar só na hora do
 * estouro não serviria para um laço síncrono. No caminho feliz o custo é uma mensagem curta por etapa.
 */

/** Nome do binding que a sessão de captura instala na página. Sem ele (preview), `__ff.stage` não faz nada. */
export const STAGE_BINDING = "__ffStage";

const STAGE_LABELS: Record<string, string> = {
  send: "envio do pedido (a página não começou a executá-lo)",
  seek: "entrada do __ff.seek",
  "composition-scripts": "timers e requestAnimationFrame da composição",
  syncAnimations: "syncAnimations",
  "seek-hooks": "visibilidade e ganchos de seek",
  "video-frame-decode": "img.decode() de frame de vídeo",
  settle: "settle (requestAnimationFrame)",
  screenshot: "screenshot",
};

/** Teto da sonda feita depois do estouro: o prazo da operação já acabou. */
const PROBE_MS = 2_000;
const MAX_LISTED = 5;

export interface PendingState {
  images: Array<{ url: string; state: string }>;
  fonts: string[];
}

/** Roda DENTRO da página (é serializada pelo `evaluate`): não pode usar nada de fora do próprio corpo. */
export function probePendingState(): PendingState {
  const clock = (globalThis as unknown as { __ff?: { decoding?: Set<HTMLImageElement> } }).__ff;
  const images = new Map<string, string>();
  for (const image of Array.from(document.images)) {
    if (!image.complete) images.set(image.currentSrc || image.src, "carregando");
  }
  for (const image of clock?.decoding ?? []) {
    images.set(image.src, image.complete ? "carregada, decode sem resposta" : "carregando");
  }
  const fonts: string[] = [];
  document.fonts.forEach((face) => {
    if (face.status === "loading") fonts.push(face.family);
  });
  return { images: [...images].map(([url, state]) => ({ url, state })), fonts };
}

export interface StageTrail {
  /** Começo de um seek: guarda o frame e zera o rastro. */
  startSeek: (frame: number, seconds: number) => void;
  /** Etapa anunciada pela página ou pelo Node: `nome` ou `nome url url…`. */
  enter: (payload: string) => void;
  /** Frame do último seek pedido. */
  frame: () => number | undefined;
  /** Trecho da mensagem de estouro: frame, etapa, há quanto tempo e o que estava pendente. */
  describe: (probe: () => Promise<PendingState>) => Promise<string>;
}

const seconds = (value: number, digits: number): string => value.toFixed(digits).replace(".", ",");

/**
 * Nome curto do recurso, sem esquema, query nem fragmento (podem carregar token). Do próprio servidor sai o
 * caminho sem a barra inicial; de fora, host e caminho. Assim `sanitizeMessage` não apaga o nome.
 */
function resourceName(url: string, pageOrigin: string): string {
  if (!URL.canParse(url)) return url;
  const parsed = new URL(url);
  if (parsed.protocol === "data:" || parsed.protocol === "blob:") return `${parsed.protocol}…`;
  const path = parsed.pathname.replace(/^\//, "");
  return parsed.origin === pageOrigin ? path : `${parsed.host}/${path}`;
}

function list(items: string[]): string {
  const extra = items.length - MAX_LISTED;
  return `${items.slice(0, MAX_LISTED).join(", ")}${extra > 0 ? ` e mais ${extra}` : ""}`;
}

export function createStageTrail(pageUrl: string): StageTrail {
  const origin = new URL(pageUrl).origin;
  let seek: { frame: number; seconds: number } | undefined;
  let stage = "send";
  let requested: string[] = [];
  let since = performance.now();

  const enter = (payload: string): void => {
    const [name = "", ...urls] = payload.split(" ");
    stage = name;
    requested = urls;
    since = performance.now();
  };

  return {
    enter,
    startSeek: (frame, at) => {
      seek = { frame, seconds: at };
      enter("send");
    },
    frame: () => seek?.frame,
    describe: async (probe) => {
      // Retrato tirado na hora do estouro: a sonda leva até 2 s e a operação pode andar nesse meio-tempo.
      const stuck = { seek, label: STAGE_LABELS[stage] ?? stage, requested, elapsed: (performance.now() - since) / 1000 };
      const where = stuck.seek === undefined ? "" : `frame ${stuck.seek.frame} (t=${seconds(stuck.seek.seconds, 3)} s), `;
      const head = `; ${where}parou na etapa "${stuck.label}" há ${seconds(stuck.elapsed, 1)} s`;

      let timer: NodeJS.Timeout | undefined;
      const silence = new Promise<{ failure: string }>((done) => {
        timer = setTimeout(
          () =>
            done({
              failure: `a página não respondeu à sonda em ${PROBE_MS / 1000} s: thread principal presa (laço síncrono) ou renderer travado`,
            }),
          PROBE_MS,
        );
      });
      const answer = await Promise.race([
        probe().then(
          (state) => ({ state }),
          (error: unknown) => ({ failure: `a sonda da página falhou: ${error instanceof Error ? error.message : String(error)}` }),
        ),
        silence,
      ]);
      clearTimeout(timer);

      if (!("state" in answer)) {
        const asked = stuck.requested.map((url) => resourceName(url, origin));
        return `${head}; ${answer.failure}${asked.length > 0 ? `; <img> pedidas nessa etapa: ${list(asked)}` : ""}`;
      }
      const images = answer.state.images.map(({ url, state }) => `${resourceName(url, origin)} (${state})`);
      const fonts = answer.state.fonts.length > 0 ? `; fontes carregando: ${list(answer.state.fonts)}` : "";
      return `${head}; <img> pendentes: ${images.length > 0 ? list(images) : "nenhuma"}${fonts}`;
    },
  };
}
