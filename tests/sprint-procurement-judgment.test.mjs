/**
 * O3-08b (Onda 3 — Contratações) — propostas e julgamento por menor preço (Lei 14.133
 * art. 33-34): COMPORTAMENTO.
 *
 * recordProcurementProposal registra propostas numa licitação aberta (uma por
 * fornecedor); getProcurementJudgment ordena por menor valor, classifica só as válidas
 * (1, 2, 3…) e a de menor valor entre as classificadas vence. Uma proposta desclassificada
 * — mesmo sendo a mais barata — não recebe classificação nem vence.
 *
 * Mutação: classificar/deixar vencer a proposta desclassificada (ignorar o flag) derruba
 * o teste; recusar proposta em licitação não aberta também é conferido.
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

const dir = mkdtempSync(join(tmpdir(), "procurement-judgment-test-"));

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
  `const PERMS = ["contracts.read","contracts.manage"];
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

let seq = 0;
async function seedProcess(status) {
  seq += 1;
  const id = randomUUID();
  await db.query(
    `insert into public.procurement_processes
       (id, tenant_id, numero, ano, modalidade, objeto, valor_estimado, status, abertura)
     values ($1,$2,$3,2026,'pregao','Objeto',100000,$4,'2026-01-01')`,
    [id, tenantId, `PL-${seq}`, status],
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
    await bundle("src/lib/procurement.functions.ts", "proc.mjs"),
  );
});

after(async () => {
  await db.close();
  delete globalThis.__db;
  rmSync(dir, { recursive: true, force: true });
});

const propose = (processId, extra) =>
  fn.recordProcurementProposal({
    data: { tenant_id: tenantId, process_id: processId, ...extra },
    context: ctx(),
  });

test("julgamento por menor preço classifica só as válidas e a mais barata vence", async () => {
  const proc = await seedProcess("aberta");

  await propose(proc, {
    fornecedor: "Alfa",
    fornecedor_documento: "111",
    valor_proposto: 500,
  });
  await propose(proc, {
    fornecedor: "Beta",
    fornecedor_documento: "222",
    valor_proposto: 300,
  });
  // Mais barata (100), mas DESCLASSIFICADA — não pode vencer.
  await propose(proc, {
    fornecedor: "Gama",
    fornecedor_documento: "333",
    valor_proposto: 100,
    desclassificada: true,
    motivo_desclassificacao: "Documento vencido",
  });

  const r = await fn.getProcurementJudgment({
    data: { tenant_id: tenantId, process_id: proc },
    context: ctx(),
  });

  // Ordenado por valor asc: Gama(100), Beta(300), Alfa(500).
  assert.deepEqual(
    r.proposals.map((p) => p.fornecedor),
    ["Gama", "Beta", "Alfa"],
  );
  // A desclassificada não recebe classificação.
  const gama = r.proposals.find((p) => p.fornecedor === "Gama");
  assert.equal(gama.classificacao, null);
  // As válidas recebem 1 (Beta, menor válida) e 2 (Alfa).
  assert.equal(
    r.proposals.find((p) => p.fornecedor === "Beta").classificacao,
    1,
  );
  assert.equal(
    r.proposals.find((p) => p.fornecedor === "Alfa").classificacao,
    2,
  );
  // Vencedor é a menor VÁLIDA (Beta), não a mais barata (Gama).
  assert.equal(r.vencedor.fornecedor_documento, "222");
});

test("licitação não aberta não recebe proposta; fornecedor não duplica", async () => {
  const homologada = await seedProcess("homologada");
  await assert.rejects(
    propose(homologada, {
      fornecedor: "Alfa",
      fornecedor_documento: "111",
      valor_proposto: 200,
    }),
    /aberta/i,
  );

  const proc = await seedProcess("aberta");
  await propose(proc, {
    fornecedor: "Alfa",
    fornecedor_documento: "111",
    valor_proposto: 200,
  });
  await assert.rejects(
    propose(proc, {
      fornecedor: "Alfa Ltda",
      fornecedor_documento: "111",
      valor_proposto: 150,
    }),
    /já tem proposta/i,
  );
});
