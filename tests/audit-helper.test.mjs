/**
 * Auditoria compartilhada (O0-11).
 *
 * Duas redes, como manda o CLAUDE.md: um teste de COMPORTAMENTO que executa o
 * `recordAudit` real (empacotado com esbuild, com `db.server` e o `getRequest`
 * trocados por stubs) e afere o SQL/params efetivamente produzidos; e uma rede de
 * CONFORMIDADE (lint) que falha se algum `*.functions.ts` gravar auditoria com
 * `insert into public.audit_events` cru, fora de `audit.server.ts`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  writeFileSync,
  rmSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = mkdtempSync(join(tmpdir(), "audit-test-"));

// Stub de db.server: captura o que recordAuditQ manda ao pool.
const dbStub = join(dir, "db-stub.mjs");
writeFileSync(
  dbStub,
  `export const executed = [];
   export async function query(text, params) { executed.push({ text, params }); return []; }
   export function reset() { executed.length = 0; }
  `,
);

// Stub de getRequest: cabeçalhos controlados para aferir request_id/ip.
const reqStub = join(dir, "req-stub.mjs");
writeFileSync(
  reqStub,
  `export function getRequest() {
     const h = new Map([["x-request-id","req-123"],["x-forwarded-for","1.2.3.4, 9.9.9.9"]]);
     return { headers: { get: (k) => h.get(k) ?? null } };
   }
  `,
);

const bundle = join(dir, "audit.bundle.mjs");
await build({
  entryPoints: ["src/lib/audit.server.ts"],
  bundle: true,
  format: "esm",
  platform: "node",
  outfile: bundle,
  logLevel: "silent",
  external: ["node:*"],
  plugins: [
    {
      name: "stub",
      setup(b) {
        b.onResolve({ filter: /(^|\/)db\.server$/ }, () => ({
          path: dbStub,
          external: true,
        }));
        b.onResolve({ filter: /@tanstack\/react-start\/server$/ }, () => ({
          path: reqStub,
          external: true,
        }));
      },
    },
  ],
});

const audit = await import(bundle);
const db = await import(dbStub);

test("recordAudit grava as 9 colunas, serializa jsonb e injeta request_id/ip", async () => {
  const captured = [];
  const client = {
    query: (text, params) => captured.push({ text, params }),
  };
  await audit.recordAudit(client, {
    tenantId: "t1",
    actorId: "u1",
    action: "remessa.gerar",
    resource: "bank_remittance_batches",
    recordId: "r1",
    after: { total: 10 },
  });
  assert.equal(captured.length, 1);
  const { text, params } = captured[0];
  assert.match(text, /insert into public\.audit_events/);
  assert.match(text, /\$6::jsonb.*\$7::jsonb/s, "before/after como jsonb");
  assert.match(text, /\$9::inet/, "ip como inet");
  assert.deepEqual(params.slice(0, 5), [
    "t1",
    "u1",
    "remessa.gerar",
    "bank_remittance_batches",
    "r1",
  ]);
  assert.equal(params[5], null, "before ausente vira null");
  assert.equal(params[6], JSON.stringify({ total: 10 }), "after serializado");
  assert.equal(params[7], "req-123", "request_id do cabeçalho");
  assert.equal(params[8], "1.2.3.4", "ip: primeiro do x-forwarded-for");
});

test("recordAudit serializa before e after quando presentes", async () => {
  const captured = [];
  const client = { query: (text, params) => captured.push({ text, params }) };
  await audit.recordAudit(client, {
    tenantId: null,
    actorId: null,
    action: "unidade.atualizar",
    resource: "unidades",
    before: { nome: "a" },
    after: { nome: "b" },
  });
  const { params } = captured[0];
  assert.equal(params[5], JSON.stringify({ nome: "a" }));
  assert.equal(params[6], JSON.stringify({ nome: "b" }));
});

test("recordAuditQ escreve pelo pool (db.server.query)", async () => {
  db.reset();
  await audit.recordAuditQ({
    tenantId: "t1",
    actorId: "u1",
    action: "esocial.enfileirar",
    resource: "esocial_events",
    recordId: "e1",
    after: { event_type: "S-1200" },
  });
  assert.equal(db.executed.length, 1, "usou o pool");
  assert.match(db.executed[0].text, /insert into public\.audit_events/);
  assert.ok(db.executed[0].params.includes("esocial.enfileirar"));
});

// --- Conformidade (lint): auditoria só pela via central ----------------------
test("nenhum *.functions.ts grava audit_events com insert cru", () => {
  const libDir = join(root, "src", "lib");
  const offenders = readdirSync(libDir)
    .filter((f) => f.endsWith(".functions.ts"))
    .filter((f) =>
      /insert\s+into\s+public\.audit_events/i.test(
        readFileSync(join(libDir, f), "utf8"),
      ),
    );
  assert.deepEqual(
    offenders,
    [],
    `Estes módulos gravam auditoria com insert cru; use recordAudit/recordAuditQ de audit.server.ts:\n  ${offenders.join(
      "\n  ",
    )}`,
  );
});

test("os módulos de saída de dados importam o helper de auditoria", () => {
  const libDir = join(root, "src", "lib");
  const outputs = [
    "bank-remittance.functions.ts",
    "official-export.functions.ts",
    "esocial.functions.ts",
    "historical-migration.functions.ts",
  ];
  for (const f of outputs) {
    const src = readFileSync(join(libDir, f), "utf8");
    assert.match(
      src,
      /from "\.\/audit\.server"/,
      `${f} precisa registrar trilha via audit.server`,
    );
  }
});

process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
