/**
 * O5-10 (Onda 5) — painel de decisão dos recursos do e-SIC (LAI art. 15-16) e
 * estatística obrigatória do e-SIC (LAI art. 30, III): COMPORTAMENTO.
 *
 * getEsicAppealsSummary: por instância, pendentes/providos/improvidos, pendentes
 * VENCIDOS (prazo de 5 dias para decidir já passado) e decisões no prazo/fora.
 * getEsicStatistics: pedidos recebidos/atendidos/indeferidos/em aberto do exercício
 * e recursos por decisão.
 *
 * Mutação: prazo de decisão 5 → 50 dias faz o pendente vencido deixar de ser
 * vencido e a decisão tardia virar "no prazo" — derruba.
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

const dir = mkdtempSync(join(tmpdir(), "esic-stats-test-"));

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
  `const PERMS = ["protocol.read","protocol.manage","transparency.read"];
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
// Pedido do exercício `ano` com a situação dada; prazo 2026-03-20; respondido_em opcional.
async function seedRequest(
  status,
  ano = 2026,
  respondidoEm = null,
  prorrogado = false,
) {
  seq += 1;
  const id = randomUUID();
  await db.query(
    `insert into public.esic_requests
       (id, tenant_id, ano, numero, solicitante, anonimo, pedido, prazo_resposta,
        status, respondido_em, prorrogado)
     values ($1,$2,$3,$4,'Cidadao',false,'Pedido','2026-03-20',$5,$6::date,$7)`,
    [id, tenantId, ano, seq, status, respondidoEm, prorrogado],
  );
  return id;
}
async function seedAppeal(
  requestId,
  instancia,
  status,
  dataRecurso,
  decididoEm = null,
) {
  await db.query(
    `insert into public.esic_appeals
       (id, tenant_id, request_id, instancia, fundamento, data_recurso, status,
        decisao, decidido_em)
     values ($1,$2,$3,$4,'F',$5::date,$6,$7,$8::date)`,
    [
      randomUUID(),
      tenantId,
      requestId,
      instancia,
      dataRecurso,
      status,
      status === "pendente" ? null : "Decisao",
      decididoEm,
    ],
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
  Object.assign(
    fn,
    await bundle("src/lib/esic-appeals.functions.ts", "ap.mjs"),
    await bundle("src/lib/transparency.functions.ts", "tr.mjs"),
  );
});

after(async () => {
  await db.close();
  delete globalThis.__db;
  rmSync(dir, { recursive: true, force: true });
});

test("painel de recursos: pendentes vencidos pelo prazo de 5 dias e tempestividade por instância", async () => {
  const a = await seedRequest("indeferido", 2026, "2026-03-10");
  const b = await seedRequest("indeferido", 2026, "2026-03-25");
  const c = await seedRequest("indeferido", 2026, "2026-03-12");
  // 1ª instância: a) pendente há 10 dias (vencido); b) provido no prazo (3 dias);
  // c) improvido fora do prazo (8 dias).
  await seedAppeal(a, 1, "pendente", "2026-04-01");
  await seedAppeal(b, 1, "provido", "2026-04-01", "2026-04-04");
  await seedAppeal(c, 1, "improvido", "2026-04-01", "2026-04-09");
  // 2ª instância (do c): pendente há 2 dias (dentro do prazo).
  await seedAppeal(c, 2, "pendente", "2026-04-09");

  const r = await fn.getEsicAppealsSummary({
    data: { tenant_id: tenantId, data_referencia: "2026-04-11" },
    context: ctx(),
  });
  assert.equal(r.prazo_decisao_dias, 5);
  assert.deepEqual(r.porInstancia[0], {
    instancia: 1,
    pendentes: 1,
    providos: 1,
    improvidos: 1,
    pendentes_vencidos: 1,
    decididos_no_prazo: 1,
    decididos_fora_prazo: 1,
  });
  assert.deepEqual(r.porInstancia[1], {
    instancia: 2,
    pendentes: 1,
    providos: 0,
    improvidos: 0,
    pendentes_vencidos: 0,
    decididos_no_prazo: 0,
    decididos_fora_prazo: 0,
  });
  assert.equal(r.totais.pendentes, 2);
  assert.equal(r.totais.pendentes_vencidos, 1);
  assert.equal(r.totais.taxa_provimento, 50); // 1 provido / 2 decididos
});

test("estatística LAI art. 30 III: recebidos/atendidos/indeferidos/em aberto do exercício e recursos", async () => {
  // 2026 já tem 3 indeferidos (do teste anterior). Acrescenta: 2 respondidos (um
  // no prazo, um fora), 1 recebido, 1 prorrogado; e 1 de 2025 que não entra.
  await seedRequest("respondido", 2026, "2026-03-15");
  await seedRequest("respondido", 2026, "2026-03-25");
  await seedRequest("recebido", 2026);
  await seedRequest("prorrogado", 2026, null, true);
  await seedRequest("respondido", 2025, "2025-06-01");

  const s = await fn.getEsicStatistics({
    data: { tenant_id: tenantId, exercicio: 2026 },
    context: ctx(),
  });
  assert.deepEqual(s.pedidos, {
    recebidos: 7,
    atendidos: 2,
    indeferidos: 3,
    em_aberto: 2,
    prorrogados: 1,
    // No prazo (≤ 2026-03-20): o respondido de 03-15 e os indeferidos de 03-10 e
    // 03-12 — indeferimento tempestivo também é resposta no prazo.
    respondidos_no_prazo: 3,
    taxa_atendimento: 28.57,
  });
  assert.deepEqual(s.recursos, {
    interpostos: 4,
    providos: 1,
    improvidos: 1,
    pendentes: 2,
  });

  const s2025 = await fn.getEsicStatistics({
    data: { tenant_id: tenantId, exercicio: 2025 },
    context: ctx(),
  });
  assert.equal(s2025.pedidos.recebidos, 1);
  assert.equal(s2025.recursos.interpostos, 0);
});
