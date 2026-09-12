/**
 * O5-08 (Onda 5) — tempestividade das respostas (Lei 13.460/LAI): COMPORTAMENTO.
 *
 * getResponseTimeliness conta, na ouvidoria e no e-SIC, as respostas dentro do prazo
 * (data da resposta ≤ prazo) e o percentual. Confere a contagem no/fora do prazo e o
 * percentual, distinguindo respondido (entra) de em aberto (não entra).
 *
 * Mutação: inverter a comparação de prazo na ouvidoria (≤ → ≥) derruba o teste.
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

const dir = mkdtempSync(join(tmpdir(), "timeliness-test-"));

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

function stubPlugin() {
  return {
    name: "stub",
    setup(b) {
      const map = [
        [/@tanstack\/react-start$/, startStub],
        [/(^|\/)db\.server$/, dbStub],
        [/(^|\/)data\.functions$/, dataStub],
        [/(^|\/)tenant-access\.server$/, taStub],
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

let ombSeq = 0;
async function seedManifestation(prazo, respondidaEm) {
  ombSeq += 1;
  await db.query(
    `insert into public.ombudsman_manifestations
       (id, tenant_id, ano, numero, tipo, canal, descricao, status, prazo_resposta, respondida_em)
     values ($1,$2,2026,$3,'reclamacao','web','D',$4,$5::date,$6)`,
    [
      randomUUID(),
      tenantId,
      ombSeq,
      respondidaEm ? "respondida" : "recebida",
      prazo,
      respondidaEm,
    ],
  );
}

let esicSeq = 0;
async function seedEsic(prazo, respondidoEm) {
  esicSeq += 1;
  await db.query(
    `insert into public.esic_requests
       (id, tenant_id, ano, numero, solicitante, pedido, status, prazo_resposta, respondido_em)
     values ($1,$2,2026,$3,'C','P',$4,$5::date,$6)`,
    [
      randomUUID(),
      tenantId,
      esicSeq,
      respondidoEm ? "respondido" : "recebido",
      prazo,
      respondidoEm,
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
    await bundle("src/lib/response-timeliness.functions.ts", "rt.mjs"),
  );
});

after(async () => {
  await db.close();
  delete globalThis.__db;
  rmSync(dir, { recursive: true, force: true });
});

test("conta respostas no prazo e o percentual, na ouvidoria e no e-SIC", async () => {
  // Ouvidoria: 2 no prazo (antes do prazo), 1 fora, 1 em aberto (não conta).
  await seedManifestation("2026-03-31", "2026-03-20"); // no prazo
  await seedManifestation("2026-03-31", "2026-03-25"); // no prazo
  await seedManifestation("2026-03-31", "2026-04-10"); // fora
  await seedManifestation("2026-03-31", null); // em aberto

  // e-SIC: 1 no prazo, 1 fora.
  await seedEsic("2026-02-20", "2026-02-10"); // no prazo
  await seedEsic("2026-02-20", "2026-03-01"); // fora

  const r = await fn.getResponseTimeliness({
    data: { tenant_id: tenantId },
    context: ctx(),
  });

  assert.equal(r.ouvidoria.respondidas, 3);
  assert.equal(r.ouvidoria.no_prazo, 2);
  assert.equal(r.ouvidoria.fora_prazo, 1);
  assert.equal(r.ouvidoria.percentual, 66.67); // 2/3

  assert.equal(r.esic.respondidas, 2);
  assert.equal(r.esic.no_prazo, 1);
  assert.equal(r.esic.percentual, 50);
});
