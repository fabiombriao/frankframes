// FrankFrames — proprietário. Ver LICENSE na raiz.
export interface FaceBox {
  x: number;
  y: number;
  width: number;
  height: number;
  score: number;
}

export interface FaceSample {
  time: number;
  faces: FaceBox[];
}

type Point = { x: number; y: number };
type CameraKey = { time: number; zoom: number; focusX: number; focusY: number; curve: "linear" };
export type FaceTracks = ReturnType<typeof trackFaces>;

const digits = (value: number): number => Number(value.toFixed(6));
const clamp = (value: number): number => Math.max(0, Math.min(1, value));

/** A câmera é fixa. A posição horizontal define o painel e impede trocas durante uma oclusão. */
export function trackFaces(samples: FaceSample[], aspect: number) {
  const panelAspect = 1080 / 960;
  const zoom = digits(Math.max(1.35, Math.min(4, panelAspect / (aspect * 0.44))));
  const margin = 1 - 1 / zoom;
  const width = Math.min(1, panelAspect / aspect);
  const height = Math.min(1, aspect / panelAspect) / zoom;

  const build = (side: "esquerda" | "direita") => {
    const position = side === "esquerda" ? 0 : 1;
    const fittedCenter = ((1 - width) * position + width / 2) / zoom;
    let previous: Point | undefined;
    let found = 0;
    const keys: Array<CameraKey | undefined> = samples.map(({ time, faces }) => {
      const eligible = faces.filter(({ x, width }) => (x + width / 2 < 0.5) === (side === "esquerda"));
      const point = ({ x, y, width, height }: FaceBox): Point => ({ x: x + width / 2, y: y + height / 2 });
      const rank = (face: FaceBox): number => {
        if (previous === undefined) return face.score;
        const center = point(face);
        return face.score - 3 * Math.hypot(center.x - previous.x, center.y - previous.y);
      };
      const selected = eligible.reduce<FaceBox | undefined>((best, face) =>
        best === undefined || rank(face) > rank(best) ? face : best, undefined);
      if (selected !== undefined) {
        const next = point(selected);
        found++;
        previous = previous === undefined ? next : {
          x: previous.x * 0.58 + next.x * 0.42,
          y: previous.y * 0.58 + next.y * 0.42,
        };
      }
      if (previous === undefined) return undefined;
      return {
        time, zoom,
        focusX: digits(clamp((previous.x - fittedCenter) / margin)),
        focusY: digits(clamp((previous.y + height * 0.12 - 0.5 / zoom) / margin)),
        curve: "linear",
      };
    });
    const first = keys.find((key) => key !== undefined);
    if (first === undefined || found < Math.min(2, samples.length)) {
      throw new Error(`rastreio sem detecções suficientes no lado ${side}; escolha um trecho em que os dois rostos aparecem`);
    }
    return {
      found,
      position,
      keys: keys.map((key, index) => key ?? { ...first, time: samples[index]!.time }),
    };
  };
  return { left: build("esquerda"), right: build("direita") };
}

export function faceComposition(media: string, start: number, duration: number, tracks: FaceTracks, swapped = false): string {
  const safe = media.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
  const top = swapped ? tracks.right : tracks.left;
  const bottom = swapped ? tracks.left : tracks.right;
  return `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><title>Podcast vertical</title>
<style>
html,body{margin:0}
[data-portrait-stack]{position:relative;width:1080px;height:1920px;overflow:hidden}
[data-portrait-stack]>video{position:absolute;left:0;width:100%;height:50%;object-fit:cover;object-position:50% 50%}
#rosto-superior{top:0}
#rosto-inferior{top:50%}
</style></head><body>
<main data-composition-id="podcast-vertical" data-portrait-stack data-width="1080" data-height="1920" data-fps="30" data-duration="${duration}">
  <video id="rosto-superior" data-clip-id="rosto-superior" src="${safe}" style="object-position:${top.position * 100}% 50%" data-start="0" data-duration="${duration}" data-offset="${start}" data-track="0"
    data-keyframes='${JSON.stringify(top.keys)}' playsinline></video>
  <video id="rosto-inferior" data-clip-id="rosto-inferior" src="${safe}" style="object-position:${bottom.position * 100}% 50%" data-start="0" data-duration="${duration}" data-offset="${start}" data-track="1"
    data-keyframes='${JSON.stringify(bottom.keys)}' data-has-audio="false" muted playsinline></video>
</main></body></html>
`;
}
