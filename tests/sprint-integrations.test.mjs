/**
 * O5-10 (Onda 5) — Integrações (menuia/bealys) e canais de alerta (WhatsApp/e-mail):
 * COMPORTAMENTO.
 *
 * - saveIntegrationSettings guarda a credencial no servidor; a leitura NUNCA a devolve (só
 *   `has_credential`). Ligar (enabled) exige uma base_url.
 * - saveAlertSettings: ligar um canal exige ao menos um destinatário.
 *
 * Mutação: remover a guarda "ativar exige base_url" deixa ligar sem endpoint; remover a
 * guarda "ativar exige destinatário" deixa ligar canal sem para quem enviar. Ambas derrubam.
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

const dir = mkdtempSync(join(tmpdir(), "integrations-test-"));

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
  `const PERMS = ["org.read","org.manage"];
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
    await bundle("src/lib/integrations.functions.ts", "int.mjs"),
  );
});

after(async () => {
  await db.close();
  delete globalThis.__db;
  rmSync(dir, { recursive: true, force: true });
});

test("integração: credencial nunca volta; ativar exige base_url", async () => {
  // Ativar menuia sem base_url: recusa.
  await assert.rejects(
    fn.saveIntegrationSettings({
      data: { tenant_id: tenantId, provider: "menuia", enabled: true },
      context: ctx(),
    }),
    /URL/i,
  );

  // Configura com base_url + credencial, ativado.
  await fn.saveIntegrationSettings({
    data: {
      tenant_id: tenantId,
      provider: "menuia",
      enabled: true,
      base_url: "https://chatbot.menuia.com/api",
      credential: "segredo-supersecreto",
    },
    context: ctx(),
  });

  const r = await fn.getIntegrationSettings({
    data: { tenant_id: tenantId },
    context: ctx(),
  });
  const menuia = r.providers.find((p) => p.provider === "menuia");
  assert.equal(menuia.enabled, true);
  assert.equal(menuia.base_url, "https://chatbot.menuia.com/api");
  assert.equal(menuia.has_credential, true);
  // A credencial NÃO pode estar na resposta.
  assert.equal("credential" in menuia, false);
  assert.equal(JSON.stringify(r).includes("segredo-supersecreto"), false);

  // bealys segue desligado e sem credencial (provedor listado mesmo sem config).
  const bealys = r.providers.find((p) => p.provider === "bealys");
  assert.equal(bealys.enabled, false);
  assert.equal(bealys.has_credential, false);
});

test("alerta: ativar canal exige destinatário", async () => {
  // Ativar e-mail sem destinatário: recusa.
  await assert.rejects(
    fn.saveAlertSettings({
      data: {
        tenant_id: tenantId,
        canal: "email",
        enabled: true,
        destinatarios: [],
        eventos: ["reposicao_estoque"],
      },
      context: ctx(),
    }),
    /destinat/i,
  );

  // Com destinatário: ok.
  await fn.saveAlertSettings({
    data: {
      tenant_id: tenantId,
      canal: "email",
      enabled: true,
      destinatarios: ["gestor@ente.gov.br"],
      eventos: ["reposicao_estoque", "ferias_vencendo"],
    },
    context: ctx(),
  });

  const r = await fn.getAlertSettings({
    data: { tenant_id: tenantId },
    context: ctx(),
  });
  const email = r.canais.find((c) => c.canal === "email");
  assert.equal(email.enabled, true);
  assert.deepEqual(email.destinatarios, ["gestor@ente.gov.br"]);
  assert.deepEqual(email.eventos, ["reposicao_estoque", "ferias_vencendo"]);
  const whats = r.canais.find((c) => c.canal === "whatsapp");
  assert.equal(whats.enabled, false);
});
