// FrankFrames — proprietário. Ver LICENSE na raiz.
import { FONT_CATALOG, fontFileName } from "./font-catalog.ts";

export const FONT_BASE_URL = "/__ff_fonts";

/** Família usada quando o autor não declara nenhuma. */
export const DEFAULT_FONT = "Inter";

/**
 * CSS injetado antes de qualquer estilo do autor: declara todas as famílias do
 * catálogo e fixa a família padrão. Sem isso, `sans-serif` resolve para a fonte
 * do sistema e o pixel deixa de ser reprodutível.
 */
export function fontFaceCss(base: string = FONT_BASE_URL): string {
  const faces = FONT_CATALOG.flatMap((family) =>
    family.weights.map(
      (weight) =>
        `@font-face{font-family:"${family.name}";font-weight:${weight};font-style:normal;font-display:block;src:url("${base}/${fontFileName(family, weight)}") format("woff2")}`,
    ),
  );
  return [...faces, `html{font-family:"${DEFAULT_FONT}",sans-serif}`].join("\n");
}

/** Lista de arquivos que precisam existir em `vendor/fonts`. */
export function expectedFontFiles(): string[] {
  return FONT_CATALOG.flatMap((family) => family.weights.map((weight) => fontFileName(family, weight)));
}
