// FrankFrames — proprietário. Ver LICENSE na raiz.
// EDT-65: scripts/third-party.ts --check reprova dependência de produção sem aviso ou com licença fora da lista.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { checkLicenses, hasNotice, licenseAllowed } from "../../../scripts/third-party.ts";
import type { DependencyEntry } from "../../../scripts/third-party.ts";

const SCRIPT = fileURLToPath(new URL("../../../scripts/third-party.ts", import.meta.url));
const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

const NOTICES = [
  "### parse5 — MIT",
  "",
  "| Pacote | Licença |",
  "|---|---|",
  "| ws | MIT |",
  "| `@puppeteer/browsers` | Apache-2.0 |",
].join("\n");

test("--check passa no repositório (toda dependência de produção tem aviso e licença permissiva)", () => {
  const result = spawnSync(process.execPath, [SCRIPT, "--check"], { cwd: ROOT, encoding: "utf8", timeout: 120_000 });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /^ok · \d+ dependências de produção/);
});

test("checkLicenses aceita dependências permissivas com aviso", () => {
  const entries: DependencyEntry[] = [
    { name: "parse5", version: "8.1.1", license: "MIT" },
    { name: "ws", version: "8.23.0", license: "MIT" },
    { name: "@puppeteer/browsers", version: "3.2.7", license: "Apache-2.0" },
  ];
  assert.deepEqual(checkLicenses(entries, NOTICES), []);
});

test("checkLicenses reprova licença GPL-3.0 injetada, mesmo com aviso", () => {
  const entries: DependencyEntry[] = [
    { name: "parse5", version: "8.1.1", license: "MIT" },
    { name: "ws", version: "8.23.0", license: "GPL-3.0" },
  ];
  const violations = checkLicenses(entries, NOTICES);
  assert.equal(violations.length, 1);
  assert.equal(violations[0]?.name, "ws");
  assert.equal(violations[0]?.kind, "licença");
  assert.match(violations[0]?.detail ?? "", /GPL-3\.0/);
});

test("checkLicenses reprova dependência sem aviso e licença ausente", () => {
  const entries: DependencyEntry[] = [
    { name: "falsa-lib", version: "1.0.0", license: "MIT" },
    { name: "parse5", version: "8.1.1", license: null },
  ];
  const violations = checkLicenses(entries, NOTICES);
  assert.deepEqual(
    violations.map((item) => `${item.name}:${item.kind}`),
    ["falsa-lib:aviso", "parse5:licença"],
  );
});

test("licenseAllowed entende OR e AND de expressões SPDX", () => {
  assert.equal(licenseAllowed("MIT"), true);
  assert.equal(licenseAllowed("(MIT OR GPL-3.0)"), true);
  assert.equal(licenseAllowed("(MIT AND GPL-3.0)"), false);
  assert.equal(licenseAllowed("GPL-3.0-or-later"), false);
  assert.equal(licenseAllowed("SEE LICENSE IN LICENSE"), false);
  assert.equal(licenseAllowed(null), false);
});

test("hasNotice não confunde prefixo de nome nem texto solto com aviso", () => {
  assert.equal(hasNotice("ws", NOTICES), true);
  assert.equal(hasNotice("w", NOTICES), false);
  assert.equal(hasNotice("parse", NOTICES), false);
  assert.equal(hasNotice("@puppeteer/browsers", NOTICES), true);
  assert.equal(hasNotice("MIT", NOTICES), false);
});
