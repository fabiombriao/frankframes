// FrankFrames — proprietário. Ver LICENSE na raiz.
import { assertDistributionSafe, assertCodecAllowed, detectFfmpeg } from "@frankframes/encode";

const binaries = process.argv.slice(2);
if (binaries.length === 0) {
  process.stderr.write("uso: node scripts/check-ffmpeg.ts <caminho-do-ffmpeg> [...]\n");
  process.exit(2);
}

let failed = false;
for (const binary of binaries) {
  try {
    const facts = await detectFfmpeg(binary);
    assertDistributionSafe(facts);
    assertCodecAllowed(facts, { codec: "av1" });
    assertCodecAllowed(facts, { codec: "vp9" });
    process.stdout.write(`OK    ${binary} · ${facts.version} · ${facts.encoders.length} encoders · av1+vp9 disponíveis\n`);
  } catch (error) {
    failed = true;
    const err = error as { code?: string; message?: string };
    process.stdout.write(`BLOQUEADO  ${binary} · ${err.code ?? "E_UNKNOWN"}: ${err.message}\n`);
  }
}
process.exit(failed ? 1 : 0);
