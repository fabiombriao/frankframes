// FrankFrames — proprietário. Ver LICENSE na raiz.
export { CLOCK_SOURCE, injectClock } from "./clock.ts";
export { chromeArgs, gpuFlags } from "./args.ts";
export type { GpuMode, ResolvedGpuMode, Viewport } from "./args.ts";
export { resolveChrome, defaultChromeCandidates } from "./launch.ts";
export { probeRenderer, resolveGpuMode } from "./probe.ts";
export type { RendererInfo } from "./probe.ts";
export { startServer } from "./server.ts";
export type { StaticServer } from "./server.ts";
export { openSession } from "./capture.ts";
export type { Session, SessionOptions } from "./capture.ts";
