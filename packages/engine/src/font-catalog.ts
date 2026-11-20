// FrankFrames — proprietário. Ver LICENSE na raiz.
/**
 * Catálogo de fontes embarcadas. Todas SIL Open Font License 1.1 (Google Fonts).
 * Fontes proprietárias de editores (as que exigem licença paga) não entram aqui.
 */
export interface FontFamily {
  /** Nome usado pelo autor em `font-family`. */
  name: string;
  /** Pacote `@fontsource/*` de onde os arquivos vêm. */
  pkg: string;
  /** Prefixo dos arquivos em `vendor/fonts`. */
  slug: string;
  weights: number[];
  /** Classificação para o autor escolher: sans, serif, display, script, mono. */
  kind: "sans" | "serif" | "display" | "script" | "mono";
}

export const FONT_CATALOG: FontFamily[] = [
  { name: "Inter", pkg: "inter", slug: "inter", weights: [400, 700], kind: "sans" },
  { name: "Poppins", pkg: "poppins", slug: "poppins", weights: [400, 600, 700], kind: "sans" },
  { name: "Montserrat", pkg: "montserrat", slug: "montserrat", weights: [400, 700], kind: "sans" },
  { name: "Roboto", pkg: "roboto", slug: "roboto", weights: [400, 700], kind: "sans" },
  { name: "Assistant", pkg: "assistant", slug: "assistant", weights: [400, 700], kind: "sans" },
  { name: "DM Sans", pkg: "dm-sans", slug: "dm-sans", weights: [400, 700], kind: "sans" },
  { name: "Manrope", pkg: "manrope", slug: "manrope", weights: [400, 700], kind: "sans" },
  { name: "Nunito", pkg: "nunito", slug: "nunito", weights: [400, 700], kind: "sans" },
  { name: "Raleway", pkg: "raleway", slug: "raleway", weights: [400, 700], kind: "sans" },
  { name: "Space Grotesk", pkg: "space-grotesk", slug: "space-grotesk", weights: [400, 700], kind: "sans" },
  { name: "Oswald", pkg: "oswald", slug: "oswald", weights: [400, 700], kind: "display" },
  { name: "Bebas Neue", pkg: "bebas-neue", slug: "bebas-neue", weights: [400], kind: "display" },
  { name: "Anton", pkg: "anton", slug: "anton", weights: [400], kind: "display" },
  { name: "Alfa Slab One", pkg: "alfa-slab-one", slug: "alfa-slab-one", weights: [400], kind: "display" },
  { name: "Bangers", pkg: "bangers", slug: "bangers", weights: [400], kind: "display" },
  { name: "Righteous", pkg: "righteous", slug: "righteous", weights: [400], kind: "display" },
  { name: "Permanent Marker", pkg: "permanent-marker", slug: "permanent-marker", weights: [400], kind: "display" },
  { name: "Playfair Display", pkg: "playfair-display", slug: "playfair-display", weights: [400, 700], kind: "serif" },
  { name: "Lora", pkg: "lora", slug: "lora", weights: [400, 700], kind: "serif" },
  { name: "Merriweather", pkg: "merriweather", slug: "merriweather", weights: [400, 700], kind: "serif" },
  { name: "Great Vibes", pkg: "great-vibes", slug: "great-vibes", weights: [400], kind: "script" },
  { name: "Dancing Script", pkg: "dancing-script", slug: "dancing-script", weights: [400, 700], kind: "script" },
  { name: "Caveat", pkg: "caveat", slug: "caveat", weights: [400, 700], kind: "script" },
  { name: "Lobster", pkg: "lobster", slug: "lobster", weights: [400], kind: "script" },
  { name: "JetBrains Mono", pkg: "jetbrains-mono", slug: "jetbrains-mono", weights: [400, 700], kind: "mono" },
];

/** Nome do arquivo servido em `/__ff_fonts/`. */
export function fontFileName(family: FontFamily, weight: number): string {
  return `${family.slug}-latin-${weight}-normal.woff2`;
}
