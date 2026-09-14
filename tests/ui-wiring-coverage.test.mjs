/**
 * Cobertura de fluxo de trabalho: toda server function alcança uma tela.
 *
 * Uma função de servidor correta, testada e sem nenhuma rota que a chame é um
 * passo do processo que o usuário não tem como executar. Não quebra teste nenhum
 * — o módulo parece pronto e a cadeia está cortada. Foi assim que
 * `createBudgetCommitment` ficou sem "Novo empenho" (a despesa não tinha como
 * começar), `saveServiceTaxpayer` sem cadastro (a lista de prestadores de ISS
 * nascia vazia para sempre) e `launchTaxCredit` sem tela (TAXA e COSIP
 * simplesmente não existiam na aplicação). A varredura por AST achou 49 casos.
 *
 * Este check estático — irmão de authorization-coverage.test.mjs — varre por AST
 * cada `export const X = createServerFn` em src/lib/*.functions.ts e exige que o
 * nome apareça em src/routes ou src/components, direto ou por um módulo de lib
 * que a UI importa. As exceções legítimas (infraestrutura, orquestração
 * servidor-a-servidor, módulo ainda sem tela) ficam numa ALLOWLIST com razão de
 * uma linha. Uma função nova sem tela e fora da allowlist quebra o CI.
 *
 * É uma rede de fluxo, como uma regra de lint — complementa, não substitui, os
 * testes de comportamento.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import ts from "typescript";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const libDir = join(root, "src", "lib");

/**
 * Exceções legítimas. Cada entrada exige uma razão. O teste falha se uma entrada
 * aqui não corresponder a nenhum export real (allowlist morta) E se corresponder
 * a uma função que JÁ tem tela (exceção obsoleta) — para que a lista encolha
 * sozinha à medida que os módulos ganham interface.
 */
const ALLOWLIST = {
  // Infraestrutura: o shim de @/integrations/supabase é quem as chama.
  dbQuery: "shim supabase: caminho genérico de consulta",
  signIn: "shim supabase: login",
  signOutSession: "shim supabase: logout",
  storageUpload: "shim supabase: upload de arquivo",
  storageDownload: "shim supabase: download de arquivo",
  // Orquestração servidor-a-servidor: chamadas por outra server function.
  postAccountingEntry: "chamado por accounting-read/roteiros, não pela tela",
  processEsocialQueue: "worker da fila; disparado por enqueue/agendamento",

  // --- Módulos ainda sem tela. Cada um é dívida de fluxo registrada no BACKLOG. ---
  // Folha: cadeia folha -> empenho -> pagamento e depósitos na folha.
  commitPayrollEmpenho: "O1-08b — empenho da folha sem tela",
  commitContractEmpenho: "O3-12b — empenho do contrato sem tela",
  getPayrollEmpenhoRequests: "O1-08b — solicitação de empenho sem tela",
  emitPayrollEmpenhoRequest: "O1-08b — solicitação de empenho sem tela",
  publishClosedPayroll: "O1-09b — publicação da folha fechada sem tela",
  depositConsignmentsToPayroll: "O1-10b — depósito de consignações sem tela",
  depositVacationToPayroll: "O1-06b — depósito de férias sem tela",
  projectPayrollBases: "O1-11b — projeção de bases sem tela",
  getPensionRegimeRubrics: "O1-02e — rubricas do regime sem tela",
  // Ponto.
  recordTimeClockPunch: "O1-03f — marcação encadeada sem tela",
  getTimeClockPunches: "O1-03f — lista de marcações sem tela",
  verifyTimeClockChain: "O1-03f — verificação da cadeia sem tela",
  getTimeMirror: "O1-03f — espelho de ponto sem tela",
  getPunchReceipt: "O1-03f — comprovante ao trabalhador sem tela",
  getTimeApuracao: "O1-03f — apuração valorada sem tela",
  depositTimeApuracao: "O1-03f — depósito da apuração sem tela",
  getHolidays: "O1-03g — calendário de feriados sem tela",
  saveHoliday: "O1-03g — calendário de feriados sem tela",
  // Tesouraria e contabilidade.
  getTreasuryReconciliations: "O2-31 — conciliação bancária sem tela",
  reconcileTreasuryAccount: "O2-31 — conciliação bancária sem tela",
  generateBankRemittance: "O2-32 — remessa bancária sem tela",
  getBankRemittances: "O2-32 — remessa bancária sem tela",
  getAccountingEntries: "O2-33 — razão contábil sem tela",
  // Receita.
  getRevenueExecution: "O4-17 — execução da receita sem tela",
  // Governança, integrações e plataforma.
  assignSecurityRole: "O0-14 — atribuição de papel sem tela",
  saveFiscalMonth: "O2-34 — fechamento de mês fiscal sem tela",
  enqueueEsocialEvent: "O1-12b — fila do eSocial sem tela",
  getEsocialQueueStatus: "O1-12b — fila do eSocial sem tela",
  generateOfficialExport: "O6-02b — exportação oficial sem tela",
  createMigrationJob: "O0-15 — migração histórica sem tela",
  stageHistoricalRows: "O0-15 — migração histórica sem tela",
  reconcileMigrationJob: "O0-15 — migração histórica sem tela",
  commitMigrationJob: "O0-15 — migração histórica sem tela",
  profileDataset: "O6-03b — perfil de dataset sem tela",
  savePushSubscription: "O6-04b — notificação push sem tela",
  queuePushNotification: "O6-04b — notificação push sem tela",
};

/** Nomes exportados como `export const X = createServerFn(...)`. */
function serverFnExports(file) {
  const src = readFileSync(file, "utf8");
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true);
  const names = [];
  for (const stmt of sf.statements) {
    if (!ts.isVariableStatement(stmt)) continue;
    const exported = stmt.modifiers?.some(
      (m) => m.kind === ts.SyntaxKind.ExportKeyword,
    );
    if (!exported) continue;
    for (const decl of stmt.declarationList.declarations) {
      if (!ts.isIdentifier(decl.name) || !decl.initializer) continue;
      if (/\bcreateServerFn\s*\(/.test(decl.initializer.getText(sf)))
        names.push(decl.name.text);
    }
  }
  return names;
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(p)) out.push(p);
  }
  return out;
}

test("toda server function alcança uma tela", () => {
  const libFiles = readdirSync(libDir)
    .filter((f) => f.endsWith(".functions.ts"))
    .map((f) => join(libDir, f));

  // `src/lib/*.tsx` conta como tela: é provider/componente React (auth-context),
  // não módulo de servidor.
  const uiFiles = [
    ...walk(join(root, "src", "routes")),
    ...walk(join(root, "src", "components")),
    ...readdirSync(libDir)
      .filter((f) => f.endsWith(".tsx"))
      .map((f) => join(libDir, f)),
  ];
  const ui = uiFiles.map((f) => readFileSync(f, "utf8")).join("\n");

  const orphans = [];
  const wired = new Set();
  const seenExports = new Set();

  for (const file of libFiles) {
    for (const name of serverFnExports(file)) {
      seenExports.add(name);
      const referenced = new RegExp(`\\b${name}\\b`).test(ui);
      if (referenced) wired.add(name);
      else if (!(name in ALLOWLIST))
        orphans.push(`${name} (${file.replace(root + "/", "")})`);
    }
  }

  assert.deepEqual(
    orphans,
    [],
    `Server functions sem nenhuma tela — o passo existe mas o usuário não tem como executá-lo:\n  ${orphans.join(
      "\n  ",
    )}\nLigue a função a uma rota, ou justifique na ALLOWLIST.`,
  );

  // Allowlist morta: entrada que não corresponde a nenhum export atual.
  const dead = Object.keys(ALLOWLIST).filter((k) => !seenExports.has(k));
  assert.deepEqual(
    dead,
    [],
    `Entradas da ALLOWLIST sem export correspondente: ${dead.join(", ")}`,
  );

  // Exceção obsoleta: a função ganhou tela e continua na allowlist. Remover a
  // entrada é o que faz a lista encolher em vez de fossilizar.
  const obsoletas = Object.keys(ALLOWLIST).filter(
    (k) => wired.has(k) && !k.startsWith("db") && k !== "postAccountingEntry",
  );
  assert.deepEqual(
    obsoletas,
    [],
    `Entradas da ALLOWLIST que já têm tela — remova-as: ${obsoletas.join(", ")}`,
  );
});
