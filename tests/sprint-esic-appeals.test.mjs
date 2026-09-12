/**
 * O5-06 (Onda 5) — recurso de e-SIC (LAI art. 15): COMPORTAMENTO.
 *
 * fileEsicAppeal só admite recurso de 1ª instância sobre pedido indeferido; 2ª
 * instância exige o de 1ª improvido; um por pedido/instância. decideEsicAppeal
 * decide o recurso pendente e, se PROVIDO, reabre o pedido (status 'recebido').
 * Confere as guardas, a unicidade e a reabertura.
 *
 * Mutação: não reabrir o pedido quando provido derruba o teste.
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
const fn = {};

const dir = mkdtempSync(join(tmpdir(), "esic-appeals-test-"));

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
  `const PERMS = ["protocol.read","protocol.manage"];
   export async function loadTenantAccess() { return { permissions: PERMS }; }
   export function requireTenantPermission(a, perm) {
     if (!a.permissions.includes(perm)) throw new Error("Sem permissao: " + perm);
   }`,
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

let numeroSeq = 0;
async function seedRequest(status) {
  numeroSeq += 1;
  const id = randomUUID();
  await db.query(
    `insert into public.esic_requests
       (id, tenant_id, ano, numero, solicitante, pedido, status, prazo_resposta)
     values ($1,$2,2026,$3,'Cidadao','Pedido de informacao',$4,'2026-03-01')`,
    [id, tenantId, numeroSeq, status],
  );
  return id;
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
  Object.assign(
    fn,
    await bundle("src/lib/esic-appeals.functions.ts", "ea.mjs"),
  );
});

after(async () => {
  await db.close();
  delete globalThis.__db;
  rmSync(dir, { recursive: true, force: true });
});

const file = (request, instancia) =>
  fn.fileEsicAppeal({
    data: {
      tenant_id: tenantId,
      request_id: request,
      instancia,
      fundamento: "Discordo da negativa de acesso",
      data_recurso: "2026-03-05",
    },
    context: ctx(),
  });

const decide = (appeal, decisao) =>
  fn.decideEsicAppeal({
    data: {
      tenant_id: tenantId,
      appeal_id: appeal,
      decisao,
      justificativa: "Analise do recurso",
      data_decisao: "2026-03-10",
    },
    context: ctx(),
  });

test("só pedido indeferido recorre; 1ª→2ª exige improvido; um por instância", async () => {
  const aberto = await seedRequest("recebido");
  await assert.rejects(file(aberto, 1), /indeferido/i);

  const req = await seedRequest("indeferido");
  const a1 = await file(req, 1);
  assert.equal(a1.instancia, 1);
  await assert.rejects(file(req, 1), /já há recurso/i);

  // 2ª instância antes de improvido: recusa.
  await assert.rejects(file(req, 2), /2ª instância/i);
  await decide(a1.id, "improvido");
  const a2 = await file(req, 2);
  assert.equal(a2.instancia, 2);
});

test("recurso provido reabre o pedido para cumprimento", async () => {
  const req = await seedRequest("indeferido");
  const a = await file(req, 1);
  await decide(a.id, "provido");

  const r = (
    await db.query("select status from public.esic_requests where id=$1", [req])
  ).rows[0];
  assert.equal(r.status, "recebido"); // reaberto

  // Recurso já decidido não decide de novo.
  await assert.rejects(decide(a.id, "improvido"), /já decidido/i);
});
