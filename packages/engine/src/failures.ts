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

export function classifyFailure(error: unknown): ClassifiedFailure {
  const message = error instanceof Error ? error.message : String(error);
  for (const rule of RULES) {
    if (rule.test.test(message)) return { kind: rule.kind, code: rule.code, message, retryable: rule.retryable };
  }
  return { kind: "unknown", code: "E_UNKNOWN", message, retryable: false };
}

/** Repete uma vez somente se a falha for transiente ou timeout. */
export async function retryOnceIfTransient<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (!classifyFailure(error).retryable) throw error;
    return operation();
  }
}
