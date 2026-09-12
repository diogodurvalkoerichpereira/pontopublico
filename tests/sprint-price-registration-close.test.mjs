/**
 * O3-12b (Onda 3) — Encerramento/cancelamento da ata de registro de preços (SRP,
 * Lei 14.133 art. 82-86): COMPORTAMENTO.
 *
 * closePriceRegistration move uma ata VIGENTE para 'encerrada' (fim natural) ou
 * 'cancelada' (art. 86); ambos são terminais. Uma ata já encerrada/cancelada não admite
 * nova ação, e depois de fechada o consumo (drawFromPriceRegistration) é recusado.
 *
 * Mutação: remover a guarda de estado de origem (status !== 'vigente') faz o encerramento
 * de uma ata já encerrada passar — o teste derruba.
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

const dir = mkdtempSync(join(tmpdir(), "price-reg-close-test-"));

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
    [id, tenantId, `PLC-${procSeq}`, status],
  );
  return id;
}

let ataSeq = 0;
async function createAta() {
  ataSeq += 1;
  const process = await seedProcess("homologada");
  return fn.createPriceRegistration({
    data: {
      tenant_id: tenantId,
      procurement_process_id: process,
      numero: `ATAC-${ataSeq}`,
      ano: 2026,
      fornecedor: "Fornecedor X",
      vigencia_inicio: "2026-02-01",
      vigencia_fim: "2026-12-31",
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

const close = (registrationId, acao) =>
  fn.closePriceRegistration({
    data: { tenant_id: tenantId, registration_id: registrationId, acao },
    context: ctx(),
  });

const draw = (itemId) =>
  fn.drawFromPriceRegistration({
    data: {
      tenant_id: tenantId,
      item_id: itemId,
      quantidade: 1,
      data_referencia: "2026-05-01",
    },
    context: ctx(),
  });

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
    await bundle("src/lib/price-registration.functions.ts", "prc.mjs"),
  );
});

after(async () => {
  await db.close();
  delete globalThis.__db;
  rmSync(dir, { recursive: true, force: true });
});

test("encerrar move vigente→encerrada e fecha o consumo", async () => {
  const ata = await createAta();
  const item = await itemOf(ata.id);

  // Vigente consome normalmente.
  await draw(item);

  const r = await close(ata.id, "encerrar");
  assert.equal(r.status, "encerrada");

  // Encerrada é terminal: não admite nova ação.
  await assert.rejects(close(ata.id, "cancelar"), /não admite/i);
  // E o consumo é recusado (ata não vigente).
  await assert.rejects(draw(item), /vigente/i);
});

test("cancelar move vigente→cancelada; ata inexistente é recusada", async () => {
  const ata = await createAta();
  const r = await close(ata.id, "cancelar");
  assert.equal(r.status, "cancelada");
  // Cancelada não admite encerrar depois.
  await assert.rejects(close(ata.id, "encerrar"), /não admite/i);

  await assert.rejects(close(randomUUID(), "encerrar"), /não encontrada/i);
});
