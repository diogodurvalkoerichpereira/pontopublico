/**
 * O3-12 (Onda 3) — Ata de Registro de Preços (SRP, Lei 14.133): COMPORTAMENTO.
 *
 * createPriceRegistration forma a ata só de licitação homologada, com vigência ≤ 1 ano;
 * drawFromPriceRegistration consome do saldo registrado (nunca acima), com a ata vigente
 * e na vigência. Confere a formação, a consumação do saldo, o teto e as guardas.
 *
 * Mutação: inverter o teste de saldo no consumo (> → <) derruba o teste.
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

const dir = mkdtempSync(join(tmpdir(), "price-reg-test-"));

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

let procSeq = 0;
async function seedProcess(status) {
  procSeq += 1;
  const id = randomUUID();
  await db.query(
    `insert into public.procurement_processes
       (id, tenant_id, numero, ano, modalidade, objeto, valor_estimado, status, abertura)
     values ($1,$2,$3,2026,'pregao','Registro de precos',100000,$4,'2026-01-10')`,
    [id, tenantId, `PL-${procSeq}`, status],
  );
  return id;
}

let ataSeq = 0;
async function createAta(processId, fim = "2026-12-31") {
  ataSeq += 1;
  return fn.createPriceRegistration({
    data: {
      tenant_id: tenantId,
      procurement_process_id: processId,
      numero: `ATA-${ataSeq}`,
      ano: 2026,
      fornecedor: "Fornecedor X",
      vigencia_inicio: "2026-02-01",
      vigencia_fim: fim,
      itens: [
        {
          descricao: "Papel A4",
          unidade: "resma",
          quantidade_registrada: 100,
          preco_unitario: 20,
        },
      ],
    },
    context: ctx(),
  });
}

async function itemOf(registrationId) {
  return (
    await db.query(
      "select id from public.price_registration_items where registration_id=$1",
      [registrationId],
    )
  ).rows[0].id;
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
    await bundle("src/lib/price-registration.functions.ts", "pr.mjs"),
  );
});

after(async () => {
  await db.close();
  delete globalThis.__db;
  rmSync(dir, { recursive: true, force: true });
});

const draw = (itemId, quantidade) =>
  fn.drawFromPriceRegistration({
    data: {
      tenant_id: tenantId,
      item_id: itemId,
      quantidade,
      data_referencia: "2026-05-01",
    },
    context: ctx(),
  });

test("ata só de homologada, vigência ≤ 1 ano; consumo respeita o saldo", async () => {
  // Licitação não homologada: não forma ata.
  const aberta = await seedProcess("aberta");
  await assert.rejects(createAta(aberta), /homologada/i);

  // Vigência > 1 ano: recusa.
  const homolog = await seedProcess("homologada");
  await assert.rejects(createAta(homolog, "2027-06-01"), /1 ano/i);

  // Ata válida (qtd 100).
  const ata = await createAta(homolog);
  const item = await itemOf(ata.id);

  const r1 = await draw(item, 30);
  assert.equal(r1.quantidade_consumida, 30);
  assert.equal(r1.saldo, 70);

  // Consumo além do saldo (70): recusa.
  await assert.rejects(draw(item, 80), /excede o saldo/i);

  // Consumo até o saldo: zera.
  const r2 = await draw(item, 70);
  assert.equal(r2.saldo, 0);
});

test("ata cancelada não consome", async () => {
  const homolog = await seedProcess("homologada");
  const ata = await createAta(homolog);
  await db.query(
    "update public.price_registrations set status='cancelada' where id=$1",
    [ata.id],
  );
  const item = await itemOf(ata.id);
  await assert.rejects(draw(item, 1), /vigente/i);
});
