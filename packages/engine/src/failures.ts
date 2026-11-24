// FrankFrames — proprietário. Ver LICENSE na raiz.
/**
 * Classificação de falha. Retry é decisão de classificação, nunca de contador:
 * repetir um erro de autoria só gasta tempo e esconde o bug.
 */
export type FailureKind =
  | "cancelled"
  | "transient"
  | "timeout"
  | "memory"
  | "verification"
  | "authoring"
  | "io"
  | "unknown";

export interface ClassifiedFailure {
  kind: FailureKind;
  /** Só `transient` e `timeout` podem ser repetidos. */
  retryable: boolean;
  code: string;
  message: string;
}

/** Códigos de falha do browser da sessão de captura. Estáveis: viram código de render. */
export type BrowserErrorCode = "E_BROWSER_CLOSED" | "E_BROWSER_TIMEOUT";

/**
 * Falha do browser da sessão (caiu ou parou de responder). Carrega código estável e
 * `hint` acionável; o texto do hint já vai dentro da `message`, que é o que chega ao usuário.
 */
export class BrowserError extends Error {
  readonly code: BrowserErrorCode;
  readonly hint: string;

  constructor(code: BrowserErrorCode, message: string, hint: string, options?: { cause?: unknown }) {
    super(`${code}: ${message} (${hint})`, options);
    this.name = "BrowserError";
    this.code = code;
    this.hint = hint;
  }
}

/**
 * Códigos que `classifyFailure` devolve além de E_FONT_LOAD e E_BROWSER_* (já em RENDER_ERROR_CODES).
 * Entram no `docs/reference/diagnostics.md`.
 */
export const FAILURE_ERROR_CODES = [
  "E_CANCELLED",
  "E_PROTOCOL",
  "E_TIMEOUT",
  "E_MEMORY",
  "E_IMAGE_MISSING",
  "E_AUTHORING",
  "E_IO",
  "E_UNKNOWN",
] as const;

const RULES: Array<{ test: RegExp; kind: FailureKind; code: string; retryable: boolean }> = [
  // Fonte declarada que não carrega é erro de autoria; a regra vem antes de "não carregou" (imagem).
  { test: /E_FONT_LOAD/, kind: "authoring", code: "E_FONT_LOAD", retryable: false },
  // Timeout do browser: a página parou de responder; repetir só gasta o mesmo tempo outra vez.
  { test: /E_BROWSER_TIMEOUT/, kind: "timeout", code: "E_BROWSER_TIMEOUT", retryable: false },
  { test: /aborted|cancelled|canceled|interrupted/i, kind: "cancelled", code: "E_CANCELLED", retryable: false },
  { test: /E_BROWSER_CLOSED|TargetCloseError|Session closed|Connection closed|browser has disconnected/i, kind: "transient", code: "E_BROWSER_CLOSED", retryable: true },
  { test: /Another frame is pending|Protocol error/i, kind: "transient", code: "E_PROTOCOL", retryable: true },
  { test: /timed out|timeout|Timeout/i, kind: "timeout", code: "E_TIMEOUT", retryable: true },
  { test: /out of memory|heap|ENOMEM|OOM/i, kind: "memory", code: "E_MEMORY", retryable: false },
  { test: /Image.*failed to load|não carregou/i, kind: "verification", code: "E_IMAGE_MISSING", retryable: false },
  { test: /data-start|contrato|composition/i, kind: "authoring", code: "E_AUTHORING", retryable: false },
  { test: /ENOENT|EACCES|EBUSY|EPERM|no such file/i, kind: "io", code: "E_IO", retryable: false },
];

/**
 * `E_FONT_LOAD` que é só a rede do Chrome falhando: toda face reprovada com "A network error occurred" e
 * nenhuma falha registrada pelo servidor local (`[servidor: …]` só existe quando ele registrou algo: 404 de
 * fonte, EBUSY, erro de leitura). Sem registro nenhum, o arquivo está certo e a requisição não chegou ao servidor
 * ou foi derrubada no caminho — falha de infraestrutura, não de autoria (EDT-72).
 */
export function isTransientFontNetworkFailure(message: string): boolean {
  const start = message.indexOf("E_FONT_LOAD: fonte declarada não carregou: ");
  if (start < 0 || message.includes("[servidor:")) return false;
  const body = message.slice(start + "E_FONT_LOAD: fonte declarada não carregou: ".length).split(/\r?\n/)[0] ?? "";
  const faces = body.replace(/ \(confira .*$/, "").split("; ");
  return faces.length > 0 && faces.every((face) => /\): A network error occurred\.?$/.test(face));
}

export function classifyFailure(error: unknown): ClassifiedFailure {
  const message = error instanceof Error ? error.message : String(error);
  if (isTransientFontNetworkFailure(message)) {
    return { kind: "transient", code: "E_FONT_LOAD", message, retryable: true };
  }
  for (const rule of RULES) {
    if (rule.test.test(message)) return { kind: rule.kind, code: rule.code, message, retryable: rule.retryable };
  }
  return { kind: "unknown", code: "E_UNKNOWN", message, retryable: false };
}

/**
 * Repete uma vez somente se a falha for transiente ou timeout. `onRetry` recebe a causa da primeira
 * tentativa: a repetição nunca é silenciosa, e a segunda falha é a que chega ao chamador.
 * `neverRetry` marca erros que a classificação por texto poderia confundir com falha do browser (ex.: a stderr
 * do FFmpeg citando "timeout"): esses sobem direto, sem segunda tentativa.
 */
export async function retryOnceIfTransient<T>(
  operation: () => Promise<T>,
  onRetry?: (cause: ClassifiedFailure) => void,
  neverRetry?: (error: unknown) => boolean,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (neverRetry?.(error) === true) throw error;
    const cause = classifyFailure(error);
    if (!cause.retryable) throw error;
    onRetry?.(cause);
    return operation();
  }
}
