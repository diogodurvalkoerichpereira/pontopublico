// Replay completo do esquema (bootstrap + migrations) num PostgreSQL 17 em memória,
// via PGlite, que já é devDependency do projeto.
//
// Por que existe: os validadores das Sprints 8 a 20 não abrem banco, são comparação
// de texto sobre os arquivos. Foi assim que a Sprint 19 passou verde com um erro de
// sintaxe que impede o arquivo de rodar em qualquer PostgreSQL, e que a Sprint 13
// passou com um nome de coluna inexistente.
//
// Diferença central para o aplicador: aqui NÃO se para no primeiro erro. Coleta-se
// toda falha de uma vez, para não descobrir os problemas um por execução.
//
// Roda sem Docker e sem banco. É o gate de qualquer mudança em supabase/migrations.

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";

const ROOT = resolve(import.meta.dirname, "..");
const DIRS = [
  join(ROOT, "db", "bootstrap"),
  join(ROOT, "supabase", "migrations"),
];

const db = new PGlite();
const falhas = [];
let total = 0;

const primeiraLinha = (e) => String(e?.message ?? e).split("\n")[0];

for (const dir of DIRS) {
  if (!existsSync(dir)) continue;
  for (const f of readdirSync(dir)
    .filter((x) => x.endsWith(".sql"))
    .sort()) {
    total++;
    try {
      await db.exec(readFileSync(join(dir, f), "utf8"));
      console.log(`OK    ${f}`);
    } catch (e) {
      falhas.push({ f, msg: primeiraLinha(e) });
      console.log(`FALHA ${f}  ->  ${primeiraLinha(e)}`);
      // um arquivo com begin; deixa a transação aberta e abortada
      try {
        await db.exec("rollback");
      } catch {
        /* não havia transação aberta */
      }
    }
  }
}

// Smoke do caminho crítico: reproduz os inserts que src/lib/data.functions.ts
// executa no signUp. É o que pega FK apontando para o lugar errado, que nenhuma
// migration sozinha revela.
if (!falhas.length) {
  const uid = "11111111-1111-4111-8111-111111111111";
  const mail = "smoke@example.com";
  try {
    await db.exec("begin");
    await db.query(
      "insert into public.app_users(id,email,password_hash,raw_user_meta_data) values($1,$2,$3,$4)",
      [uid, mail, "scrypt$salt$hash", "{}"],
    );
    await db.query(
      "insert into public.profiles(id,full_name,email,cpf,matricula,setor) values($1,'Smoke',$2,'','','')",
      [uid, mail],
    );
    await db.query(
      "insert into public.persons(id,full_name,personal_email) values($1,'Smoke',$2)",
      [uid, mail],
    );
    const t = await db.query(
      "select id from public.tenants where status='ativo' order by created_at,id limit 1",
    );
    if (!t.rows.length)
      throw new Error("nenhum tenant ativo criado pelas migrations");
    await db.query(
      "insert into public.tenant_memberships(tenant_id,user_id,status,is_default) values($1,$2,'ativo',true)",
      [t.rows[0].id, uid],
    );
    await db.query(
      `insert into public.employment_links(tenant_id,person_id,source_profile_id,registration_number,status)
       values($1,$2,$3,'SMOKE','rascunho')`,
      [t.rows[0].id, uid, uid],
    );
    await db.exec("commit");
    console.log("\nSMOKE signUp: OK");
  } catch (e) {
    falhas.push({ f: "SMOKE signUp", msg: primeiraLinha(e) });
    console.log(`\nSMOKE signUp FALHOU -> ${primeiraLinha(e)}`);
  }
}

await db.close();

if (falhas.length) {
  console.log("\nfalhas:");
  for (const { f, msg } of falhas) console.log(`  ${f}: ${msg}`);
}
console.log(`\narquivos=${total} falhas=${falhas.length}`);
process.exit(falhas.length ? 1 : 0);
