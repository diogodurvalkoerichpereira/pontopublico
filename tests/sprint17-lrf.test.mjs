/**
 * Sprint 17 — painel LRF/RCL: teste de COMPORTAMENTO
 * (substitui o grep validate-sprint17.mjs).
 *
 * Três redes. (1) COMPORTAMENTO puro: empacota e executa `classifyLrf` (extraída
 * do handler) com os deps de servidor stubados, e afere a escada de faixas
 * exceeded/prudential/warning/regular. (2) COMPORTAMENTO no banco: sobe o esquema
 * real em PGlite e provoca os CHECKs de `fiscal_limit_configs.legal_limit` (0..1)
 * e `fiscal_monthly_balances` (net_current_revenue>=0; reference_month é início de
 * mês). (3) CONFORMIDADE (lint): a janela de 12 meses, a fonte legal e a rota com
 * o aviso de controle interno.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { createTestDb } from "./helpers/pglite.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = mkdtempSync(join(tmpdir(), "lrf-test-"));

// Stubs dos deps de servidor: só interessa a função pura classifyLrf.
const startStub = join(dir, "start.mjs");
writeFileSync(
  startStub,
  `export function createServerFn() {
     const b = {}; for (const m of ["middleware","validator","inputValidator","handler"]) b[m] = () => b; return b;
   }`,
);
const dbStub = join(dir, "db.mjs");
writeFileSync(dbStub, `export async function query() { return []; }`);
const dataStub = join(dir, "data.mjs");
writeFileSync(dataStub, `export const requireAuth = {};`);
const taStub = join(dir, "ta.mjs");
writeFileSync(
  taStub,
  `export async function loadTenantAccess() { return {}; }
   export function requireTenantPermission() {}`,
);

const bundle = join(dir, "lrf.mjs");
await build({
  entryPoints: ["src/lib/fiscal-dashboard.functions.ts"],
  bundle: true,
  format: "esm",
  platform: "node",
  outfile: bundle,
  logLevel: "silent",
  external: ["node:*"],
  plugins: [
    {
      name: "stub",
      setup(b) {
        b.onResolve({ filter: /@tanstack\/react-start$/ }, () => ({
          path: startStub,
          external: true,
        }));
        b.onResolve({ filter: /(^|\/)db\.server$/ }, () => ({
          path: dbStub,
          external: true,
        }));
        b.onResolve({ filter: /(^|\/)data\.functions$/ }, () => ({
          path: dataStub,
          external: true,
        }));
        b.onResolve({ filter: /(^|\/)tenant-access\.server$/ }, () => ({
          path: taStub,
          external: true,
        }));
      },
    },
  ],
});
const { classifyLrf } = await import(bundle);

// Defaults auditáveis da migration (LC 101/2000): legal .54, prudencial .95, alerta .90.
const CFG = { legal_limit: 0.54, warning_ratio: 0.9, prudential_ratio: 0.95 };

let db;
let tenantId;
const USER = "17000000-0000-4000-8000-000000000017";
before(async () => {
  db = await createTestDb();
  tenantId = (
    await db.query(
      "select id from public.tenants where status='ativo' order by created_at,id limit 1",
    )
  ).rows[0].id;
  // updated_by é NOT NULL → semeia um profile real para isolar o CHECK do NOT NULL.
  await db.query(
    "insert into public.app_users(id,email,password_hash) values($1,'u17@e.com','x')",
    [USER],
  );
  await db.query("insert into public.profiles(id,full_name) values($1,'U17')", [
    USER,
  ]);
});
after(async () => {
  await db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("runtime: escada de faixas da LRF", () => {
  const rcl = 100;
  // acima do limite legal (>54) → exceeded
  assert.equal(classifyLrf(60, rcl, CFG).level, "exceeded");
  // entre prudencial (.54*.95=.513) e legal (.54) → prudential
  assert.equal(classifyLrf(52, rcl, CFG).level, "prudential");
  // entre alerta (.54*.90=.486) e prudencial (.513) → warning
  assert.equal(classifyLrf(50, rcl, CFG).level, "warning");
  // bem abaixo → regular
  assert.equal(classifyLrf(30, rcl, CFG).level, "regular");
  // razão e limite computados
  const r = classifyLrf(60, rcl, CFG);
  assert.equal(r.ratio, 0.6);
  assert.equal(r.legalLimit, 0.54);
});

test("runtime: rcl zero não divide por zero (razão 0 → regular)", () => {
  assert.equal(classifyLrf(10, 0, CFG).ratio, 0);
  assert.equal(classifyLrf(10, 0, CFG).level, "regular");
});

test("as tabelas fiscais existem", async () => {
  const r = await db.query(
    `select table_name from information_schema.tables
     where table_schema='public' and table_name = any($1)`,
    [["fiscal_limit_configs", "fiscal_monthly_balances"]],
  );
  assert.equal(r.rows.length, 2);
});

test("CHECK: legal_limit entre 0 e 1 (1.5 é recusado)", async () => {
  await assert.rejects(
    db.query(
      `insert into public.fiscal_limit_configs(tenant_id,legal_limit) values($1,1.5)`,
      [tenantId],
    ),
    /legal_limit|check/i,
  );
});

test("CHECK: net_current_revenue não pode ser negativo", async () => {
  await assert.rejects(
    db.query(
      `insert into public.fiscal_monthly_balances(tenant_id,reference_month,net_current_revenue,personnel_expense,updated_by)
       values($1,'2024-03-01',-1,0,$2)`,
      [tenantId, USER],
    ),
    /net_current_revenue|check/i,
  );
});

test("CHECK: reference_month precisa ser início de mês", async () => {
  await assert.rejects(
    db.query(
      `insert into public.fiscal_monthly_balances(tenant_id,reference_month,net_current_revenue,personnel_expense,updated_by)
       values($1,'2026-01-15',0,0,$2)`,
      [tenantId, USER],
    ),
    /reference_month|check/i,
  );
});

test("lint: janela de 12 meses, fonte legal e aviso de controle interno na rota", () => {
  const mod = readFileSync(
    join(root, "src", "lib", "fiscal-dashboard.functions.ts"),
    "utf8",
  );
  assert.match(mod, /limit 12/);
  assert.match(mod, /sourceUrl/);
  const route = readFileSync(
    join(root, "src", "routes", "gestor", "lrf.tsx"),
    "utf8",
  );
  assert.match(route, /controle interno/);
});
