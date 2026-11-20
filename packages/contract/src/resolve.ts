// FrankFrames — proprietário. Ver LICENSE na raiz.
import type { Diagnostic, DurationResolution, RawClip, ResolvedClip } from "./types.ts";
import { CODES, diag } from "./errors.ts";

/** Um frame a 60 fps não é duração. Mesmo piso para toda composição. */
export const MIN_DURATION_SECONDS = 1 / 60;

/**
 * Resolve `data-start` de todos os clips. Referência sempre aponta para o FIM
 * do alvo; offset e ciclos são resolvidos por DFS com memoização.
 */
export function resolveClips(clips: RawClip[], diagnostics: Diagnostic[]): ResolvedClip[] {
  const byId = new Map<string, RawClip>();
  const index = (list: RawClip[]): void => {
    for (const c of list) {
      byId.set(c.id, c);
      index(c.children);
    }
  };
  index(clips);

  const starts = new Map<string, number | undefined>();
  const visiting = new Set<string>();

  const startOf = (id: string): number | undefined => {
    if (starts.has(id)) return starts.get(id);
    const clip = byId.get(id);
    if (!clip) return undefined;
    if (visiting.has(id)) {
      diagnostics.push(
        diag(CODES.REF_CYCLE, "error", `referência circular em data-start: "${id}"`, {
          clipId: id,
          hint: "um clip não pode começar no fim de si mesmo, direta ou indiretamente",
        }),
      );
      starts.set(id, undefined);
      return undefined;
    }

    visiting.add(id);
    let start: number | undefined;
    if (clip.startExpr.kind === "absolute") {
      start = clip.startExpr.value;
    } else {
      const target = byId.get(clip.startExpr.refId);
      if (!target) {
        diagnostics.push(
          diag(CODES.REF_UNKNOWN, "error", `data-start de "${id}" referencia id inexistente: "${clip.startExpr.refId}"`, {
            clipId: id,
            hint: "referências apontam para data-clip-id ou data-composition-id de outro clip",
          }),
        );
      } else {
        const targetStart = startOf(target.id);
        if (targetStart === undefined) {
          starts.set(id, undefined);
          visiting.delete(id);
          return undefined;
        }
        if (target.authoredDuration === undefined) {
          diagnostics.push(
            diag(CODES.REF_UNRESOLVED, "error", `"${id}" começa no fim de "${target.id}", que não tem duração`, {
              clipId: id,
              hint: 'declare data-duration no alvo ou use um start absoluto',
            }),
          );
        } else {
          start = targetStart + target.authoredDuration + clip.startExpr.offset;
        }
      }
    }
    visiting.delete(id);

    if (start !== undefined && start < 0) {
      diagnostics.push(diag(CODES.START_NEGATIVE, "warning", `data-start de "${id}" resultou negativo; ajustado para 0`, { clipId: id }));
      start = 0;
    }
    starts.set(id, start);
    return start;
  };

  const build = (list: RawClip[]): ResolvedClip[] =>
    list.map((clip) => {
      const start = startOf(clip.id);
      const resolved: ResolvedClip = { ...clip, children: build(clip.children) };
      if (start !== undefined) {
        resolved.start = start;
        if (clip.authoredDuration !== undefined) resolved.end = start + clip.authoredDuration;
      }
      return resolved;
    });

  return build(clips);
}

/**
 * Duração da composição. Autoral vence; senão deriva do maior `end`.
 * Nunca estima: se qualquer clip não tem início ou duração, devolve `unresolved`
 * com a lista exata do que falta.
 */
export function resolveDuration(clips: ResolvedClip[], authored: number | undefined): DurationResolution {
  if (authored !== undefined && authored > 0) return { kind: "authored", seconds: authored };
  if (clips.length === 0) return { kind: "unresolved", reason: "empty", pending: [] };

  // Filhos de sub-composição também precisam de duração: sem `end`, o clock
  // mantém o clip visível até o fim da composição pai.
  const all: ResolvedClip[] = [];
  const collect = (list: ResolvedClip[]): void => {
    for (const clip of list) {
      all.push(clip);
      collect(clip.children);
    }
  };
  collect(clips);

  const invalid = all.filter((c) => c.start === undefined).map((c) => c.id);
  if (invalid.length > 0) return { kind: "unresolved", reason: "invalid-start", pending: invalid };

  const pending = all.filter((c) => c.authoredDuration === undefined).map((c) => c.id);
  if (pending.length > 0) return { kind: "unresolved", reason: "pending-clips", pending };

  const seconds = Math.max(...clips.map((c) => (c.end ?? c.start ?? 0)));
  return { kind: "derived", seconds: Math.max(seconds, MIN_DURATION_SECONDS) };
}

/** Preenche duração de mídia medida por probe. Contrato puro: sem I/O. */
export function withMediaDurations(clips: RawClip[], known: Record<string, number>): RawClip[] {
  return clips.map((clip) => {
    const measured = clip.authoredDuration === undefined ? known[clip.id] : undefined;
    const next: RawClip = { ...clip, children: withMediaDurations(clip.children, known) };
    if (measured !== undefined && measured > 0) next.authoredDuration = measured;
    return next;
  });
}

/** `frame -> segundos`, na grade exata do fps. O `1e-9` mata erro de float na fronteira. */
export function timeOfFrame(frame: number, fps: { num: number; den: number }): number {
  return (frame * fps.den) / fps.num + 1e-9;
}

/** `segundos -> frame`, com o mesmo `1e-9` para não cair no frame anterior. */
export function frameOfTime(seconds: number, fps: { num: number; den: number }): number {
  return Math.floor((seconds * fps.num) / fps.den + 1e-9);
}
