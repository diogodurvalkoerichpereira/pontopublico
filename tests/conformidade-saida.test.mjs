/**
 * Conformidade dos artefatos de saída — Sprints 10 (remessa), 11 (exportação) e
 * 12 (eSocial). Substitui os grep validate-sprint10/11/12.mjs.
 *
 * Três redes: (1) COMPORTAMENTO em runtime — executa `conformanceOf` e afere o
 * status honesto; (2) COMPORTAMENTO no banco — o esquema real em PGlite existe e
 * NÃO guarda o segredo do certificado; (3) CONFORMIDADE (lint) sobre a fonte — os
 * rótulos não podem voltar a se apresentar como padrão oficial. A rede (3) é a
 * guarda de honestidade que era o único conteúdo dos validadores antigos, agora
 * ancorada às redes (1) e (2) que executam o código.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { createTestDb } from "./helpers/pglite.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = mkdtempSync(join(tmpdir(), "conf-test-"));
const src = (rel) => readFileSync(join(root, rel), "utf8");

// conformance.ts é puro (sem imports de runtime) — bundle direto.
const bundle = join(dir, "conformance.mjs");
await build({
  entryPoints: ["src/lib/conformance.ts"],
  bundle: true,
  format: "esm",
  platform: "node",
  outfile: bundle,
  logLevel: "silent",
  external: ["node:*"],
});
const { conformanceOf } = await import(bundle);

let db;
before(async () => {
  db = await createTestDb();
});
after(async () => {
  await db.close();
  rmSync(dir, { recursive: true, force: true });
});

// --- Rede 1: conformanceOf em runtime ---------------------------------------
test("runtime: remessa bancária é rascunho, não CNAB 240", () => {
  const n = conformanceOf("remessa-bancaria");
  assert.equal(n.status, "rascunho");
  assert.match(n.padraoOficialPendente, /CNAB 240/);
});

test("runtime: exportação oficial é rascunho", () => {
  assert.equal(conformanceOf("exportacao-oficial").status, "rascunho");
});

test("runtime: transmissão eSocial é não-implementado", () => {
  assert.equal(conformanceOf("esocial-transmissao").status, "nao-implementado");
});

// --- Rede 2: esquema real em PGlite ------------------------------------------
test("as tabelas de saída existem no esquema aplicado", async () => {
  const r = await db.query(
    `select table_name from information_schema.tables
     where table_schema='public' and table_name = any($1)`,
    [
      [
        "bank_remittance_batches",
        "official_export_batches",
        "official_export_layouts",
        "esocial_events",
        "esocial_event_attempts",
      ],
    ],
  );
  assert.equal(r.rows.length, 5, "as cinco tabelas de saída devem existir");
});

test("eSocial não guarda o segredo do certificado no banco", async () => {
  const priv = await db.query(
    `select 1 from information_schema.columns
     where table_schema='public' and table_name like 'esocial%'
       and column_name ilike '%private_key%'`,
  );
  assert.equal(priv.rows.length, 0, "nenhuma coluna de chave privada");
  const ref = await db.query(
    `select 1 from information_schema.columns
     where table_schema='public' and column_name = 'secret_reference'`,
  );
  assert.ok(ref.rows.length >= 1, "o segredo é referência, não valor guardado");
});

// --- Rede 3: honestidade dos rótulos na fonte (lint) -------------------------
test("remessa: nenhum rótulo se apresenta como CNAB 240", () => {
  const s = src("src/lib/bank-remittance.functions.ts");
  assert.doesNotMatch(
    s,
    /['"`]CNAB240-v1['"`]/,
    "o arquivo gerado não é CNAB 240",
  );
  assert.match(s, /RASCUNHO-NAO-CNAB240-v1/);
  assert.match(s, /conformanceOf\("remessa-bancaria"\)/);
});

test("exportação: os quatro layouts carregam prefixo RASCUNHO_", () => {
  const s = src("src/lib/official-export.functions.ts");
  for (const oficial of ["TCE_CE_SIM", "SIOPE", "MANAD", "MAND", "PCS_2025"]) {
    assert.doesNotMatch(
      s,
      new RegExp(`['"\`]${oficial}['"\`]`),
      `${oficial} não pode aparecer sem prefixo RASCUNHO_`,
    );
  }
  for (const ok of [
    "RASCUNHO_TCE_CE_SIM",
    "RASCUNHO_SIOPE",
    "RASCUNHO_MANAD",
    "RASCUNHO_PCS",
  ]) {
    assert.ok(s.includes(ok), `falta o código ${ok}`);
  }
});

test("eSocial: nada é marcado 'assinado' sem assinador, e falha explícita", () => {
  const s = src("src/lib/esocial.functions.ts");
  assert.doesNotMatch(
    s,
    /status\s*=\s*'assinado'/,
    "não há assinador XMLDSig: nada pode nascer 'assinado'",
  );
  assert.match(s, /NotImplementedConformanceError/);
});
