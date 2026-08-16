import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  CheckCircle2,
  ClipboardCheck,
  FileLock2,
  Plus,
  Sparkles,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import { AppShell } from "@/components/AppShell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuth } from "@/lib/auth-context";
import { transitionPayrollCycle } from "@/lib/payroll-cycle.functions";
import {
  createSpecialPayroll,
  getSpecialPayrollWorkspace,
} from "@/lib/payroll-special.functions";

export const Route = createFileRoute("/rh/folhas-especiais")({
  component: Page,
});

function Page() {
  const { session, loading, hasTenantPermission } = useAuth();
  const nav = useNavigate();
  useEffect(() => {
    if (loading) return;
    if (!session) nav({ to: "/login" });
    else if (!hasTenantPermission("payroll.special.read")) nav({ to: "/app" });
  }, [session, loading, hasTenantPermission, nav]);
  if (!session) return null;
  return (
    <AppShell>
      <Content />
    </AppShell>
  );
}

const typeLabel = {
  adiantamento: "Adiantamento",
  complementar: "Complementar",
  decimo_primeira: "13º · 1ª parcela",
  decimo_segunda: "13º · 2ª parcela",
} as const;

const statusLabel: Record<string, string> = {
  previa: "Prévia",
  em_conferencia: "Em conferência",
  aprovada: "Aprovada",
  fechada: "Fechada",
};

type SpecialType = keyof typeof typeLabel;
type Adjustment = {
  employment_link_id: string;
  nature: "provento" | "desconto";
  amount: number;
  reason: string;
};

function Content() {
  const { activeTenant } = useAuth();
  const load = useServerFn(getSpecialPayrollWorkspace);
  const create = useServerFn(createSpecialPayroll);
  const transition = useServerFn(transitionPayrollCycle);
  const qc = useQueryClient();
  const [selectedId, setSelectedId] = useState("");
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [cycleType, setCycleType] = useState<SpecialType>("adiantamento");
  const [month, setMonth] = useState(new Date().toISOString().slice(0, 7));
  const [percentage, setPercentage] = useState("40");
  const [method, setMethod] = useState<
    "ultimo_salario" | "media_remuneratoria"
  >("ultimo_salario");
  const [sourceId, setSourceId] = useState("");
  const [selectedLinks, setSelectedLinks] = useState<string[]>([]);
  const [adjustments, setAdjustments] = useState<Adjustment[]>([]);
  const [adjustmentLink, setAdjustmentLink] = useState("");
  const [adjustmentNature, setAdjustmentNature] = useState<
    "provento" | "desconto"
  >("provento");
  const [adjustmentAmount, setAdjustmentAmount] = useState("");
  const [adjustmentReason, setAdjustmentReason] = useState("");

  const { data } = useQuery({
    queryKey: ["special-payrolls", activeTenant?.id],
    enabled: Boolean(activeTenant),
    queryFn: () => load({ data: { tenant_id: activeTenant!.id } }),
  });
  useEffect(() => {
    if (!selectedId && data?.cycles[0]) setSelectedId(data.cycles[0].id);
    if (!adjustmentLink && data?.links[0]) setAdjustmentLink(data.links[0].id);
  }, [data, selectedId, adjustmentLink]);
  const selected = data?.cycles.find((item) => item.id === selectedId);
  const results = useMemo(
    () => data?.results.filter((item) => item.cycle_id === selectedId) ?? [],
    [data, selectedId],
  );
  const refresh = () =>
    qc.invalidateQueries({ queryKey: ["special-payrolls", activeTenant?.id] });
  const fmt = (value: number) =>
    Number(value).toLocaleString("pt-BR", {
      style: "currency",
      currency: "BRL",
    });

  const openCreate = () => {
    setSelectedLinks(data?.links.map((item) => item.id) ?? []);
    setAdjustments([]);
    setOpen(true);
  };
  const addAdjustment = () => {
    const amount = Number(adjustmentAmount);
    if (!adjustmentLink || amount <= 0 || adjustmentReason.trim().length < 5)
      return toast.error(
        "Informe vínculo, valor e motivo com ao menos 5 caracteres",
      );
    setAdjustments([
      ...adjustments,
      {
        employment_link_id: adjustmentLink,
        nature: adjustmentNature,
        amount,
        reason: adjustmentReason.trim(),
      },
    ]);
    setAdjustmentAmount("");
    setAdjustmentReason("");
  };
  const submit = async () => {
    if (!activeTenant) return;
    setBusy(true);
    try {
      const result = await create({
        data: {
          tenant_id: activeTenant.id,
          reference_month: month,
          cycle_type: cycleType,
          employment_link_ids: selectedLinks,
          advance_percentage:
            cycleType === "adiantamento" ? Number(percentage) : undefined,
          calculation_method: cycleType.startsWith("decimo_")
            ? method
            : undefined,
          source_cycle_id: cycleType === "complementar" ? sourceId : undefined,
          adjustments: cycleType === "complementar" ? adjustments : [],
        },
      });
      await refresh();
      setSelectedId(result.cycleId);
      setOpen(false);
      toast.success(
        `${typeLabel[cycleType]} calculada para ${result.links} vínculo(s)`,
      );
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "Falha ao calcular folha especial",
      );
    } finally {
      setBusy(false);
    }
  };
  const act = async (action: "review" | "approve" | "close") => {
    if (!activeTenant || !selected) return;
    setBusy(true);
    try {
      await transition({
        data: {
          tenant_id: activeTenant.id,
          cycle_id: selected.id,
          expected_version: selected.version,
          action,
        },
      });
      await refresh();
      toast.success("Situação atualizada");
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Falha na transição",
      );
    } finally {
      setBusy(false);
    }
  };

  if (!activeTenant)
    return (
      <div className="rounded-xl border bg-amber-50 p-6">
        Selecione uma entidade.
      </div>
    );

  return (
    <section className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Sparkles className="size-7 text-primary" />
          <div>
            <h1 className="text-2xl font-extrabold">Folhas especiais</h1>
            <p className="text-sm text-muted-foreground">
              Adiantamento, complementar e 13º com memória e fluxo de aprovação.
            </p>
          </div>
        </div>
        {data?.permissions.manage && (
          <Button onClick={openCreate}>
            <Plus className="mr-1 size-4" /> Nova folha especial
          </Button>
        )}
      </div>

      <div className="grid gap-5 xl:grid-cols-[360px_minmax(0,1fr)]">
        <aside className="space-y-2 rounded-2xl border bg-card p-4 shadow-sm">
          <h2 className="mb-3 font-bold">Processamentos</h2>
          {data?.cycles.map((cycle) => (
            <button
              key={cycle.id}
              className={`w-full rounded-xl border p-4 text-left hover:bg-muted ${selectedId === cycle.id ? "border-primary bg-primary/5" : ""}`}
              onClick={() => setSelectedId(cycle.id)}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-semibold">
                  {typeLabel[cycle.cycle_type]}
                </span>
                <Badge
                  variant={cycle.status === "fechada" ? "default" : "secondary"}
                >
                  {statusLabel[cycle.status] ?? cycle.status}
                </Badge>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                {cycle.reference_month.slice(0, 7)} · lote {cycle.sequence} ·{" "}
                {fmt(cycle.total_net)}
              </p>
            </button>
          ))}
          {!data?.cycles.length && (
            <p className="py-10 text-center text-sm text-muted-foreground">
              Nenhuma folha especial.
            </p>
          )}
        </aside>

        {selected ? (
          <div className="space-y-5">
            <div className="rounded-2xl border bg-card p-5 shadow-sm">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h2 className="text-lg font-bold">
                    {typeLabel[selected.cycle_type]}
                  </h2>
                  <p className="text-xs text-muted-foreground">
                    {selected.reference_month.slice(0, 7)} · lote{" "}
                    {selected.sequence} · método{" "}
                    {selected.calculation_method ?? "parametrizado"}
                  </p>
                </div>
                <div className="flex gap-2">
                  {selected.status === "previa" && data?.permissions.manage && (
                    <Button onClick={() => void act("review")} disabled={busy}>
                      <ClipboardCheck className="mr-1 size-4" /> Conferir
                    </Button>
                  )}
                  {selected.status === "em_conferencia" &&
                    data?.permissions.approve && (
                      <Button
                        onClick={() => void act("approve")}
                        disabled={busy}
                      >
                        <CheckCircle2 className="mr-1 size-4" /> Aprovar
                      </Button>
                    )}
                  {selected.status === "aprovada" &&
                    data?.permissions.close && (
                      <Button onClick={() => void act("close")} disabled={busy}>
                        <FileLock2 className="mr-1 size-4" /> Fechar
                      </Button>
                    )}
                </div>
              </div>
              <div className="mt-5 grid gap-3 sm:grid-cols-3">
                <Stat label="Proventos" value={fmt(selected.total_earnings)} />
                <Stat
                  label="Descontos"
                  value={fmt(selected.total_deductions)}
                />
                <Stat label="Líquido" value={fmt(selected.total_net)} />
              </div>
            </div>
            <div className="rounded-2xl border bg-card p-5 shadow-sm">
              <h2 className="mb-4 font-bold">Memória por vínculo</h2>
              <div className="space-y-2">
                {results.map((result) => {
                  const memory = result.calculation_memory[0] as
                    Record<string, unknown> | undefined;
                  return (
                    <details key={result.id} className="rounded-xl border p-4">
                      <summary className="cursor-pointer list-none">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div>
                            <p className="font-semibold">{result.full_name}</p>
                            <p className="font-mono text-xs text-muted-foreground">
                              {result.registration_number}
                            </p>
                          </div>
                          <span className="font-mono font-bold text-primary">
                            {fmt(result.net_amount)}
                          </span>
                        </div>
                      </summary>
                      <div className="mt-3 grid gap-2 border-t pt-3 text-xs sm:grid-cols-3">
                        <Stat label="Proventos" value={fmt(result.earnings)} />
                        <Stat
                          label="Descontos"
                          value={fmt(result.deductions)}
                        />
                        <Stat
                          label="Avos / itens"
                          value={String(memory?.months ?? result.items_count)}
                        />
                        <pre className="col-span-full overflow-x-auto rounded-lg bg-muted p-3 text-[10px]">
                          {JSON.stringify(memory, null, 2)}
                        </pre>
                      </div>
                    </details>
                  );
                })}
              </div>
            </div>
          </div>
        ) : (
          <div className="rounded-2xl border bg-card p-16 text-center text-muted-foreground">
            Selecione um processamento.
          </div>
        )}
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Nova folha especial</DialogTitle>
          </DialogHeader>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Tipo">
              <select
                className="h-10 w-full rounded-md border bg-background px-3"
                value={cycleType}
                onChange={(event) =>
                  setCycleType(event.target.value as SpecialType)
                }
              >
                {Object.entries(typeLabel).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Competência">
              <Input
                type="month"
                value={month}
                onChange={(event) => setMonth(event.target.value)}
              />
            </Field>
            {cycleType === "adiantamento" && (
              <Field label="Percentual">
                <Input
                  type="number"
                  min="1"
                  max="100"
                  value={percentage}
                  onChange={(event) => setPercentage(event.target.value)}
                />
              </Field>
            )}
            {cycleType.startsWith("decimo_") && (
              <Field label="Base do 13º">
                <select
                  className="h-10 w-full rounded-md border bg-background px-3"
                  value={method}
                  onChange={(event) =>
                    setMethod(event.target.value as typeof method)
                  }
                >
                  <option value="ultimo_salario">Último salário</option>
                  <option value="media_remuneratoria">
                    Média das folhas mensais fechadas
                  </option>
                </select>
              </Field>
            )}
            {cycleType === "complementar" && (
              <Field label="Folha mensal fechada">
                <select
                  className="h-10 w-full rounded-md border bg-background px-3"
                  value={sourceId}
                  onChange={(event) => setSourceId(event.target.value)}
                >
                  <option value="">Selecione</option>
                  {data?.monthlyCycles
                    .filter(
                      (item) => item.reference_month.slice(0, 7) === month,
                    )
                    .map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.reference_month.slice(0, 7)} ·{" "}
                        {fmt(item.total_net)}
                      </option>
                    ))}
                </select>
              </Field>
            )}
          </div>

          {cycleType !== "complementar" ? (
            <div className="space-y-2">
              <Label>Vínculos</Label>
              {data?.links.map((link) => (
                <label
                  key={link.id}
                  className="flex items-center gap-3 rounded-lg border p-3"
                >
                  <Checkbox
                    checked={selectedLinks.includes(link.id)}
                    onCheckedChange={(checked) =>
                      setSelectedLinks(
                        checked
                          ? [...new Set([...selectedLinks, link.id])]
                          : selectedLinks.filter((id) => id !== link.id),
                      )
                    }
                  />
                  <span className="flex-1 text-sm">
                    {link.full_name} ·{" "}
                    <span className="font-mono">
                      {link.registration_number}
                    </span>
                  </span>
                  <span className="font-mono text-xs">
                    {fmt(Number(link.base_salary ?? 0))}
                  </span>
                </label>
              ))}
            </div>
          ) : (
            <div className="space-y-3">
              <Label>Ajustes sem alterar a folha original</Label>
              <div className="grid gap-2 sm:grid-cols-4">
                <select
                  className="h-10 rounded-md border bg-background px-2"
                  value={adjustmentLink}
                  onChange={(event) => setAdjustmentLink(event.target.value)}
                >
                  {data?.links.map((link) => (
                    <option key={link.id} value={link.id}>
                      {link.registration_number} · {link.full_name}
                    </option>
                  ))}
                </select>
                <select
                  className="h-10 rounded-md border bg-background px-2"
                  value={adjustmentNature}
                  onChange={(event) =>
                    setAdjustmentNature(
                      event.target.value as typeof adjustmentNature,
                    )
                  }
                >
                  <option value="provento">Provento</option>
                  <option value="desconto">Desconto</option>
                </select>
                <Input
                  type="number"
                  placeholder="Valor"
                  value={adjustmentAmount}
                  onChange={(event) => setAdjustmentAmount(event.target.value)}
                />
                <Input
                  placeholder="Motivo"
                  value={adjustmentReason}
                  onChange={(event) => setAdjustmentReason(event.target.value)}
                />
              </div>
              <Button type="button" variant="outline" onClick={addAdjustment}>
                Adicionar ajuste
              </Button>
              {adjustments.map((item, index) => (
                <div
                  key={`${item.employment_link_id}-${index}`}
                  className="flex items-center justify-between rounded-lg border p-3 text-sm"
                >
                  <span>
                    {item.nature} · {fmt(item.amount)} · {item.reason}
                  </span>
                  <Button
                    size="icon"
                    variant="ghost"
                    onClick={() =>
                      setAdjustments(
                        adjustments.filter(
                          (_, candidate) => candidate !== index,
                        ),
                      )
                    }
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </div>
              ))}
            </div>
          )}
          <DialogFooter>
            <Button onClick={() => void submit()} disabled={busy}>
              {busy ? "Calculando..." : "Calcular prévia"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1">
      <Label>{label}</Label>
      {children}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border bg-muted/30 p-3">
      <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </p>
      <p className="mt-1 font-mono font-bold">{value}</p>
    </div>
  );
}
