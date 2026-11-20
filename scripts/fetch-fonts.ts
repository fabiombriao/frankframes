// FrankFrames — proprietário. Ver LICENSE na raiz.
/** Instala as fontes do catálogo em `vendor/fonts` (ou FRANKFRAMES_HOME). */
import { runSetup } from "../packages/cli/src/setup.ts";

process.exit(await runSetup({ fontsOnly: true }));
