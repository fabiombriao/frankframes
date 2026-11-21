// FrankFrames — proprietário. Ver LICENSE na raiz.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../src/index.ts";

/** Erro de sistema de arquivos com `code`, como o Node entrega. */
function fsError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: simulado`), { code });
}

async function siteWith(file: string, content: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ff-server-read-"));
  await writeFile(join(dir, file), content);
  return dir;
}

test("arquivo ausente continua 404, sem retry e sem entrar nos registros de falha", async () => {
  const dir = await siteWith("index.html", "<html></html>");
  let reads = 0;
  const server = await startServer(dir, {
    log: () => {},
    readFile: async () => {
      reads += 1;
      throw fsError("ENOENT");
    },
  });
  try {
    const response = await fetch(`${server.url}nao-existe.png`);
    assert.equal(response.status, 404);
    assert.equal(reads, 1, "ENOENT não se repete");
    assert.deepEqual(server.failures(), []);
  } finally {
    await server.close();
  }
});

test("EBUSY passageiro: o servidor repete, serve o arquivo e registra cada tentativa extra", async () => {
  const dir = await siteWith("index.html", "<html></html>");
  let reads = 0;
  const server = await startServer(dir, {
    log: () => {},
    readFile: async () => {
      reads += 1;
      if (reads <= 2) throw fsError("EBUSY");
      return Buffer.from("conteudo");
    },
  });
  try {
    const response = await fetch(`${server.url}dado.bin`);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "conteudo");
    assert.equal(reads, 3);
    assert.deepEqual(
      server.failures().map(({ path, code, attempt, outcome }) => ({ path, code, attempt, outcome })),
      [
        { path: "/dado.bin", code: "EBUSY", attempt: 1, outcome: "retry" },
        { path: "/dado.bin", code: "EBUSY", attempt: 2, outcome: "retry" },
      ],
    );
  } finally {
    await server.close();
  }
});

for (const code of ["EBUSY", "EPERM", "EACCES"]) {
  test(`${code} que não passa: no máximo 3 repetições, depois 500 com o código no corpo`, async () => {
    const dir = await siteWith("index.html", "<html></html>");
    let reads = 0;
    const server = await startServer(dir, {
      log: () => {},
      readFile: async () => {
        reads += 1;
        throw fsError(code);
      },
    });
    try {
      const started = Date.now();
      const response = await fetch(`${server.url}fonte.woff2`);
      const elapsed = Date.now() - started;
      assert.equal(response.status, 500);
      assert.match(await response.text(), new RegExp(code));
      assert.equal(reads, 4, "1 leitura + 3 repetições");
      assert.ok(elapsed >= 300, `espera 50+100+200 ms entre as tentativas, levou ${elapsed} ms`);
      const failures = server.failures();
      assert.deepEqual(
        failures.map((failure) => `${failure.attempt}:${failure.outcome}`),
        ["1:retry", "2:retry", "3:retry", "4:failed"],
      );
      assert.ok(failures.every((failure) => failure.code === code && failure.path === "/fonte.woff2"));
    } finally {
      await server.close();
    }
  });
}

test("outro erro de leitura (EMFILE) vira 500 com o código, sem retry", async () => {
  const dir = await siteWith("index.html", "<html></html>");
  let reads = 0;
  const server = await startServer(dir, {
    log: () => {},
    readFile: async () => {
      reads += 1;
      throw fsError("EMFILE");
    },
  });
  try {
    const response = await fetch(`${server.url}arquivo.bin`);
    assert.equal(response.status, 500);
    assert.match(await response.text(), /EMFILE/);
    assert.equal(reads, 1);
    assert.deepEqual(
      server.failures().map(({ code, attempt, outcome }) => ({ code, attempt, outcome })),
      [{ code: "EMFILE", attempt: 1, outcome: "failed" }],
    );
  } finally {
    await server.close();
  }
});

test("o registro de falhas é limitado às mais recentes", async () => {
  const dir = await siteWith("index.html", "<html></html>");
  const server = await startServer(dir, {
    log: () => {},
    readFile: async () => {
      throw fsError("EMFILE");
    },
  });
  try {
    for (let index = 0; index < 60; index += 1) await (await fetch(`${server.url}a${index}.bin`)).arrayBuffer();
    const failures = server.failures();
    assert.equal(failures.length, 50);
    assert.equal(failures.at(-1)?.path, "/a59.bin");
  } finally {
    await server.close();
  }
});

test("leitura real de um arquivo que existe segue servindo 200", async () => {
  const dir = await siteWith("dado.txt", "oi");
  const server = await startServer(dir);
  try {
    const response = await fetch(`${server.url}dado.txt`);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "oi");
    assert.deepEqual(server.failures(), []);
  } finally {
    await server.close();
  }
});

test("cada falha e cada repetição vão para o log do servidor, uma linha por evento", async () => {
  const dir = await siteWith("index.html", "<html></html>");
  const lines: string[] = [];
  let reads = 0;
  const server = await startServer(dir, {
    log: (line) => lines.push(line),
    readFile: async () => {
      reads += 1;
      if (reads === 1) throw fsError("EBUSY");
      return Buffer.from("ok");
    },
  });
  try {
    assert.equal((await fetch(`${server.url}dado.bin`)).status, 200);
    assert.deepEqual(lines, ["[frankframes] servidor: EBUSY ao ler /dado.bin (tentativa 1, vai repetir)"]);
  } finally {
    await server.close();
  }
});
