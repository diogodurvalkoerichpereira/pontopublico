/**
 * O5-01b (Onda 5 — Protocolo) — histórico de tramitação do processo: COMPORTAMENTO.
 *
 * getProtocolMovements devolve o cabeçalho do processo e o trilho de movimentações em
 * ordem cronológica (mais antiga → mais recente), com o nome das unidades, e só do
 * processo pedido. Seeda dois processos com despachos datados fora de ordem e confere a
 * ordenação, os nomes das unidades e o isolamento por processo.
 *
 * Mutação: remover o filtro por process_id (vazar movimentos de outro processo) ou a
 * ordenação por data derruba o teste.
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

const dir = mkdtempSync(join(tmpdir(), "protocol-mov-test-"));

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

let uProto = 0;
async function seedProcess(numero) {
  uProto += 1;
  const id = randomUUID();
  await db.query(
    `insert into public.protocol_processes
       (id, tenant_id, ano, numero, assunto, interessado, status, aberto_em)
     values ($1,$2,2026,$3,'Assunto','Fulano','em_tramitacao','2026-01-01')`,
    [id, tenantId, numero],
  );
  return id;
}
async function seedUnit(nome) {
  const id = randomUUID();
  await db.query(
    "insert into public.unidades (id, tenant_id, codigo, nome) values ($1,$2,$3,$4)",
    [id, tenantId, nome.slice(0, 8), nome],
  );
  return id;
}
async function seedMovement(processId, origem, destino, despacho, ts) {
  await db.query(
    `insert into public.protocol_movements
       (id, tenant_id, process_id, unidade_origem_id, unidade_destino_id,
        despacho, data_movimento)
     values ($1,$2,$3,$4,$5,$6,$7)`,
    [randomUUID(), tenantId, processId, origem, destino, despacho, ts],
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
  Object.assign(fn, await bundle("src/lib/protocol.functions.ts", "proto.mjs"));
});

after(async () => {
  await db.close();
  delete globalThis.__db;
  rmSync(dir, { recursive: true, force: true });
});

test("trilho cronológico, nomes de unidade e isolamento por processo", async () => {
  const protocolo = await seedProcess(1);
  const outro = await seedProcess(2);
  const uProtocolo = await seedUnit("Protocolo");
  const uJuridico = await seedUnit("Jurídico");

  // Inseridos FORA de ordem: o despacho mais recente entra primeiro.
  await seedMovement(
    protocolo,
    uJuridico,
    uProtocolo,
    "Devolvido ao protocolo",
    "2026-02-10T10:00:00Z",
  );
  await seedMovement(
    protocolo,
    uProtocolo,
    uJuridico,
    "Encaminhado ao jurídico",
    "2026-02-01T09:00:00Z",
  );
  // Movimento de OUTRO processo — não pode aparecer.
  await seedMovement(
    outro,
    uProtocolo,
    uJuridico,
    "Despacho do outro processo",
    "2026-02-05T09:00:00Z",
  );

  const r = await fn.getProtocolMovements({
    data: { tenant_id: tenantId, process_id: protocolo },
    context: ctx(),
  });

  assert.equal(r.process.numero, "1");
  assert.equal(r.movements.length, 2);
  // Ordem cronológica: o de 01/02 vem antes do de 10/02.
  assert.deepEqual(
    r.movements.map((m) => m.despacho),
    ["Encaminhado ao jurídico", "Devolvido ao protocolo"],
  );
  // Nomes das unidades resolvidos.
  assert.equal(r.movements[0].unidade_origem, "Protocolo");
  assert.equal(r.movements[0].unidade_destino, "Jurídico");
  // Isolamento: nada do outro processo.
  assert.ok(!r.movements.some((m) => m.despacho.includes("outro processo")));
});
