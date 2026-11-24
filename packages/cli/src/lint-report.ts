// FrankFrames — proprietário. Ver LICENSE na raiz.
import { loadComposition } from "@frankframes/contract";
import type { Diagnostic } from "@frankframes/contract";

/** Objeto do `frankframes lint --json`. O `generate` usa a mesma função: o agente e a CLI leem o mesmo formato. */
export interface LintReport {
  file: string;
  ok: boolean;
  id: string;
  fps: { num: number; den: number };
  duration: ReturnType<typeof loadComposition>["duration"];
  clips: Array<{ id: string; start: number | null | undefined; end: number | null | undefined; media: boolean; sub: boolean }>;
  diagnostics: Diagnostic[];
}

/** Valida o HTML contra o contrato e devolve exatamente o que o `lint --json` imprime. */
export function lintReport(html: string, file: string): LintReport {
  const composition = loadComposition(html);
  return {
    file,
    ok: composition.ok,
    id: composition.id,
    fps: composition.fps,
    duration: composition.duration,
    clips: composition.clips.map((c) => ({ id: c.id, start: c.start, end: c.end, media: c.isMedia, sub: c.isSubComposition })),
    diagnostics: composition.diagnostics,
  };
}
