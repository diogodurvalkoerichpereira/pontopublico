// Aplicador de migrations. Usa o driver pg que já é dependência: nenhuma
// ferramenta nova, nenhum pacote novo.
//
// Duas fases:
//   bootstrap  db/bootstrap/**        reaplicado sempre (emulação de ambiente)
//   migration  supabase/migrations/** aplicado uma vez, registrado no ledger
//
// Decisões que importam:
//
// 1. Uma transação por arquivo, sem aninhar. Catorze migrations já trazem
//    begin;/commit; próprios. Envelopá-las num BEGIN externo faria o commit
//    interno fechar a transação de fora, com perda silenciosa de atomicidade.
//
// 2. Nunca aplicar tudo numa transação só. 20260515015447 faz
//    ALTER TYPE app_role ADD VALUE 'admin' e 20260515015539 usa 'admin'::app_role.
//    O PostgreSQL exige que estejam em transações distintas.
//
// 3. Guarda de versão do servidor: aborta abaixo do PostgreSQL 13, porque 26
//    migrations usam gen_random_uuid(), nativa só a partir dessa versão. Protege
//    contra apontar o DATABASE_URL para a instância legada da porta 5432.
//
// 4. Checksum SHA-256 por arquivo: impede editar migration já aplicada, que é
//    exatamente o cenário que produziu os defeitos das Sprints 13 e 19.

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import pg from "pg";

const ROOT = resolve(import.meta.dirname, "..");
const PHASES = [
  { name: "bootstrap", dir: join(ROOT, "db", "bootstrap"), idempotent: true },
  {
    name: "migration",
    dir: join(ROOT, "supabase", "migrations"),
    idempotent: false,
  },
];
const LOCK_ID = 8514230917446231n;

const args = new Set(process.argv.slice(2));
const STATUS = args.has("--status");

const url = process.env.DATABASE_URL || process.env.POSTGRES_URL;
if (!url) {
  console.error(
    "DATABASE_URL não configurada. Crie o .env a partir de .env.example.",
  );
  process.exit(1);
}

const client = new pg.Client({
  connectionString: url,
  application_name: "db-migrate",
});
await client.connect();

const { host, port, database, user } = client.connectionParameters;
console.log(`alvo: ${user}@${host}:${port}/${database}`);

const {
  rows: [v],
} = await client.query("show server_version_num");
if (Number(v.server_version_num) < 130000) {
  console.error(
    `PostgreSQL ${v.server_version_num} incompatível: as migrations exigem 13 ou superior.`,
  );
  console.error(
    "Causa provável: DATABASE_URL apontando para a instância legada da porta 5432.",
  );
  await client.end();
  process.exit(1);
}

await client.query("select pg_advisory_lock($1)", [LOCK_ID.toString()]);

await client.query(`
  create table if not exists public.schema_migrations (
    version     text primary key,
    phase       text        not null,
    checksum    text        not null,
    applied_at  timestamptz not null default now(),
    duration_ms integer     not null
  )`);

const applied = new Map(
  (
    await client.query("select version, checksum from public.schema_migrations")
  ).rows.map((r) => [r.version, r.checksum]),
);

const OWNS_TX = /^\s*begin\s*;/im;
let pending = 0;
let done = 0;
let failed = false;

outer: for (const phase of PHASES) {
  if (!existsSync(phase.dir)) continue;
  for (const file of readdirSync(phase.dir)
    .filter((f) => f.endsWith(".sql"))
    .sort()) {
    const sql = readFileSync(join(phase.dir, file), "utf8");
    const checksum = createHash("sha256").update(sql).digest("hex");
    const version = `${phase.name}/${file}`;
    const seen = applied.get(version);

    if (seen !== undefined && !phase.idempotent) {
      if (seen !== checksum && !args.has("--allow-checksum-drift")) {
        console.error(
          `\nDIVERGÊNCIA: ${version} já foi aplicado com outro conteúdo.`,
        );
        console.error(
          "  Migration aplicada não deve ser editada. Recrie a base ou use --allow-checksum-drift.",
        );
        failed = true;
        break outer;
      }
      continue;
    }

    // A fase bootstrap é reaplicada a cada execução por definição, então nunca
    // conta como pendência: contá-la faria "pendentes: 0" ser inalcançável.
    if (phase.idempotent) {
      if (STATUS) console.log(`REAPLICA ${version}`);
    } else {
      pending++;
      if (STATUS) console.log(`PENDENTE ${version}`);
    }
    if (STATUS) continue;

    const t0 = Date.now();
    const ownsTx = OWNS_TX.test(sql);
    try {
      if (!ownsTx) await client.query("begin");
      await client.query(sql);
      await client.query(
        `insert into public.schema_migrations (version, phase, checksum, duration_ms)
         values ($1,$2,$3,$4)
         on conflict (version) do update
           set checksum = excluded.checksum,
               applied_at = now(),
               duration_ms = excluded.duration_ms`,
        [version, phase.name, checksum, Date.now() - t0],
      );
      if (!ownsTx) await client.query("commit");
      console.log(`OK   ${version} (${Date.now() - t0} ms)`);
      done++;
    } catch (e) {
      if (!ownsTx) {
        try {
          await client.query("rollback");
        } catch {
          /* transação já abortada pelo próprio arquivo */
        }
      }
      console.error(`\nFALHA em ${version}`);
      console.error(`  ${e.severity ?? "ERROR"} ${e.code ?? ""}: ${e.message}`);
      if (e.detail) console.error(`  detalhe: ${e.detail}`);
      if (e.hint) console.error(`  dica: ${e.hint}`);
      if (e.where) console.error(`  contexto: ${e.where}`);
      if (e.position) console.error(`  posição: caractere ${e.position}`);
      failed = true;
      break outer;
    }
  }
}

await client.query("select pg_advisory_unlock($1)", [LOCK_ID.toString()]);
console.log(STATUS ? `pendentes: ${pending}` : `aplicadas agora: ${done}`);
await client.end();
process.exit(failed ? 1 : 0);
