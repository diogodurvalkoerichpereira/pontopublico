/**
 * O3-11d (Onda 3) — reavaliação de bens patrimoniais (NBC TSP): COMPORTAMENTO.
 *
 * revaluateAsset ajusta o valor líquido contábil (aquisição − depreciação
 * acumulada) ao novo valor justo, SEM alterar a depreciação já acumulada: o
 * valor de aquisição vira `novo_valor_liquido + depreciação acumulada`. Só bem
 * ativo reavalia; o novo líquido nunca fica abaixo do valor residual. O
 * resultado (ganho/perda) contabiliza pelo roteiro do ente (O2-06), sem
 * mapeamento não escritura, sem delta não gera lançamento.
 *
 * Mutação: trocar o sinal do resultado (líquido anterior − novo, em vez de
 * novo − anterior) inverte ganho/perda e o evento contabilizado — derruba.
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

const dir = mkdtempSync(join(tmpdir(), "asset-revaluation-test-"));

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
  `const PERMS = ["assets.read","assets.manage"];
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

let tombSeq = 0;
async function seedAsset(aquisicao, depreciacao, valorResidual = 0) {
  tombSeq += 1;
  const id = randomUUID();
  await db.query(
    `insert into public.patrimony_assets
       (id, tenant_id, tombamento, descricao, valor_aquisicao, valor_residual,
        vida_util_meses, data_aquisicao, meses_depreciados, depreciacao_acumulada)
     values ($1,$2,$3,'Bem',$4,$5,60,'2024-01-01',12,$6)`,
    [id, tenantId, `TR-${tombSeq}`, aquisicao, valorResidual, depreciacao],
  );
  return id;
}
const revaluate = (
  assetId,
  novoValorLiquido,
  justificativa = "Laudo de avaliação",
) =>
  fn.revaluateAsset({
    data: {
      tenant_id: tenantId,
      asset_id: assetId,
      data_reavaliacao: "2026-06-15",
      novo_valor_liquido: novoValorLiquido,
      justificativa,
    },
    context: ctx(),
  });
const assetRow = async (assetId) =>
  (
    await db.query(
      `select valor_aquisicao::text, depreciacao_acumulada::text, status
       from public.patrimony_assets where id=$1`,
      [assetId],
    )
  ).rows[0];
// Razão dos lançamentos gerados pela reavaliação (source_ref = bem).
const ledgerOf = async (assetId) =>
  (
    await db.query(
      `select e.source, l.conta, l.lado, l.valor::text
       from public.accounting_entries e
       join public.accounting_entry_lines l on l.entry_id = e.id
       where e.tenant_id=$1 and e.source_ref=$2
       order by e.source, l.lado`,
      [tenantId, assetId],
    )
  ).rows;
const mapEvent = (code, debit, credit) =>
  db.query(
    `insert into public.accounting_event_accounts
       (tenant_id, event_code, debit_account, credit_account)
     values ($1,$2,$3,$4)`,
    [tenantId, code, debit, credit],
  );

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
  Object.assign(fn, await bundle("src/lib/assets.functions.ts", "as.mjs"));
});

after(async () => {
  await db.close();
  delete globalThis.__db;
  rmSync(dir, { recursive: true, force: true });
});

test("bem baixado não reavalia", async () => {
  const bem = await seedAsset(1000, 0);
  await db.query(
    `update public.patrimony_assets set status='baixado' where id=$1`,
    [bem],
  );
  await assert.rejects(() => revaluate(bem, 1200), /Bem baixado não reavalia/);
});

test("novo líquido não pode ficar abaixo do valor residual", async () => {
  const bem = await seedAsset(10000, 3000, 500); // líquido 7000, residual 500
  await assert.rejects(
    () => revaluate(bem, 400),
    /não pode ser menor que o valor residual/,
  );
});

test("ganho: ajusta aquisição sem tocar a depreciação, sem roteiro não contabiliza", async () => {
  // Aquisição 10000, depreciação 3000 → líquido 7000. Reavalia para 9000 (ganho 2000).
  const bem = await seedAsset(10000, 3000);
  const r = await revaluate(bem, 9000);
  assert.equal(r.valor_liquido_anterior, 7000);
  assert.equal(r.valor_liquido_novo, 9000);
  assert.equal(r.resultado, 2000);
  assert.equal(r.lancamentos, 0); // sem roteiro configurado

  const row = await assetRow(bem);
  assert.equal(row.depreciacao_acumulada, "3000.00"); // não muda
  assert.equal(row.valor_aquisicao, "12000.00"); // 9000 + 3000
  assert.equal((await ledgerOf(bem)).length, 0);
});

test("ganho contabilizado: D imobilizado / C VPA ajuste de avaliação", async () => {
  await mapEvent("reavaliacao_positiva", "1.2.3.1", "4.9.1");
  const bem = await seedAsset(5000, 1000); // líquido 4000
  const r = await revaluate(bem, 6000); // ganho 2000
  assert.equal(r.resultado, 2000);
  assert.equal(r.lancamentos, 1);

  const razao = await ledgerOf(bem);
  assert.equal(razao.length, 2);
  const d = razao.find((l) => l.lado === "D");
  const c = razao.find((l) => l.lado === "C");
  assert.equal(d.conta, "1.2.3.1");
  assert.equal(d.valor, "2000.00");
  assert.equal(c.conta, "4.9.1");
  assert.equal(c.valor, "2000.00");
});

test("perda contabilizada: D VPD ajuste de avaliação / C imobilizado", async () => {
  await mapEvent("reavaliacao_negativa", "3.9.1", "1.2.3.1");
  const bem = await seedAsset(8000, 0); // líquido 8000
  const r = await revaluate(bem, 5000); // perda 3000
  assert.equal(r.resultado, -3000);
  assert.equal(r.lancamentos, 1);

  const row = await assetRow(bem);
  assert.equal(row.valor_aquisicao, "5000.00"); // 5000 + 0

  const razao = await ledgerOf(bem);
  assert.equal(razao.length, 2);
  const d = razao.find((l) => l.lado === "D");
  const c = razao.find((l) => l.lado === "C");
  assert.equal(d.conta, "3.9.1");
  assert.equal(d.valor, "3000.00");
  assert.equal(c.conta, "1.2.3.1");
  assert.equal(c.valor, "3000.00");
});

test("sem delta não gera lançamento mesmo com roteiro configurado", async () => {
  const bem = await seedAsset(4000, 1000); // líquido 3000
  const r = await revaluate(bem, 3000); // mesma avaliação
  assert.equal(r.resultado, 0);
  assert.equal(r.lancamentos, 0);
  assert.equal((await ledgerOf(bem)).length, 0);
});

test("getAssetRevaluations consolida o período (ganhos, perdas, resultado líquido)", async () => {
  const bemGanho = await seedAsset(2000, 0);
  const bemPerda = await seedAsset(6000, 0);
  await fn.revaluateAsset({
    data: {
      tenant_id: tenantId,
      asset_id: bemGanho,
      data_reavaliacao: "2026-07-01",
      novo_valor_liquido: 2500, // ganho 500
      justificativa: "Laudo A",
    },
    context: ctx(),
  });
  await fn.revaluateAsset({
    data: {
      tenant_id: tenantId,
      asset_id: bemPerda,
      data_reavaliacao: "2026-07-02",
      novo_valor_liquido: 4000, // perda 2000
      justificativa: "Laudo B",
    },
    context: ctx(),
  });
  const relatorio = await fn.getAssetRevaluations({
    data: { tenant_id: tenantId, from: "2026-07-01", to: "2026-07-31" },
    context: ctx(),
  });
  assert.equal(relatorio.revaluations.length, 2);
  assert.equal(relatorio.totais.ganhos, 500);
  assert.equal(relatorio.totais.perdas, -2000);
  assert.equal(relatorio.totais.resultado_liquido, -1500);
});
