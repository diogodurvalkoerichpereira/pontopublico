/**
 * O1-03g — resumo mensal da apuracao de ponto por servidor: teste de COMPORTAMENTO.
 *
 * getApuracaoResumoMensal consolida, para o mes, a apuracao (previsto x trabalhado,
 * extras, faltas, saldo) de TODOS os vinculos ATIVOS do ente, ordenando por saldo
 * crescente (maior falta primeiro). Vinculo desligado nao entra; vinculo ativo sem
 * marcacao entra zerado (a apuracao so olha dias com marcacao — O1-03e).
 *
 * Mutacao: remover o filtro status='ativo' faz o desligado aparecer; inverter/remover
 * a ordenacao muda quem vem primeiro; trocar a formula do saldo quebra os totais.
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
const link = {};
const fn = {};

const dir = mkdtempSync(join(tmpdir(), "apuracao-resumo-test-"));

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
  `export async function loadTenantAccess() { return { permissions: ["people.read","people.manage"] }; }
   export function requireTenantPermission(a, perm) {
     if (!a.permissions.includes(perm)) throw new Error("Sem permissao: " + perm);
   }`,
);
const auditStub = join(dir, "audit.mjs");
writeFileSync(auditStub, `export async function recordAudit() {}`);

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

let unitId;

async function makeLink(mat, status) {
  const personId = randomUUID();
  const id = randomUUID();
  await db.query("insert into public.persons (id, full_name) values ($1,$2)", [
    personId,
    `Servidor ${mat}`,
  ]);
  // Vinculo ativo exige lotacao, tipo, regime, cargo, jornada e admissao (trigger de coerencia).
  await db.query(
    `insert into public.employment_links
       (id, tenant_id, person_id, registration_number, status, weekly_hours,
        unit_id, employment_type, work_regime, job_title, admission_date)
     values ($1,$2,$3,$4,$5,40,$6,'efetivo','estatutario','Analista','2020-01-01')`,
    [id, tenantId, personId, mat, status, unitId],
  );
  return id;
}

async function punch(id, when) {
  await fn.recordTimeClockPunch({
    data: { tenant_id: tenantId, employment_link_id: id, punch_time: when },
    context: ctx(),
  });
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
  unitId = randomUUID();
  await db.query(
    "insert into public.unidades (id, tenant_id, codigo, nome, tipo, ativo) values ($1,$2,'U1','Unidade 1','setor',true)",
    [unitId, tenantId],
  );
  Object.assign(fn, await bundle("src/lib/time-clock.functions.ts", "tc.mjs"));

  // 40h/semana -> 480 min/dia util. Fuso do ente: America/Sao_Paulo (UTC-3).
  link.A = await makeLink("MAT-A", "ativo");
  link.B = await makeLink("MAT-B", "ativo");
  link.C = await makeLink("MAT-C", "desligado");
  link.D = await makeLink("MAT-D", "ativo");

  // A: 2025-06-10 (ter) cheio 480; 2025-06-11 (qua) so 400 -> falta 80. saldo -80.
  await punch(link.A, "2025-06-10T11:00:00.000Z"); // 08:00 SP
  await punch(link.A, "2025-06-10T15:00:00.000Z"); // 12:00 SP
  await punch(link.A, "2025-06-10T16:00:00.000Z"); // 13:00 SP
  await punch(link.A, "2025-06-10T20:00:00.000Z"); // 17:00 SP
  await punch(link.A, "2025-06-11T11:00:00.000Z"); // 08:00 SP
  await punch(link.A, "2025-06-11T15:00:00.000Z"); // 12:00 SP
  await punch(link.A, "2025-06-11T16:00:00.000Z"); // 13:00 SP
  await punch(link.A, "2025-06-11T18:40:00.000Z"); // 15:40 SP -> 400 no dia
  // B: 2025-06-12 (qui) 540 -> extra 60. saldo +60.
  await punch(link.B, "2025-06-12T11:00:00.000Z"); // 08:00 SP
  await punch(link.B, "2025-06-12T15:00:00.000Z"); // 12:00 SP
  await punch(link.B, "2025-06-12T16:00:00.000Z"); // 13:00 SP
  await punch(link.B, "2025-06-12T21:00:00.000Z"); // 18:00 SP -> 540 no dia
  // C (desligado): marca cheio um dia — nao pode aparecer no resumo.
  await punch(link.C, "2025-06-10T11:00:00.000Z");
  await punch(link.C, "2025-06-10T15:00:00.000Z");
  // D (ativo, sem marcacao): entra zerado.
});

after(async () => {
  await db.close();
  delete globalThis.__db;
  rmSync(dir, { recursive: true, force: true });
});

test("resumo mensal: so ativos, ordenado por saldo (maior falta primeiro), com totais", async () => {
  const r = await fn.getApuracaoResumoMensal({
    data: { tenant_id: tenantId, reference_month: "2025-06" },
    context: ctx(),
  });

  // Desligado (C) nao entra; A, B e D (ativos) sim.
  assert.equal(r.servidores.length, 3);
  assert.equal(
    r.servidores.some((s) => s.employment_link_id === link.C),
    false,
    "vinculo desligado nao pode aparecer",
  );

  const A = r.servidores.find((s) => s.employment_link_id === link.A);
  const B = r.servidores.find((s) => s.employment_link_id === link.B);
  const D = r.servidores.find((s) => s.employment_link_id === link.D);

  // A: expected 960, worked 880, extra 0, falta 80, saldo -80.
  assert.equal(A.expectedMinutes, 960);
  assert.equal(A.workedMinutes, 880);
  assert.equal(A.extraMinutes, 0);
  assert.equal(A.faltaMinutes, 80);
  assert.equal(A.saldoMinutes, -80);
  // B: expected 480, worked 540, extra 60, falta 0, saldo +60.
  assert.equal(B.extraMinutes, 60);
  assert.equal(B.faltaMinutes, 0);
  assert.equal(B.saldoMinutes, 60);
  // D (ativo sem marcacao): tudo zero, mas listado.
  assert.equal(D.expectedMinutes, 0);
  assert.equal(D.workedMinutes, 0);
  assert.equal(D.saldoMinutes, 0);

  // Ordenacao: menor saldo primeiro (A -80), maior por ultimo (B +60).
  assert.equal(r.servidores[0].employment_link_id, link.A);
  assert.equal(
    r.servidores[r.servidores.length - 1].employment_link_id,
    link.B,
  );

  // Totais somam os 3 ativos.
  assert.equal(r.totals.expectedMinutes, 1440); // 960+480+0
  assert.equal(r.totals.workedMinutes, 1420); // 880+540+0
  assert.equal(r.totals.extraMinutes, 60);
  assert.equal(r.totals.faltaMinutes, 80);
  assert.equal(r.totals.saldoMinutes, -20); // 60-80
});
