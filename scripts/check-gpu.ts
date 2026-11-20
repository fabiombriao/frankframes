// FrankFrames — proprietário. Ver LICENSE na raiz.
import { probeRenderer, resolveChrome } from "@frankframes/engine";

const chrome = await resolveChrome();
const probe = await probeRenderer(chrome.path);
const decided = probe.hardware ? "hardware" : "software";

process.stdout.write(`chrome    ${chrome.path}\n`);
process.stdout.write(`versão    ${chrome.version}\n`);
process.stdout.write(`renderer  ${probe.renderer}\n`);
process.stdout.write(`modo auto ${decided}${probe.hardware ? "" : " (fallback SwiftShader: sem GPU utilizável)"}\n`);
