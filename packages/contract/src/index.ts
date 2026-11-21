// FrankFrames — proprietário. Ver LICENSE na raiz.
import type { Composition, Diagnostic } from "./types.ts";
import { parseComposition } from "./parse.ts";
import { resolveClips, resolveDuration, withMediaDurations } from "./resolve.ts";
import { CODES, diag } from "./errors.ts";
import { resolveMotion } from "./motion/index.ts";

export type {
  Composition,
  Diagnostic,
  DurationResolution,
  Fps,
  MotionKey,
  MotionKind,
  MotionProp,
  MotionSource,
  MotionTarget,
  MotionTrack,
  RawClip,
  ResolvedClip,
  TimeExpr,
  VisualKeyframe,
} from "./types.ts";
export * from "./motion/index.ts";
export { CODES } from "./errors.ts";
export { parseComposition, findRoot, ATTRS } from "./parse.ts";
export { parseTimeExpr, parseFps } from "./timing.ts";
export { resolveClips, resolveDuration, withMediaDurations, timeOfFrame, frameOfTime, MIN_DURATION_SECONDS } from "./resolve.ts";

export interface LoadOptions {
  /** Durações medidas por probe, por id de clip. Sem isso, mídia fica pendente. */
  mediaDurations?: Record<string, number>;
}

/**
 * Única porta de entrada do contrato: HTML -> composição resolvida.
 * Falha alto: qualquer diagnóstico `error` deixa `ok: false` e o render não começa.
 */
export function loadComposition(html: string, options: LoadOptions = {}): Composition {
  const raw = parseComposition(html);
  const diagnostics: Diagnostic[] = [...raw.diagnostics];

  const clipsWithMedia = options.mediaDurations ? withMediaDurations(raw.clips, options.mediaDurations) : raw.clips;
  const clips = resolveClips(clipsWithMedia, diagnostics);
  const duration = resolveDuration(clips, raw.authoredDuration);
  const motion = resolveMotion(raw.motion, clips, duration, diagnostics);

  if (duration.kind === "unresolved" && raw.id !== "") {
    const why =
      duration.reason === "empty"
        ? "a composição não tem clips temporizados"
        : duration.reason === "invalid-start"
          ? "clips com data-start não resolvido"
          : "clips sem duração (declare data-duration ou informe mediaDurations)";
    diagnostics.push(
      diag(CODES.DURATION_UNRESOLVED, "error", `duração da composição não resolvida: ${why}`, {
        hint:
          duration.reason === "pending-clips"
            ? `faltam: ${duration.pending.slice(0, 5).join(", ")}${duration.pending.length > 5 ? "…" : ""}`
            : "declare data-duration na raiz para fixar a duração",
      }),
    );
  }

  return {
    id: raw.id,
    ...(raw.width !== undefined ? { width: raw.width } : {}),
    ...(raw.height !== undefined ? { height: raw.height } : {}),
    fps: raw.fps,
    clips,
    duration,
    motion,
    diagnostics,
    ok: diagnostics.every((d) => d.severity !== "error"),
  };
}
