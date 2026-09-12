/**
 * O5-07 (Onda 5) — avaliação de satisfação da ouvidoria (Lei 13.460): COMPORTAMENTO.
 *
 * rateManifestation registra a nota (1-5) só de manifestação respondida, uma por
 * manifestação; getOmbudsmanSatisfaction consolida média, total e distribuição.
 * Confere o cálculo da média, a distribuição, a guarda de estado e a unicidade.
 *
 * Mutação: não dividir pela quantidade (média = soma) derruba o teste.
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

const dir = mkdtempSync(join(tmpdir(), "ombudsman-sat-test-"));

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
async function seedManifestation(status) {
  numeroSeq += 1;
  const id = randomUUID();
  await db.query(
    `insert into public.ombudsman_manifestations
       (id, tenant_id, ano, numero, tipo, canal, descricao, status, prazo_resposta)
     values ($1,$2,2026,$3,'reclamacao','web','Descricao',$4,'2026-03-01')`,
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
    await bundle("src/lib/ombudsman-satisfaction.functions.ts", "os.mjs"),
  );
});

after(async () => {
  await db.close();
  delete globalThis.__db;
  rmSync(dir, { recursive: true, force: true });
});

const rate = (manifestation, nota) =>
  fn.rateManifestation({
    data: {
      tenant_id: tenantId,
      manifestation_id: manifestation,
      nota,
      avaliado_em: "2026-03-10",
    },
    context: ctx(),
  });

test("consolida média e distribuição das notas das manifestações respondidas", async () => {
  const m1 = await seedManifestation("respondida");
  const m2 = await seedManifestation("respondida");
  const m3 = await seedManifestation("respondida");
  await rate(m1, 5);
  await rate(m2, 3);
  await rate(m3, 4);

  const r = await fn.getOmbudsmanSatisfaction({
    data: { tenant_id: tenantId },
    context: ctx(),
  });
  assert.equal(r.total, 3);
  assert.equal(r.media, 4); // (5 + 3 + 4) / 3
  assert.equal(r.distribuicao[5], 1);
  assert.equal(r.distribuicao[4], 1);
  assert.equal(r.distribuicao[3], 1);
  assert.equal(r.distribuicao[1], 0);
});

test("só manifestação respondida avalia; uma avaliação por manifestação", async () => {
  const aberta = await seedManifestation("em_analise");
  await assert.rejects(rate(aberta, 5), /respondida/i);

  const m = await seedManifestation("respondida");
  await rate(m, 2);
  await assert.rejects(rate(m, 4), /já foi avaliada/i);
});
