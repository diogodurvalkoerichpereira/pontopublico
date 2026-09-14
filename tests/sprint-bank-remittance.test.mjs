/**
 * Remessa bancária da folha (O2-32, ligada à tela): COMPORTAMENTO.
 *
 * O módulo existia sem tela e sem teste. Ao ligá-lo em `/rh/ciclos` três regras
 * passam a ter consequência visível e precisam de rede:
 *
 * 1. Só folha FECHADA gera remessa — uma prévia ou uma folha em revisão pode
 *    mudar de valor depois, e o arquivo já teria saído.
 * 2. Vínculo sem conta bancária ativa no banco escolhido RECUSA o arquivo
 *    inteiro. Gerar uma remessa parcial é pior que não gerar: paga uns e deixa
 *    outros de fora sem que ninguém perceba.
 * 3. O `layout_version` gravado é `RASCUNHO-NAO-CNAB240-v1` e a resposta carrega
 *    o aviso de conformidade. Esta é a regra do CLAUDE.md — nenhum artefato leva
 *    nome de padrão oficial sem homologação —, e agora que existe um botão que
 *    baixa o arquivo, é o que impede apresentá-lo como CNAB 240 em licitação.
 *
 * Mutação: aceitar folha não fechada, aceitar remessa parcial (trocar o `!==`
 * por `>`), ou trocar o rótulo por "CNAB240" derruba um caso cada.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { build } from "esbuild";
import { createTestDb } from "./helpers/pglite.mjs";

let db;
let tenantId;
let userId;
const L = {};
const fn = {};

const dir = mkdtempSync(join(tmpdir(), "remittance-test-"));
const hex64 = (seed) => createHash("sha256").update(seed).digest("hex");

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
  `const PERMS = ["bank.remittance.read","bank.remittance.manage"];
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

async function seedLink(reg, cpf) {
  const person = randomUUID();
  await db.query(
    "insert into public.persons(id,full_name,cpf) values($1,$2,$3)",
    [person, `Serv ${reg}`, cpf],
  );
  await db.query(
    `insert into public.employment_links(tenant_id,person_id,source_profile_id,registration_number,status)
     values($1,$2,null,$3,'rascunho')`,
    [tenantId, person, reg],
  );
  L[reg] = (
    await db.query(
      "select id from public.employment_links where registration_number=$1 and tenant_id=$2",
      [reg, tenantId],
    )
  ).rows[0].id;
}

let seqCiclo = 0;
// O ciclo nasce como prévia (é o único estado em que a trigger aceita gravar
// resultados) e só depois recebe o status pedido pelo caso.
async function seedCycle(status, links) {
  const runId = randomUUID();
  await db.query(
    `insert into public.payroll_calculation_runs
       (id, tenant_id, reference_month, run_type, status, engine_version, input_checksum)
     values ($1,$2,'2026-05-01','simulacao','processando','v1',$3)`,
    [runId, tenantId, hex64("run" + runId)],
  );
  const total = links.reduce((s, l) => s + l.net, 0);
  const id = randomUUID();
  await db.query(
    `insert into public.payroll_cycles
       (id, tenant_id, reference_month, cycle_type, sequence, source_run_id,
        status, links_count, total_earnings, total_net)
     values ($1,$2,'2026-05-01','mensal',$5,$3,'previa',$4,$6,$6)`,
    [id, tenantId, runId, links.length, (seqCiclo += 1), total],
  );
  for (const l of links)
    await db.query(
      `insert into public.payroll_cycle_results
         (id, tenant_id, cycle_id, employment_link_id, earnings, net_amount, result_checksum)
       values ($1,$2,$3,$4,$5,$5,$6)`,
      [randomUUID(), tenantId, id, L[l.reg], l.net, hex64(id + l.reg)],
    );
  // A trigger só aceita previa -> em_conferencia -> aprovada -> fechada;
  // o teste percorre os estados em vez de saltar direto.
  const caminho = ["em_conferencia", "aprovada", "fechada"];
  if (status !== "previa")
    for (const etapa of caminho) {
      await db.query("update public.payroll_cycles set status=$2 where id=$1", [
        id,
        etapa,
      ]);
      if (etapa === status) break;
    }
  return id;
}

async function seedBankAccount(reg, bank) {
  await db.query(
    `insert into public.payroll_bank_accounts
       (id, tenant_id, employment_link_id, bank_code, branch, account_number,
        account_type, holder_document, active)
     values ($1,$2,$3,$4,'0001','123456','corrente','52998224725',true)`,
    [randomUUID(), tenantId, L[reg], bank],
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
  await seedLink("M1", "52998224725");
  await seedLink("M2", "11144477735");
  Object.assign(
    fn,
    await bundle("src/lib/bank-remittance.functions.ts", "rem.mjs"),
  );
});

after(async () => {
  await db.close();
  delete globalThis.__db;
  rmSync(dir, { recursive: true, force: true });
});

const gerar = (cycle_id, bank_code) =>
  fn.generateBankRemittance({
    data: { tenant_id: tenantId, cycle_id, bank_code },
    context: ctx(),
  });

test("folha não fechada não gera remessa", async () => {
  // Uma prévia ainda muda de valor; o arquivo já teria saído com o número errado.
  const cid = await seedCycle("previa", [{ reg: "M1", net: 1000 }]);
  await seedBankAccount("M1", "001");
  await assert.rejects(gerar(cid, "001"), /fechada/i);
});

test("vínculo sem conta ativa no banco recusa a remessa inteira", async () => {
  // M2 não tem conta no 001. Gerar só o M1 seria pior que não gerar: paga um e
  // deixa o outro de fora sem que ninguém perceba.
  const cid = await seedCycle("fechada", [
    { reg: "M1", net: 1000 },
    { reg: "M2", net: 2000 },
  ]);
  await assert.rejects(gerar(cid, "001"), /sem conta banc/i);
});

test("remessa completa grava o rótulo de NÃO conformidade", async () => {
  const cid = await seedCycle("fechada", [
    { reg: "M1", net: 1500 },
    { reg: "M2", net: 2500 },
  ]);
  await seedBankAccount("M2", "001");
  const r = await gerar(cid, "001");
  assert.equal(r.total, 4000);
  assert.match(r.hash, /^[0-9a-f]{64}$/);

  const batch = (
    await db.query(
      "select layout_version, records_count, total_amount::text from public.bank_remittance_batches where id=$1",
      [r.id],
    )
  ).rows[0];
  // Regra do CLAUDE.md: nenhum artefato leva nome de padrão oficial sem
  // homologação. Agora que há um botão que baixa este arquivo, é este rótulo
  // que impede apresentá-lo como CNAB 240.
  assert.equal(batch.layout_version, "RASCUNHO-NAO-CNAB240-v1");
  assert.equal(Number(batch.records_count), 2);
  assert.equal(Number(batch.total_amount), 4000);
  assert.equal(r.conformidade.status, "rascunho");
  assert.equal(r.conformidade.padraoOficialPendente, "FEBRABAN CNAB 240");
  assert.ok(r.conformidade.pendencias.length > 0);
});

test("a listagem devolve o lote gerado e as folhas fechadas", async () => {
  const r = await fn.getBankRemittances({
    data: { tenant_id: tenantId },
    context: ctx(),
  });
  assert.ok(r.batches.length >= 1);
  assert.ok(r.cycles.length >= 1);
  assert.ok(
    r.batches.every((b) => b.layout_version === "RASCUNHO-NAO-CNAB240-v1"),
  );
});
