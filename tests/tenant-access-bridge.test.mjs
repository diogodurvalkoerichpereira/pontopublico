/**
 * Comportamento da ponte legada de permissões (O0-10, Incremento 1).
 *
 * Executa o código real: `tenant-access.server.ts` é empacotado com esbuild, com
 * `db.server` e `pgrest.server` trocados por stubs que devolvem linhas
 * controladas (associação, papéis RBAC, permissões RBAC e o acesso legado). O
 * flag `LEGACY_ROLE_BRIDGE` é inlinado em dois bundles (on/off) via `define`, para
 * afirmar o comportamento nos dois estados sem banco externo.
 *
 * Cobre: (A) a escalação cross-tenant do admin legado é fechada com a ponte off;
 * (B) com a ponte on o comportamento legado (catálogo inteiro) é preservado; e
 * (C) uma vez reconciliado (o RBAC já carrega o conjunto do RH), desligar a ponte
 * não muda nada nem dispara telemetria — a prova de que a reconciliação torna o
 * off seguro.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";

const dir = mkdtempSync(join(tmpdir(), "tabridge-test-"));

// Stub de db.server: roteia as consultas de loadTenantAccess por conteúdo do SQL.
const dbStub = join(dir, "db-stub.mjs");
writeFileSync(
  dbStub,
  `let scenario = { membership: { id: "m" }, roleRows: [], permissionRows: [] };
   export function setScenario(s) { scenario = s; }
   export async function query(text) {
     if (/security_permissions/.test(text)) return scenario.permissionRows;
     if (/security_user_roles/.test(text)) return scenario.roleRows;
     return [];
   }
   export async function queryOne(text) {
     if (/tenant_memberships/.test(text)) return scenario.membership;
     return null;
   }
  `,
);

// Stub de pgrest.server: o acesso legado (user_roles/rh_permissions).
const pgrestStub = join(dir, "pgrest-stub.mjs");
writeFileSync(
  pgrestStub,
  `let legacy = { roles: ["funcionario"], perms: [] };
   export function setLegacy(l) { legacy = l; }
   export async function loadAccess(userId) { return { userId, ...legacy }; }
  `,
);

async function bundleWithFlag(value) {
  const out = join(dir, `ta.${value}.mjs`);
  await build({
    entryPoints: ["src/lib/tenant-access.server.ts"],
    bundle: true,
    format: "esm",
    platform: "node",
    outfile: out,
    logLevel: "silent",
    external: ["node:*"],
    define: { "process.env.LEGACY_ROLE_BRIDGE": JSON.stringify(value) },
    plugins: [
      {
        name: "stub-deps",
        setup(b) {
          b.onResolve({ filter: /(^|\/)db\.server$/ }, () => ({
            path: dbStub,
            external: true,
          }));
          b.onResolve({ filter: /(^|\/)pgrest\.server$/ }, () => ({
            path: pgrestStub,
            external: true,
          }));
        },
      },
    ],
  });
  return import(out);
}

const off = await bundleWithFlag("off");
const on = await bundleWithFlag("on");
const dbmod = await import(dbStub);
const pgmod = await import(pgrestStub);

const ALL_CODES = off.TENANT_PERMISSION_CODES;
const EXCLUDED = ["tenant.manage", "security.manage", "audit.read"];
const RH_OPERADOR_SET = ALL_CODES.filter((c) => !EXCLUDED.includes(c)); // 47

/** Captura as linhas de console.warn durante `fn`. */
async function captureWarn(fn) {
  const lines = [];
  const orig = console.warn;
  console.warn = (...args) => lines.push(args.join(" "));
  try {
    await fn();
  } finally {
    console.warn = orig;
  }
  return lines;
}

test("A — bridge off: admin legado não escala entre entes", async () => {
  // No tenant B, o usuário é só 'employee' no RBAC, mas tem admin legado global.
  dbmod.setScenario({
    membership: { id: "m" },
    roleRows: [{ codigo: "employee" }],
    permissionRows: [{ codigo: "tenant.read" }, { codigo: "org.read" }],
  });
  pgmod.setLegacy({ roles: ["admin"], perms: [] });

  let access;
  const warns = await captureWarn(async () => {
    access = await off.loadTenantAccess("u", "B");
  });
  const perms = new Set(access.permissions);
  assert.ok(perms.has("tenant.read") && perms.has("org.read"), "mantém o RBAC");
  assert.ok(!perms.has("tenant.manage"), "não recebe tenant.manage");
  assert.ok(!perms.has("security.manage"), "não recebe security.manage");
  assert.ok(!perms.has("payroll.cycles.close"), "não recebe fechar folha");
  assert.equal(perms.size, 2, "só as duas do papel employee");

  const dep = warns
    .map((l) => JSON.parse(l))
    .find((o) => o.tag === "LEGACY_BRIDGE_DEPENDENCY");
  assert.ok(dep, "telemetria de dependência registrada");
  assert.equal(dep.bridgeEnabled, false);
  assert.equal(dep.legacyAdmin, true);
});

test("B — bridge on: comportamento legado preservado (catálogo inteiro)", async () => {
  dbmod.setScenario({
    membership: { id: "m" },
    roleRows: [{ codigo: "employee" }],
    permissionRows: [{ codigo: "tenant.read" }, { codigo: "org.read" }],
  });
  pgmod.setLegacy({ roles: ["admin"], perms: [] });

  const access = await on.loadTenantAccess("u", "B");
  const perms = new Set(access.permissions);
  for (const code of ALL_CODES) {
    assert.ok(perms.has(code), `com a ponte on, admin legado tem ${code}`);
  }
});

test("C — reconciliado: RBAC já carrega o RH, off é no-op e sem telemetria", async () => {
  // Simula rh_operador atribuído: o RBAC já devolve as 47 permissões da união.
  dbmod.setScenario({
    membership: { id: "m" },
    roleRows: [{ codigo: "rh_operador" }],
    permissionRows: RH_OPERADOR_SET.map((codigo) => ({ codigo })),
  });
  pgmod.setLegacy({
    roles: ["rh"],
    perms: [
      "manage_employees",
      "approve_documents",
      "configure_schedules",
      "close_payroll",
    ],
  });

  let access;
  const warns = await captureWarn(async () => {
    access = await off.loadTenantAccess("u", "A");
  });
  const perms = new Set(access.permissions);
  assert.ok(perms.has("payroll.cycles.close"), "mantém fechar folha via RBAC");
  assert.ok(perms.has("people.manage"), "mantém people.manage via RBAC");
  assert.ok(perms.has("esocial.manage"), "mantém esocial.manage via RBAC");
  assert.ok(perms.has("migration.manage"), "mantém migration.manage via RBAC");
  assert.ok(!perms.has("tenant.manage"), "não tem tenant.manage");
  assert.ok(!perms.has("security.manage"), "não tem security.manage");
  assert.ok(!perms.has("audit.read"), "não tem audit.read");
  assert.equal(perms.size, RH_OPERADOR_SET.length, "exatamente as 47 do RBAC");

  const dep = warns
    .map((l) => JSON.parse(l))
    .find((o) => o.tag === "LEGACY_BRIDGE_DEPENDENCY");
  assert.equal(
    dep,
    undefined,
    "sem dependência: o RBAC já concede tudo o que a ponte concederia",
  );
});

process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
