import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Calculator, FlaskConical, Plus, ReceiptText } from "lucide-react";
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
import { Textarea } from "@/components/ui/textarea";
import { useAuth } from "@/lib/auth-context";
import {
  getPayrollSimulationRun,
  getPayrollSimulationWorkspace,
  runPayrollSimulation,
  saveEmploymentLinkRubric,
} from "@/lib/payroll-simulation.functions";

export const Route = createFileRoute("/rh/simulacoes")({ component: Page });

function Page() {
  const { session, loading, hasTenantPermission } = useAuth();
  const nav = useNavigate();
  useEffect(() => {
    if (loading) return;
    if (!session) nav({ to: "/login" });
    else if (
      !hasTenantPermission("payroll.assignments.read") &&
      !hasTenantPermission("payroll.simulate")
    )
      nav({ to: "/app" });
  }, [session, loading, hasTenantPermission, nav]);
  if (!session) return null;
  return (
    <AppShell>
      <Content />
    </AppShell>
  );
}

const emptyAssignment = () => ({
  id: undefined as string | undefined,
  rubricId: "",
  from: new Date().toISOString().slice(0, 10),
  to: "",
  fixedAmount: "",
  quantity: "",
  hours: "",
  days: "",
  dependentsIr: "",
  status: "ativo" as "ativo" | "inativo",
  notes: "",
});

function Content() {
  const { activeTenant } = useAuth();
  const loadWorkspace = useServerFn(getPayrollSimulationWorkspace);
  const saveAssignment = useServerFn(saveEmploymentLinkRubric);
  const simulate = useServerFn(runPayrollSimulation);
  const loadRun = useServerFn(getPayrollSimulationRun);
  const qc = useQueryClient();
  const [selectedLinkId, setSelectedLinkId] = useState("");
  const [selectedLinkIds, setSelectedLinkIds] = useState<string[]>([]);
  const [referenceMonth, setReferenceMonth] = useState(
    new Date().toISOString().slice(0, 7),
  );
  const [assignmentOpen, setAssignmentOpen] = useState(false);
  const [assignmentForm, setAssignmentForm] = useState(emptyAssignment());
  const [running, setRunning] = useState(false);
  const [detailRunId, setDetailRunId] = useState("");
  const [detailOpen, setDetailOpen] = useState(false);

  const { data } = useQuery({
    queryKey: ["payroll-simulation-workspace", activeTenant?.id],
    enabled: Boolean(activeTenant),
    queryFn: () => loadWorkspace({ data: { tenant_id: activeTenant!.id } }),
  });
  const { data: detail } = useQuery({
    queryKey: ["payroll-simulation-run", activeTenant?.id, detailRunId],
    enabled: Boolean(activeTenant && detailRunId && detailOpen),
    queryFn: () =>
      loadRun({
        data: { tenant_id: activeTenant!.id, run_id: detailRunId },
      }),
  });

  useEffect(() => {
    if (!selectedLinkId && data?.links[0]) {
      setSelectedLinkId(data.links[0].id);
      setSelectedLinkIds([data.links[0].id]);
    }
  }, [data, selectedLinkId]);

  const selectedLink = data?.links.find((link) => link.id === selectedLinkId);
  const assignments = useMemo(
    () =>
      data?.assignments.filter(
        (item) => item.employment_link_id === selectedLinkId,
      ) ?? [],
    [data, selectedLinkId],
  );
  const refresh = () =>
    qc.invalidateQueries({
      queryKey: ["payroll-simulation-workspace", activeTenant?.id],
    });

  const openAssignment = (
    item?: NonNullable<typeof data>["assignments"][number],
  ) => {
    if (!item) {
      setAssignmentForm({
        ...emptyAssignment(),
        rubricId: data?.rubrics[0]?.id ?? "",
      });
    } else {
      setAssignmentForm({
        id: item.id,
        rubricId: item.rubric_id,
        from: item.valid_from,
        to: item.valid_to ?? "",
        fixedAmount: item.fixed_amount == null ? "" : String(item.fixed_amount),
        quantity: item.quantity == null ? "" : String(item.quantity),
        hours:
          item.parameters?.hours == null ? "" : String(item.parameters.hours),
        days: item.parameters?.days == null ? "" : String(item.parameters.days),
        dependentsIr:
          item.parameters?.dependents_ir == null
            ? ""
            : String(item.parameters.dependents_ir),
        status: item.status,
        notes: item.notes ?? "",
      });
    }
    setAssignmentOpen(true);
  };

  const submitAssignment = async () => {
    if (!activeTenant || !selectedLinkId) return;
    const parameters: Record<string, number> = {};
    if (assignmentForm.hours !== "")
      parameters.hours = Number(assignmentForm.hours);
    if (assignmentForm.days !== "")
      parameters.days = Number(assignmentForm.days);
    if (assignmentForm.dependentsIr !== "")
      parameters.dependents_ir = Number(assignmentForm.dependentsIr);
    try {
      await saveAssignment({
        data: {
          id: assignmentForm.id,
          tenant_id: activeTenant.id,
          employment_link_id: selectedLinkId,
          rubric_id: assignmentForm.rubricId,
          valid_from: assignmentForm.from,
          valid_to: assignmentForm.to || null,
          fixed_amount:
            assignmentForm.fixedAmount === ""
              ? null
              : Number(assignmentForm.fixedAmount),
          quantity:
            assignmentForm.quantity === ""
              ? null
              : Number(assignmentForm.quantity),
          parameters,
          status: assignmentForm.status,
          notes: assignmentForm.notes || null,
        },
      });
      await refresh();
      setAssignmentOpen(false);
      toast.success("Rubrica fixa salva");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Falha ao salvar");
    }
  };

  const runSimulation = async () => {
    if (!activeTenant || !selectedLinkIds.length) return;
    setRunning(true);
    try {
      const result = await simulate({
        data: {
          tenant_id: activeTenant.id,
          reference_month: referenceMonth,
          employment_link_ids: selectedLinkIds,
        },
      });
      await refresh();
      setDetailRunId(result.runId);
      setDetailOpen(true);
      toast.success(
        `${result.itemsCalculated} rubricas calculadas em ${result.linksProcessed} vínculo(s)`,
      );
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Falha na simulação",
      );
    } finally {
      setRunning(false);
    }
  };

  const fmt = (value: number) =>
    Number(value).toLocaleString("pt-BR", {
      style: "currency",
      currency: "BRL",
    });

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
          <FlaskConical className="size-7 text-primary" />
          <div>
            <h1 className="text-2xl font-extrabold">Eventos e simulação</h1>
            <p className="text-sm text-muted-foreground">
              Rubricas fixas por vínculo e cálculo reproduzível, sem fechar
              folha.
            </p>
          </div>
        </div>
        {data?.canSimulate && (
          <div className="flex items-end gap-2 rounded-xl border bg-card p-3">
            <div className="space-y-1">
              <Label className="text-xs">Competência</Label>
              <Input
                type="month"
                value={referenceMonth}
                onChange={(event) => setReferenceMonth(event.target.value)}
                className="w-40"
              />
            </div>
            <Button
              onClick={() => void runSimulation()}
              disabled={running || !selectedLinkIds.length}
            >
              <Calculator className="mr-1 size-4" />
              {running ? "Calculando..." : "Simular seleção"}
            </Button>
          </div>
        )}
      </div>

      <div className="grid gap-5 xl:grid-cols-[340px_minmax(0,1fr)]">
        <aside className="rounded-2xl border bg-card p-4 shadow-sm">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="font-bold">Vínculos</h2>
            <span className="text-xs text-muted-foreground">
              {selectedLinkIds.length} selecionado(s)
            </span>
          </div>
          <div className="space-y-2">
            {data?.links.map((link) => (
              <div
                key={link.id}
                className={`flex items-start gap-3 rounded-xl border p-3 ${selectedLinkId === link.id ? "border-primary bg-primary/5" : ""}`}
              >
                <Checkbox
                  checked={selectedLinkIds.includes(link.id)}
                  onCheckedChange={(checked) =>
                    setSelectedLinkIds(
                      checked
                        ? [...new Set([...selectedLinkIds, link.id])]
                        : selectedLinkIds.filter((id) => id !== link.id),
                    )
                  }
                />
                <button
                  className="min-w-0 flex-1 text-left"
                  onClick={() => setSelectedLinkId(link.id)}
                >
                  <p className="truncate text-sm font-semibold">
                    {link.full_name}
                  </p>
                  <p className="font-mono text-[11px] text-muted-foreground">
                    {link.registration_number} ·{" "}
                    {fmt(Number(link.base_salary ?? 0))}
                  </p>
                </button>
              </div>
            ))}
          </div>
        </aside>

        <div className="space-y-5">
          <div className="rounded-2xl border bg-card p-5 shadow-sm">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
              <div>
                <h2 className="flex items-center gap-2 font-bold">
                  <ReceiptText className="size-4" /> Rubricas fixas
                </h2>
                <p className="text-xs text-muted-foreground">
                  {selectedLink?.full_name || "Selecione um vínculo"}
                </p>
              </div>
              {data?.canManageAssignments && selectedLink && (
                <Button size="sm" onClick={() => openAssignment()}>
                  <Plus className="mr-1 size-3" /> Nova atribuição
                </Button>
              )}
            </div>
            <div className="space-y-2">
              {assignments.map((item) => {
                const rubric = data?.rubrics.find(
                  (candidate) => candidate.id === item.rubric_id,
                );
                return (
                  <button
                    key={item.id}
                    className="w-full rounded-xl border p-4 text-left hover:bg-muted"
                    onClick={() =>
                      data?.canManageAssignments && openAssignment(item)
                    }
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-semibold">
                        {rubric?.code || "?"} · {rubric?.name || "Rubrica"}
                      </span>
                      <Badge
                        variant={
                          item.status === "ativo" ? "default" : "secondary"
                        }
                      >
                        {item.status}
                      </Badge>
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {item.valid_from} até {item.valid_to || "sem término"} ·
                      valor {fmt(Number(item.fixed_amount ?? 0))} · quantidade{" "}
                      {Number(item.quantity ?? 0)}
                    </p>
                  </button>
                );
              })}
              {!assignments.length && (
                <p className="py-8 text-center text-sm text-muted-foreground">
                  Nenhuma rubrica fixa atribuída a este vínculo.
                </p>
              )}
            </div>
          </div>

          <div className="rounded-2xl border bg-card p-5 shadow-sm">
            <h2 className="mb-4 font-bold">Simulações recentes</h2>
            <div className="space-y-2">
              {data?.runs.map((run) => (
                <button
                  key={run.id}
                  className="flex w-full flex-wrap items-center justify-between gap-2 rounded-xl border p-4 text-left hover:bg-muted"
                  onClick={() => {
                    setDetailRunId(run.id);
                    setDetailOpen(true);
                  }}
                >
                  <div>
                    <p className="font-semibold">
                      Competência {run.reference_month.slice(0, 7)}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {run.links_processed}/{run.links_requested} vínculos ·
                      motor {run.engine_version}
                    </p>
                  </div>
                  <Badge
                    variant={
                      run.status === "concluida" ? "default" : "secondary"
                    }
                  >
                    {run.status}
                  </Badge>
                </button>
              ))}
              {!data?.runs.length && (
                <p className="py-8 text-center text-sm text-muted-foreground">
                  Nenhuma simulação executada.
                </p>
              )}
            </div>
          </div>
        </div>
      </div>

      <Dialog open={assignmentOpen} onOpenChange={setAssignmentOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Rubrica fixa de {selectedLink?.full_name}</DialogTitle>
          </DialogHeader>
          <div className="grid gap-4 md:grid-cols-2">
            <Field label="Rubrica">
              <select
                className="h-9 w-full rounded-md border bg-background px-3"
                value={assignmentForm.rubricId}
                onChange={(event) =>
                  setAssignmentForm({
                    ...assignmentForm,
                    rubricId: event.target.value,
                  })
                }
              >
                {data?.rubrics.map((rubric) => (
                  <option key={rubric.id} value={rubric.id}>
                    {rubric.code} · {rubric.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Situação">
              <select
                className="h-9 w-full rounded-md border bg-background px-3"
                value={assignmentForm.status}
                onChange={(event) =>
                  setAssignmentForm({
                    ...assignmentForm,
                    status: event.target.value as "ativo" | "inativo",
                  })
                }
              >
                <option value="ativo">ativo</option>
                <option value="inativo">inativo</option>
              </select>
            </Field>
            <InputField
              label="Início *"
              type="date"
              value={assignmentForm.from}
              set={(from) => setAssignmentForm({ ...assignmentForm, from })}
            />
            <InputField
              label="Fim"
              type="date"
              value={assignmentForm.to}
              set={(to) => setAssignmentForm({ ...assignmentForm, to })}
            />
            <InputField
              label="Valor fixo"
              type="number"
              value={assignmentForm.fixedAmount}
              set={(fixedAmount) =>
                setAssignmentForm({ ...assignmentForm, fixedAmount })
              }
            />
            <InputField
              label="Quantidade"
              type="number"
              value={assignmentForm.quantity}
              set={(quantity) =>
                setAssignmentForm({ ...assignmentForm, quantity })
              }
            />
            <InputField
              label="Horas (parâmetro)"
              type="number"
              value={assignmentForm.hours}
              set={(hours) => setAssignmentForm({ ...assignmentForm, hours })}
            />
            <InputField
              label="Dias (parâmetro)"
              type="number"
              value={assignmentForm.days}
              set={(days) => setAssignmentForm({ ...assignmentForm, days })}
            />
            <InputField
              label="Dependentes IR"
              type="number"
              value={assignmentForm.dependentsIr}
              set={(dependentsIr) =>
                setAssignmentForm({ ...assignmentForm, dependentsIr })
              }
            />
          </div>
          <Field label="Notas">
            <Textarea
              value={assignmentForm.notes}
              onChange={(event) =>
                setAssignmentForm({
                  ...assignmentForm,
                  notes: event.target.value,
                })
              }
            />
          </Field>
          <DialogFooter>
            <Button onClick={() => void submitAssignment()}>
              Salvar atribuição
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={detailOpen} onOpenChange={setDetailOpen}>
        <DialogContent className="max-h-[90vh] max-w-4xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Memória de cálculo da simulação</DialogTitle>
          </DialogHeader>
          {detail && (
            <div className="space-y-4">
              <div className="grid gap-3 rounded-xl border bg-muted/30 p-4 md:grid-cols-4">
                <Stat
                  label="Competência"
                  value={String(detail.run.reference_month).slice(0, 7)}
                />
                <Stat label="Situação" value={String(detail.run.status)} />
                <Stat label="Motor" value={String(detail.run.engine_version)} />
                <Stat
                  label="Vínculos"
                  value={`${detail.run.links_processed}/${detail.run.links_requested}`}
                />
              </div>
              {detail.items.map((item) => {
                const memory = item.memory as Record<string, unknown>;
                const operations = Array.isArray(memory.operations)
                  ? (memory.operations as Array<Record<string, unknown>>)
                  : [];
                return (
                  <details key={item.id} className="rounded-xl border p-4">
                    <summary className="cursor-pointer list-none">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div>
                          <p className="font-semibold">
                            {item.rubric_code} · {item.rubric_name}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            {item.full_name} · {item.registration_number} ·
                            sequência {item.sequence}
                          </p>
                        </div>
                        <span className="font-mono font-bold text-primary">
                          {fmt(Number(item.amount))}
                        </span>
                      </div>
                    </summary>
                    <div className="mt-4 space-y-3 border-t pt-4 text-xs">
                      <div className="grid gap-2 md:grid-cols-3">
                        <Stat
                          label="Base"
                          value={fmt(Number(item.calculation_base))}
                        />
                        <Stat
                          label="Valor bruto"
                          value={String(memory.raw_value ?? "-")}
                        />
                        <Stat
                          label="Valor final"
                          value={fmt(Number(memory.final_value ?? item.amount))}
                        />
                      </div>
                      <div>
                        <p className="mb-2 font-semibold">
                          Operações reproduzíveis
                        </p>
                        <div className="space-y-1 font-mono">
                          {operations.map((operation, index) => (
                            <div
                              key={`${item.id}-${index}`}
                              className="rounded bg-muted px-2 py-1"
                            >
                              {String(operation.path)} ·{" "}
                              {String(operation.label)} ={" "}
                              {String(operation.value)}
                            </div>
                          ))}
                        </div>
                      </div>
                      <p className="break-all font-mono text-[10px] text-muted-foreground">
                        SHA-256: {String(memory.formula_checksum ?? "")}
                      </p>
                    </div>
                  </details>
                );
              })}
              {!detail.items.length && (
                <p className="py-8 text-center text-sm text-muted-foreground">
                  A simulação não produziu itens. Verifique as atribuições e as
                  versões publicadas.
                </p>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </section>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="space-y-1">
      <Label>{label}</Label>
      {children}
    </div>
  );
}

function InputField({
  label,
  value,
  set,
  type = "text",
}: {
  label: string;
  value: string;
  set: (value: string) => void;
  type?: string;
}) {
  return (
    <Field label={label}>
      <Input
        type={type}
        step={type === "number" ? "0.000001" : undefined}
        value={value}
        onChange={(event) => set(event.target.value)}
      />
    </Field>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </p>
      <p className="font-mono text-sm">{value}</p>
    </div>
  );
}
