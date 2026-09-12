/**
 * O1-10 (Onda 1) — Dependentes válidos na competência (base do IRRF/salário-família):
 * COMPORTAMENTO.
 *
 * getValidDependents conta os dependentes do titular vigentes na data de referência
 * (valid_from <= ref e (valid_to nulo ou >= ref)), separando efeito de IRRF e de
 * previdência. Dependente fora da vigência (ainda não válido ou já encerrado) não conta.
 *
 * Mutação: ignorar o fim de vigência (remover a condição de valid_to) conta um dependente
 * já encerrado e derruba o teste.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { build } from "esbuild";
import { createTestDb } from "./helpers/pglite.mjs";

let db;
let tenantId;
let userId;
let holderId;
const fn = {};

const dir = mkdtempSync(join(tmpdir(), "valid-dependents-test-"));

const dbStub = join(dir, "db.mjs");
writeFileSync(
  dbStub,
  `export async function query(t, p) { const r = await globalThis.__db.query(t, p ?? []); return r.rows; }
   export async function queryOne(t, p) { const r = await globalThis.__db.query(t, p ?? []); return r.rows[0] ?? null; }
   export async function withTransaction(fn) { return fn({ query: async (t, p) => globalThis.__db.query(t, p ?? []) }); }`,
);
const startStub = join(dir, "start.mjs");
writeFileSync(
  startStub,
  `export function createServerFn() {
     let validate = (x) => x;
     const b = { middleware() { return b; }, validator(fn) { validate = fn; return b; },
       inputValidator(fn) { validate = fn; return b; },
       handler(fn) { return async ({ data, context }) => fn({ data: validate(data), context }); } };
     return b;
   }`,
);
const dataStub = join(dir, "data.mjs");
writeFileSync(dataStub, `export const requireAuth = {};`);
const taStub = join(dir, "ta.mjs");
writeFileSync(
  taStub,
  `export async function loadTenantAccess() {
     return { permissions: ["family.read", "family.manage"] };
   }
   export function requireTenantPermission(a, perm) {
     if (!a.permissions.includes(perm)) throw new Error("Sem permissao: " + perm);
   }
   export async function loadTenantUnitScope() { return { global: true, unitIds: [] }; }
   export function requireUnitInScope() {}`,
);
const auditStub = join(dir, "audit.mjs");
writeFileSync(
  auditStub,
  `export async function recordAudit() {} export async function recordAuditQ() {}`,
);

function stubPlugin() {
  return {
    name: "stub",
    setup(b) {
      const map = [
        [/@tanstack\/react-start$/, startStub],
        [/(^|\/)db\.server$/, dbStub],
        [/(^|\/)data\.functions$/, dataStub],
        [/(^|\/)tenant-access\.server$/, taStub],
        [/(^|\/)audit\.server$/, auditStub],
      ];
      for (const [filter, path] of map)
        b.onResolve({ filter }, () => ({ path, external: true }));
    },
  };
}

async function bundle(entry, name) {
  const out = join(dir, name);
  await build({
    entryPoints: [entry],
    bundle: true,
    format: "esm",
    platform: "node",
    outfile: out,
    logLevel: "silent",
    external: ["node:*"],
    plugins: [stubPlugin()],
  });
  return import(out);
}

const ctx = () => ({ userId });

async function seedDependent({ from, to, irrf, prev }) {
  const dep = randomUUID();
  await db.query("insert into public.persons(id,full_name) values($1,'Dep')", [
    dep,
  ]);
  await db.query(
    `insert into public.person_dependents
       (id, tenant_id, holder_person_id, dependent_person_id, relationship,
        income_tax_effect, social_security_effect, valid_from, valid_to)
     values ($1,$2,$3,$4,'filho',$5,$6,$7,$8)`,
    [randomUUID(), tenantId, holderId, dep, irrf, prev, from, to],
  );
}

before(async () => {
  db = await createTestDb();
  globalThis.__db = db;
  tenantId = (
    await db.query(
      "select id from public.tenants order by created_at, id limit 1",
    )
  ).rows[0].id;
  userId = randomUUID();
  await db.query(
    "insert into public.app_users (id, email, password_hash) values ($1,$2,'x')",
    [userId, `a-${userId}@t.local`],
  );
  await db.query("insert into public.profiles (id) values ($1)", [userId]);
  holderId = randomUUID();
  await db.query(
    "insert into public.persons(id,full_name) values($1,'Titular')",
    [holderId],
  );
  // Vínculo do titular (escopo). status 'rascunho' evita o trigger de vínculo ativo.
  await db.query(
    `insert into public.employment_links(tenant_id,person_id,source_profile_id,registration_number,status)
     values($1,$2,null,'M1','rascunho')`,
    [tenantId, holderId],
  );
  Object.assign(fn, await bundle("src/lib/family.functions.ts", "fam.mjs"));
});

after(async () => {
  await db.close();
  delete globalThis.__db;
  rmSync(dir, { recursive: true, force: true });
});

test("conta só dependentes vigentes na competência, por efeito", async () => {
  // Referência 2026-06-01.
  // Vigente, com IRRF e previdência.
  await seedDependent({
    from: "2020-01-01",
    to: null,
    irrf: true,
    prev: true,
  });
  // Vigente, só previdência (ex.: maior de idade p/ IRRF).
  await seedDependent({
    from: "2020-01-01",
    to: null,
    irrf: false,
    prev: true,
  });
  // Já encerrado antes da referência: não conta.
  await seedDependent({
    from: "2019-01-01",
    to: "2025-12-31",
    irrf: true,
    prev: true,
  });
  // Ainda não vigente (começa depois da referência): não conta.
  await seedDependent({
    from: "2026-09-01",
    to: null,
    irrf: true,
    prev: true,
  });

  const r = await fn.getValidDependents({
    data: {
      tenant_id: tenantId,
      holder_person_id: holderId,
      data_referencia: "2026-06-01",
    },
    context: ctx(),
  });

  assert.equal(r.total, 2); // os dois vigentes
  assert.equal(r.irrf, 1); // só um vigente tem efeito de IRRF
  assert.equal(r.previdencia, 2); // ambos vigentes têm efeito previdenciário
});
