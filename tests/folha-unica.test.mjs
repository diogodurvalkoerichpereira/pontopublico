/**
 * Folha única (O0-13): a folha legada (payroll_periods / /rh/folha) foi congelada.
 *
 * Duas redes: (1) COMPORTAMENTO — o compilador do shim (pgrest.server.ts) é
 * empacotado com esbuild e um `db.server` instrumentado; `runQuery` sobre
 * `payroll_periods` é recusado antes de tocar o banco (a tabela saiu do
 * TABLE_REGISTRY). Repor o registro faz o teste falhar. (2) CONFORMIDADE (lint) —
 * a rota `/rh/folha` não está mais no menu nem existe como arquivo.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  writeFileSync,
  rmSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = mkdtempSync(join(tmpdir(), "folha-test-"));

const stubPath = join(dir, "db-stub.mjs");
writeFileSync(
  stubPath,
  `export const executed = [];
   export async function query(text, params) { executed.push({ text, params }); return []; }
   export async function queryOne(text, params) { executed.push({ text, params }); return null; }
   export async function withTransaction(fn) { return fn({ query }); }
   export function resetExecuted() { executed.length = 0; }
  `,
);

const bundlePath = join(dir, "pgrest.bundle.mjs");
await build({
  entryPoints: ["src/lib/pgrest.server.ts"],
  bundle: true,
  format: "esm",
  platform: "node",
  outfile: bundlePath,
  logLevel: "silent",
  external: ["node:*"],
  plugins: [
    {
      name: "stub-db-server",
      setup(b) {
        b.onResolve({ filter: /(^|\/)db\.server$/ }, () => ({
          path: stubPath,
          external: true,
        }));
      },
    },
  ],
});

const mod = await import(bundlePath);
const stub = await import(stubPath);
const runQuery = mod.runQuery;

const rhCtx = {
  userId: "11111111-1111-1111-1111-111111111111",
  roles: ["rh"],
  perms: ["manage_employees", "close_payroll"],
};
const TENANT = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

test("comportamento: payroll_periods está fora do shim (congelada)", async () => {
  stub.resetExecuted();
  const res = await runQuery(
    { table: "payroll_periods", action: "select", filters: [] },
    rhCtx,
    TENANT,
  );
  assert.ok(res.error, "a folha legada não pode ser consultada pelo shim");
  assert.equal(stub.executed.length, 0, "não pode tocar o banco");
});

test("comportamento: payroll_config está fora do shim (congelada no O1-01b)", async () => {
  // A fonte fiscal viva virou fiscal_tables (versionada, com checksum); o singleton
  // payroll_config foi congelado in-place (ADR 0017) — sai do TABLE_REGISTRY, o shim
  // não a alcança. Repor o registro faz este teste falhar.
  stub.resetExecuted();
  const res = await runQuery(
    { table: "payroll_config", action: "select", filters: [] },
    rhCtx,
    TENANT,
  );
  assert.ok(
    res.error,
    "o singleton fiscal legado não pode ser consultado pelo shim",
  );
  assert.equal(stub.executed.length, 0, "não pode tocar o banco");
});

test("conformidade: /rh/folha saiu do menu e do código", () => {
  const appShell = readFileSync(
    join(root, "src", "components", "AppShell.tsx"),
    "utf8",
  );
  assert.doesNotMatch(
    appShell,
    /["']\/rh\/folha["']/,
    "sem item de menu /rh/folha",
  );
  assert.equal(
    existsSync(join(root, "src", "routes", "rh.folha.tsx")),
    false,
    "a rota da folha legada não existe mais",
  );
});

process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
