import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { FileUp } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAuth } from "@/lib/auth-context";
import {
  commitPayrollImport,
  getPayrollImports,
  stagePayrollImport,
} from "@/lib/payroll-import.functions";
export const Route = createFileRoute("/rh/importacoes")({ component: Page });
function Page() {
  const { activeTenant } = useAuth(),
    load = useServerFn(getPayrollImports),
    stage = useServerFn(stagePayrollImport),
    commit = useServerFn(commitPayrollImport),
    qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ["imports", activeTenant?.id],
    enabled: !!activeTenant,
    queryFn: () => load({ data: { tenant_id: activeTenant!.id } }),
  });
  const [month, setMonth] = useState(new Date().toISOString().slice(0, 7)),
    [busy, setBusy] = useState(false);
  if (!activeTenant) return null;
  const refresh = () =>
    qc.invalidateQueries({ queryKey: ["imports", activeTenant.id] });
  const parse = async (file: File) => {
    if (file.name.toLowerCase().endsWith(".xlsx")) {
      const ExcelJS = await import("exceljs");
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(await file.arrayBuffer());
      const ws = wb.worksheets[0],
        headers = (ws.getRow(1).values as any[])
          .slice(1)
          .map((v) => String(v).toLowerCase().trim());
      const rows: any[] = [];
      ws.eachRow((row, n) => {
        if (n === 1) return;
        const v = (row.values as any[]).slice(1),
          o: any = {};
        headers.forEach((h, i) => (o[h] = v[i]?.text ?? v[i]));
        rows.push(o);
      });
      return rows;
    }
    const text = await file.text(),
      lines = text.split(/\r?\n/).filter(Boolean),
      sep = lines[0].includes(";") ? ";" : ",";
    const headers = lines
      .shift()!
      .split(sep)
      .map((h) => h.toLowerCase().trim());
    return lines.map((line) =>
      Object.fromEntries(line.split(sep).map((v, i) => [headers[i], v.trim()])),
    );
  };
  return (
    <section className="space-y-6">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-extrabold">
          <FileUp />
          Importações em lote
        </h1>
        <p className="text-sm text-muted-foreground">
          TXT, CSV e XLSX com pré-validação por matrícula e rubrica.
        </p>
      </div>
      <div className="flex gap-3 rounded-2xl border bg-card p-5">
        <Input
          type="month"
          value={month}
          onChange={(e) => setMonth(e.target.value)}
          className="w-44"
        />
        <Input
          type="file"
          accept=".txt,.csv,.xlsx"
          disabled={busy}
          onChange={async (e) => {
            const f = e.target.files?.[0];
            if (!f) return;
            setBusy(true);
            try {
              const rows = await parse(f);
              const type = f.name.split(".").pop()!.toLowerCase() as
                "txt" | "csv" | "xlsx";
              const r = await stage({
                data: {
                  tenant_id: activeTenant.id,
                  file_name: f.name,
                  file_type: type,
                  reference_month: month,
                  rows,
                },
              });
              await refresh();
              toast.success(`${r.valid} válidas, ${r.error} com erro`);
            } catch (err) {
              toast.error(err instanceof Error ? err.message : "Falha");
            } finally {
              setBusy(false);
            }
          }}
        />
      </div>
      <div className="rounded-2xl border bg-card p-5">
        <h2 className="mb-3 font-bold">Lotes</h2>
        {data?.batches.map((b: any) => (
          <div
            key={b.id}
            className="flex items-center justify-between border-b py-3"
          >
            <span>
              {b.file_name} · {b.reference_month.slice(0, 7)} · {b.valid_rows}
              /{b.total_rows}
            </span>
            <span className="flex gap-2">
              <Badge>{b.status}</Badge>
              {b.status === "pre_validado" && (
                <Button
                  size="sm"
                  onClick={async () => {
                    const r = await commit({
                      data: { tenant_id: activeTenant.id, batch_id: b.id },
                    });
                    await refresh();
                    toast.success(`${r.imported} linhas importadas`);
                  }}
                >
                  Confirmar
                </Button>
              )}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}
