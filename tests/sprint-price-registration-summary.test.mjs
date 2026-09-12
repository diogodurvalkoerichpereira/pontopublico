/**
 * O3-12c (Onda 3) — Resumo do registro de preços (SRP, Lei 14.133): COMPORTAMENTO.
 *
 * getPriceRegistrationSummary consolida a contagem de atas por situação e, das atas
 * VIGENTES, o valor registrado (Σ qtd_registrada × preço), o consumido (Σ qtd_consumida ×
 * preço) e o saldo a consumir. Ata encerrada/cancelada não entra no financeiro vigente.
 *
 * Mutação: usar quantidade_registrada no lugar de quantidade_consumida no valor consumido,
 * ou não multiplicar pelo preço, derruba o teste.
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

const dir = mkdtempSync(join(tmpdir(), "price-reg-summary-test-"));

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
async function seedProcess() {
  procSeq += 1;
  const id = randomUUID();
  await db.query(
    `insert into public.procurement_processes
       (id, tenant_id, numero, ano, modalidade, objeto, valor_estimado, status, abertura)
     values ($1,$2,$3,2026,'pregao','Registro de precos',100000,'homologada','2026-01-10')`,
    [id, tenantId, `PLS-${procSeq}`],
  );
  return id;
}

// Cria uma ata com 1 item (qtd/preço dados), consome `consumir`, e opcionalmente fecha.
let ataSeq = 0;
async function createAta({ qtd, preco, consumir = 0, fechar = null }) {
  ataSeq += 1;
  const process = await seedProcess();
  const ata = await fn.createPriceRegistration({
    data: {
      tenant_id: tenantId,
      procurement_process_id: process,
      numero: `ATAS-${ataSeq}`,
      ano: 2026,
      fornecedor: "Fornecedor X",
      vigencia_inicio: "2026-02-01",
      vigencia_fim: "2026-12-31",
      itens: [
        {
          descricao: "Papel A4",
          unidade: "resma",
          quantidade_registrada: qtd,
          preco_unitario: preco,
        },
      ],
    },
    context: ctx(),
  });
  if (consumir > 0) {
    const item = (
      await db.query(
        "select id from public.price_registration_items where registration_id=$1",
        [ata.id],
      )
    ).rows[0].id;
    await fn.drawFromPriceRegistration({
      data: {
        tenant_id: tenantId,
        item_id: item,
        quantidade: consumir,
        data_referencia: "2026-05-01",
      },
      context: ctx(),
    });
  }
  if (fechar) {
    await fn.closePriceRegistration({
      data: { tenant_id: tenantId, registration_id: ata.id, acao: fechar },
      context: ctx(),
    });
  }
  return ata.id;
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
    await bundle("src/lib/price-registration.functions.ts", "prs.mjs"),
  );
});

after(async () => {
  await db.close();
  delete globalThis.__db;
  rmSync(dir, { recursive: true, force: true });
});

test("consolida por status e o financeiro só das vigentes", async () => {
  // Vigente: 100 × 20 = 2000 registrado; consome 30 → 600 consumido.
  await createAta({ qtd: 100, preco: 20, consumir: 30 });
  // Encerrada: fora do financeiro vigente (não soma).
  await createAta({ qtd: 50, preco: 10, fechar: "encerrar" });
  // Cancelada: idem.
  await createAta({ qtd: 5, preco: 100, fechar: "cancelar" });

  const r = await fn.getPriceRegistrationSummary({
    data: { tenant_id: tenantId },
    context: ctx(),
  });

  assert.deepEqual(r.porStatus, { vigente: 1, encerrada: 1, cancelada: 1 });
  assert.equal(r.valorRegistrado, 2000);
  assert.equal(r.valorConsumido, 600);
  assert.equal(r.saldoAConsumir, 1400);
});
