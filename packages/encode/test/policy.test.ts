import { test } from "node:test";
import assert from "node:assert/strict";
import {
  EncodePolicyError,
  PRESETS,
  assertCodecAllowed,
  assertDistributionSafe,
  buildFrameSequenceArgs,
  buildMuxArgs,
  containerFor,
  parseFacts,
} from "../src/policy.ts";

const VERSION_GPL = `ffmpeg version 9.0.2-full_build-www.gyan.dev Copyright (c) 2000-2026 the FFmpeg developers
built with gcc 16.2.0 (Rev3, Built by MSYS2 project)
configuration: --enable-gpl --enable-version3 --enable-shared --enable-libx264 --enable-libsvtav1 --enable-libvpx`;

const VERSION_LGPL = `ffmpeg version n8.1.3-39-g660b5aa7db Copyright (c) 2000-2026 the FFmpeg developers
built with gcc 15.2.0 (GCC)
configuration: --prefix=/ffbuild/prefix --enable-libsvtav1 --enable-libvpx --enable-libopenh264 --enable-libdav1d`;

const ENCODERS_LGPL = ` V....D libaom-av1           libaom AV1
 V..... libsvtav1            SVT-AV1 encoder
 V....D libopenh264          OpenH264 H.264
 V....D libvpx-vp9           libvpx VP9`;

const ENCODERS = `${ENCODERS_LGPL}
 V....D libx264              libx264 H.264`;

test("binário com --enable-gpl é recusado para distribuição", () => {
  const facts = parseFacts("ffmpeg-gpl", VERSION_GPL, ENCODERS);
  assert.ok(facts.configuration.includes("--enable-gpl"));
  assert.throws(
    () => assertDistributionSafe(facts),
    (err: unknown) => err instanceof EncodePolicyError && err.code === "E_FFMPEG_GPL",
  );
});

test("binário LGPL sem x264 passa", () => {
  const facts = parseFacts("ffmpeg-lgpl", VERSION_LGPL, ENCODERS_LGPL);
  assert.doesNotThrow(() => assertDistributionSafe(facts));
  assert.doesNotThrow(() => assertCodecAllowed(facts, { codec: "av1" }));
  assert.doesNotThrow(() => assertCodecAllowed(facts, { codec: "vp9" }));
});

test("encoder GPL no binário é erro mesmo sem --enable-gpl declarado", () => {
  const facts = parseFacts("ffmpeg-custom", VERSION_LGPL, ENCODERS);
  assert.throws(
    () => assertDistributionSafe(facts),
    (err: unknown) => err instanceof EncodePolicyError && err.code === "E_GPL_ENCODER",
  );
});

test("H.264 exige opt-in explícito e libopenh264", () => {
  const lgpl = parseFacts("ffmpeg-lgpl", VERSION_LGPL, ENCODERS_LGPL);
  assert.throws(
    () => assertCodecAllowed(lgpl, { codec: "h264" }),
    (err: unknown) => err instanceof EncodePolicyError && err.code === "E_H264_NOT_OPTED_IN",
  );
  assert.doesNotThrow(() => assertCodecAllowed(lgpl, { codec: "h264", allowH264: true }));

  const semVp9 = parseFacts("ffmpeg-x", VERSION_LGPL, " V..... libsvtav1            SVT-AV1 encoder");
  assert.throws(
    () => assertCodecAllowed(semVp9, { codec: "vp9" }),
    (err: unknown) => err instanceof EncodePolicyError && err.code === "E_ENCODER_MISSING",
  );
});

test("args de encode nunca citam encoder GPL e respeitam o container", () => {
  for (const preset of ["draft", "standard", "high"] as const) {
    for (const codec of ["av1", "vp9", "h264"] as const) {
      const args = buildFrameSequenceArgs({ framesDir: "f", fps: { num: 30, den: 1 }, codec, preset, outPath: "o" }).join(" ");
      assert.ok(!/x264|x265/.test(args), `preset ${preset}/${codec} citou encoder GPL`);
    }
  }
  assert.equal(containerFor("vp9"), "webm");
  assert.equal(containerFor("av1"), "mp4");
  assert.deepEqual(buildMuxArgs("vp9"), []);
  assert.deepEqual(buildMuxArgs("av1"), ["-movflags", "+faststart"]);

  const ntsc = buildFrameSequenceArgs({ framesDir: "f", fps: { num: 30000, den: 1001 }, codec: "av1", preset: "standard", outPath: "o" });
  assert.equal(ntsc[ntsc.indexOf("-framerate") + 1], "30000/1001");
  assert.equal(ntsc[ntsc.indexOf("-r") + 1], "30000/1001");
  assert.ok(ntsc.includes("-xerror"));
});

test("presets são monotônicos em qualidade", () => {
  assert.ok(PRESETS.draft.av1.crf > PRESETS.standard.av1.crf);
  assert.ok(PRESETS.standard.av1.crf > PRESETS.high.av1.crf);
  assert.ok(PRESETS.draft.vp9.crf > PRESETS.standard.vp9.crf);
  assert.ok(PRESETS.standard.vp9.crf > PRESETS.high.vp9.crf);
});
