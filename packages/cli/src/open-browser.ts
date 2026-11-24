// FrankFrames — proprietário. Ver LICENSE na raiz.
import { spawn } from "node:child_process";

/** Comando e argumentos que abrem `url` no navegador padrão. Sem shell: a URL é um argumento, nunca texto de comando. */
export function openBrowserCommand(url: string, platform: NodeJS.Platform = process.platform): { command: string; args: string[] } {
  // `start` é interno do cmd; o `""` é o título da janela (sem ele `start` tomaria a URL como título).
  if (platform === "win32") return { command: "cmd", args: ["/c", "start", "", url] };
  if (platform === "darwin") return { command: "open", args: [url] };
  return { command: "xdg-open", args: [url] };
}

/** Abre a URL no navegador padrão. Falha ao abrir vira aviso no stderr (o servidor continua de pé). */
export function openBrowser(url: string): void {
  const { command, args } = openBrowserCommand(url);
  const child = spawn(command, args, { stdio: "ignore", detached: true, windowsHide: true });
  child.on("error", (error) => {
    process.stderr.write(`aviso: não consegui abrir o navegador (${error.message}); abra ${url} à mão\n`);
  });
  child.unref();
}
