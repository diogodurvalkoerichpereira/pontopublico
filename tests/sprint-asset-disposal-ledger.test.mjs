/**
 * O3-11c (Onda 3) — baixa de bem contabilizada como VPD/VPA (PCASP): COMPORTAMENTO.
 *
 * disposeAsset escritura, pelo roteiro do ente (accounting_event_accounts), três
 * eventos: depreciação acumulada sai do imobilizado; o valor líquido desincorpora
 * como VPD; a alienação entra como VPA. Sem mapeamento não contabiliza (O2-06).
 * O resultado patrimonial dos lançamentos (VPA − VPD) fecha com o resultado da baixa.
 *
 * Mutação: pular o evento de desincorporação deixa o razão com VPA 8000 e VPD 0
 * (resultado 8000 ≠ 1000) — derruba.
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

const dir = mkdtempSync(join(tmpdir(), "asset-ledger-test-"));

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
async function seedAsset(aquisicao, depreciacao) {
  tombSeq += 1;
  const id = randomUUID();
  await db.query(
    `insert into public.patrimony_assets
       (id, tenant_id, tombamento, descricao, valor_aquisicao, valor_residual,
        vida_util_meses, data_aquisicao, meses_depreciados, depreciacao_acumulada)
     values ($1,$2,$3,'Bem',$4,0,60,'2024-01-01',12,$5)`,
    [id, tenantId, `TL-${tombSeq}`, aquisicao, depreciacao],
  );
  return id;
}
const dispose = (assetId, valor) =>
  fn.disposeAsset({
    data: {
      tenant_id: tenantId,
      asset_id: assetId,
      data_baixa: "2026-05-10",
      motivo: "Alienacao em leilao",
      valor_alienacao: valor,
    },
    context: ctx(),
  });
// Razão dos lançamentos gerados pela baixa do bem (source_ref = bem).
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

test("sem roteiro não contabiliza; com roteiro, VPA − VPD dos lançamentos = resultado da baixa", async () => {
  // Sem mapeamento: a baixa acontece, mas nada vai ao razão.
  const semRoteiro = await seedAsset(1000, 0);
  const r0 = await dispose(semRoteiro, 500);
  assert.equal(r0.resultado, -500);
  assert.equal(r0.lancamentos, 0);
  assert.equal((await ledgerOf(semRoteiro)).length, 0);

  // Roteiro do ente (PCASP): imobilizado 1.2.3.1, dep. acumulada 1.2.3.8,
  // disponibilidade 1.1.1.1, VPD desincorporação 3.6.1, VPA alienação 4.6.1.
  await mapEvent("baixa_bem_depreciacao", "1.2.3.8", "1.2.3.1");
  await mapEvent("baixa_bem_desincorporacao", "3.6.1", "1.2.3.1");
  await mapEvent("baixa_bem_alienacao", "1.1.1.1", "4.6.1");

  // Aquisição 10000, depreciação 3000 (líquido 7000), alienado por 8000 → ganho 1000.
  const bem = await seedAsset(10000, 3000);
  const r = await dispose(bem, 8000);
  assert.equal(r.resultado, 1000);
  assert.equal(r.lancamentos, 3);

  const razao = await ledgerOf(bem);
  assert.equal(razao.length, 6); // 3 lançamentos × 2 linhas
  const linha = (source, lado) =>
    razao.find((l) => l.source === `evento:${source}` && l.lado === lado);
  assert.deepEqual(
    [
      linha("baixa_bem_depreciacao", "D").conta,
      linha("baixa_bem_depreciacao", "D").valor,
    ],
    ["1.2.3.8", "3000.00"],
  );
  assert.equal(linha("baixa_bem_desincorporacao", "D").conta, "3.6.1");
  assert.equal(linha("baixa_bem_desincorporacao", "D").valor, "7000.00");
  assert.equal(linha("baixa_bem_alienacao", "C").conta, "4.6.1");
  assert.equal(linha("baixa_bem_alienacao", "C").valor, "8000.00");
  // O imobilizado sai por inteiro: 3000 + 7000 = 10000 a crédito de 1.2.3.1.
  const saidaImobilizado = razao
    .filter((l) => l.conta === "1.2.3.1" && l.lado === "C")
    .reduce((s, l) => s + Number(l.valor), 0);
  assert.equal(saidaImobilizado, 10000);

  // Resultado patrimonial dos lançamentos da baixa: VPA (classe 4) − VPD (classe 3).
  const vpa = razao
    .filter((l) => l.conta.startsWith("4") && l.lado === "C")
    .reduce((s, l) => s + Number(l.valor), 0);
  const vpd = razao
    .filter((l) => l.conta.startsWith("3") && l.lado === "D")
    .reduce((s, l) => s + Number(l.valor), 0);
  assert.equal(vpa - vpd, r.resultado);

  // Perda: líquido 4000 alienado por 1000 → VPD 4000, VPA 1000, resultado −3000.
  const perda = await seedAsset(4000, 0);
  const rp = await dispose(perda, 1000);
  assert.equal(rp.resultado, -3000);
  assert.equal(rp.lancamentos, 2); // depreciação zero não escritura
});
