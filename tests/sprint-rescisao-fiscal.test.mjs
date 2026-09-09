/**
 * O1-05 — rescisao correta com INSS/IRRF: teste de COMPORTAMENTO (ponta a ponta).
 *
 * Sobe o esquema real em PGlite (com o seed fiscal nacional) e executa o handler
 * `calculateTermination`: valora as verbas, retem INSS/IRRF pelo motor fiscal
 * versionado e grava o liquido e as colunas inss_amount/irrf_amount. Confere:
 *  - o liquido desconta INSS + IRRF (antes do O1-05 nao descontava);
 *  - as colunas do termo carregam cada tributo (auditavel pelo TCE);
 *  - verbas indenizatorias (aviso/ferias/FGTS) nao alteram a retencao.
 *
 * Mutacao: nao subtrair inss/irrf do liquido, ou tributar as verbas isentas, derruba.
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
let linkId;
let userId;
const fn = {};

const dir = mkdtempSync(join(tmpdir(), "rescisao-db-test-"));

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
  `const PERMS = ["termination.read","termination.manage"];
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
  const personId = randomUUID();
  linkId = randomUUID();
  await db.query(
    "insert into public.persons (id, full_name) values ($1,'Servidor')",
    [personId],
  );
  // base 6000: saldo 15/30 -> 3000; 13o 6/12 -> 3000; ferias 6/12*4/3 -> 4000.
  await db.query(
    "insert into public.employment_links (id, tenant_id, person_id, registration_number, status, base_salary) values ($1,$2,$3,'MAT-R','rascunho',6000)",
    [linkId, tenantId, personId],
  );
  Object.assign(
    fn,
    await bundle("src/lib/employment-special.functions.ts", "es.mjs"),
  );
});

after(async () => {
  await db.close();
  delete globalThis.__db;
  rmSync(dir, { recursive: true, force: true });
});

const ctx = () => ({ userId });

async function calc(over = {}) {
  return fn.calculateTermination({
    data: {
      tenant_id: tenantId,
      employment_link_id: linkId,
      termination_date: "2025-06-30",
      reason: "sem_justa_causa",
      notice_type: "indenizado",
      worked_days: 15,
      thirteenth_months: 6,
      vacation_months: 6,
      fgts_balance: 0,
      fgts_penalty_rate: 0,
      other_earnings: 0,
      deductions: 0,
      ...over,
    },
    context: ctx(),
  });
}

test("o liquido desconta INSS + IRRF e as colunas do termo os carregam", async () => {
  // proventos = 3000 + 6000(aviso) + 3000 + 4000 = 16000
  // INSS = 253.41 (saldo) + 253.41 (13o) = 506.82
  // IRRF = 23.83 (saldo) + 23.83 (13o) = 47.66
  // liquido = 16000 - 506.82 - 47.66 = 15445.52
  const r = await calc();
  assert.equal(r.inss, 506.82);
  assert.equal(r.irrf, 47.66);
  assert.equal(r.net, 15445.52);

  const row = (
    await db.query(
      "select total_earnings,inss_amount,irrf_amount,net_amount from public.termination_calculations where id=$1",
      [r.id],
    )
  ).rows[0];
  assert.equal(Number(row.total_earnings), 16000);
  assert.equal(Number(row.inss_amount), 506.82);
  assert.equal(Number(row.irrf_amount), 47.66);
  assert.equal(Number(row.net_amount), 15445.52);
});

test("aviso previo indenizado e ferias indenizadas nao aumentam a retencao", async () => {
  // Mesma competencia, outro vinculo: dobra ferias/aviso (indenizatorios). A
  // retencao tem de ser a mesma; so muda o total de proventos (isento).
  const personId = randomUUID();
  const otherLink = randomUUID();
  await db.query(
    "insert into public.persons (id, full_name) values ($1,'Servidor 2')",
    [personId],
  );
  await db.query(
    "insert into public.employment_links (id, tenant_id, person_id, registration_number, status, base_salary) values ($1,$2,$3,'MAT-R2','rascunho',6000)",
    [otherLink, tenantId, personId],
  );
  const r = await fn.calculateTermination({
    data: {
      tenant_id: tenantId,
      employment_link_id: otherLink,
      termination_date: "2025-07-31",
      reason: "sem_justa_causa",
      notice_type: "indenizado",
      worked_days: 15,
      thirteenth_months: 6,
      vacation_months: 12, // dobro das ferias — isentas
      fgts_balance: 100000,
      fgts_penalty_rate: 0.4, // multa FGTS — isenta
      other_earnings: 0,
      deductions: 0,
    },
    context: ctx(),
  });
  assert.equal(r.inss, 506.82, "INSS nao pode mudar com verba isenta");
  assert.equal(r.irrf, 47.66, "IRRF nao pode mudar com verba isenta");
});

test("descontos manuais (data.deductions) ainda reduzem o liquido", async () => {
  const personId = randomUUID();
  const otherLink = randomUUID();
  await db.query(
    "insert into public.persons (id, full_name) values ($1,'Servidor 3')",
    [personId],
  );
  await db.query(
    "insert into public.employment_links (id, tenant_id, person_id, registration_number, status, base_salary) values ($1,$2,$3,'MAT-R3','rascunho',6000)",
    [otherLink, tenantId, personId],
  );
  const r = await fn.calculateTermination({
    data: {
      tenant_id: tenantId,
      employment_link_id: otherLink,
      termination_date: "2025-08-31",
      reason: "sem_justa_causa",
      notice_type: "indenizado",
      worked_days: 15,
      thirteenth_months: 6,
      vacation_months: 6,
      fgts_balance: 0,
      fgts_penalty_rate: 0,
      other_earnings: 0,
      deductions: 200, // pensao/adiantamento
    },
    context: ctx(),
  });
  // 16000 - 506.82 - 47.66 - 200 = 15245.52
  assert.equal(r.net, 15245.52);
});
