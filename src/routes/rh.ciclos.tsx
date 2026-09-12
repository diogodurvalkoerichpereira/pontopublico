import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  CheckCircle2,
  ClipboardCheck,
  FileLock2,
  History,
  PlayCircle,
  RefreshCw,
  WalletCards,
} from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useAuth } from "@/lib/auth-context";
import { useMfaChallenge } from "@/components/mfa/mfa-challenge";
import {
  getPayrollCycleWorkspace,
  materializePayrollPreview,
  transitionPayrollCycle,
} from "@/lib/payroll-cycle.functions";

export const Route = createFileRoute("/rh/ciclos")({ component: Page });

function Page() {
  const { session, loading, hasTenantPermission } = useAuth();
  const nav = useNavigate();
  useEffect(() => {
    if (loading) return;
    if (!session) nav({ to: "/login" });
    else if (!hasTenantPermission("payroll.cycles.read")) nav({ to: "/app" });
  }, [session, loading, hasTenantPermission, nav]);
  if (!session) return null;
  return <Content />;
}

const statusLabel: Record<string, string> = {
  previa: "Prévia",
  em_conferencia: "Em conferência",
  aprovada: "Aprovada",
  fechada: "Fechada",
  reaberta: "Reaberta",
};

function Content() {
  const { activeTenant } = useAuth();
  const load = useServerFn(getPayrollCycleWorkspace);
  const materialize = useServerFn(materializePayrollPreview);
  const transition = useServerFn(transitionPayrollCycle);
  const { ensure: ensureMfa, dialog: mfaDialog } = useMfaChallenge();
  const qc = useQueryClient();
  const [selectedCycleId, setSelectedCycleId] = useState("");
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewCycleId, setPreviewCycleId] = useState<string | undefined>();
  const [runId, setRunId] = useState("");
  const [reasonOpen, setReasonOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  const { data } = useQuery({
    queryKey: ["payroll-cycles", activeTenant?.id],
    enabled: Boolean(activeTenant),
    queryFn: () => load({ data: { tenant_id: activeTenant!.id } }),
  });
  useEffect(() => {
    if (!selectedCycleId && data?.cycles[0])
      setSelectedCycleId(data.cycles[0].id);
  }, [data, selectedCycleId]);

  const selected = data?.cycles.find((cycle) => cycle.id === selectedCycleId);
  const results = useMemo(
    () =>
      data?.results.filter((item) => item.cycle_id === selectedCycleId) ?? [],
    [data, selectedCycleId],
  );
  const events = useMemo(
    () =>
      data?.events.filter((item) => item.cycle_id === selectedCycleId) ?? [],
    [data, selectedCycleId],
  );
  const availableRuns = useMemo(() => {
    if (previewCycleId) {
      const cycle = data?.cycles.find((item) => item.id === previewCycleId);
      return (
        data?.runs.filter(
          (item) =>
            item.reference_month.slice(0, 7) ===
            cycle?.reference_month.slice(0, 7),
        ) ?? []
      );
    }
    const usedMonths = new Set(
      data?.cycles.map((item) => item.reference_month.slice(0, 7)) ?? [],
    );
    return (
      data?.runs.filter(
        (item) => !usedMonths.has(item.reference_month.slice(0, 7)),
      ) ?? []
    );
  }, [data, previewCycleId]);

  const refresh = () =>
    qc.invalidateQueries({ queryKey: ["payroll-cycles", activeTenant?.id] });
  const fmt = (value: number) =>
    Number(value).toLocaleString("pt-BR", {
      style: "currency",
      currency: "BRL",
    });

  const openPreview = (cycleId?: string) => {
    setPreviewCycleId(cycleId);
    const cycle = data?.cycles.find((item) => item.id === cycleId);
    const candidate = data?.runs.find(
      (item) =>
        !cycle ||
        item.reference_month.slice(0, 7) === cycle.reference_month.slice(0, 7),
    );
    setRunId(candidate?.id ?? "");
    setPreviewOpen(true);
  };

  const submitPreview = async () => {
    if (!activeTenant || !runId) return;
    const run = data?.runs.find((item) => item.id === runId);
    const cycle = data?.cycles.find((item) => item.id === previewCycleId);
    if (!run) return;
    setBusy(true);
    try {
      const result = await materialize({
        data: {
          tenant_id: activeTenant.id,
          reference_month: run.reference_month.slice(0, 7),
          source_run_id: run.id,
          cycle_id: cycle?.id,
          expected_version: cycle?.version,
        },
      });
      await refresh();
      setSelectedCycleId(result.cycleId);
      setPreviewOpen(false);
      toast.success(
        `Prévia v${result.version} gerada para ${result.links} vínculo(s)`,
      );
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Falha ao gerar prévia",
      );
    } finally {
      setBusy(false);
    }
  };

  const act = async (
    action: "review" | "approve" | "close" | "reopen",
    reopenReason?: string,
  ) => {
    if (!activeTenant || !selected) return;
    setBusy(true);
    try {
      // Fechar/reabrir folha exige segundo fator (O0-09): ensure captura o
      // MFA_REQUIRED, faz o challenge e repete a transição.
      await ensureMfa(() =>
        transition({
          data: {
            tenant_id: activeTenant.id,
            cycle_id: selected.id,
            expected_version: selected.version,
            action,
            reason: reopenReason,
          },
        }),
      );
      await refresh();
      setReasonOpen(false);
      setReason("");
      toast.success("Situação da folha atualizada");
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
      {mfaDialog}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <WalletCards className="size-7 text-primary" />
          <div>
            <h1 className="text-2xl font-extrabold">Ciclo mensal da folha</h1>
            <p className="text-sm text-muted-foreground">
              Prévia, conferência, aprovação, fechamento e reabertura com trilha
              completa.
            </p>
          </div>
        </div>
        {data?.permissions.prepare && (
          <Button
            onClick={() => openPreview()}
            disabled={!availableRuns.length}
          >
            <PlayCircle className="mr-1 size-4" /> Nova prévia
          </Button>
        )}
      </div>

      <div className="grid gap-5 xl:grid-cols-[360px_minmax(0,1fr)]">
        <aside className="space-y-2 rounded-2xl border bg-card p-4 shadow-sm">
          <h2 className="mb-3 font-bold">Competências</h2>
          {data?.cycles.map((cycle) => (
            <button
              key={cycle.id}
              onClick={() => setSelectedCycleId(cycle.id)}
              className={`w-full rounded-xl border p-4 text-left hover:bg-muted ${selectedCycleId === cycle.id ? "border-primary bg-primary/5" : ""}`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="font-semibold">
                  {cycle.reference_month.slice(0, 7)}
                </span>
                <Badge
                  variant={cycle.status === "fechada" ? "default" : "secondary"}
                >
                  {statusLabel[cycle.status] ?? cycle.status}
                </Badge>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                versão {cycle.version} · {cycle.links_count} vínculos ·{" "}
                {fmt(cycle.total_net)}
              </p>
            </button>
          ))}
          {!data?.cycles.length && (
            <p className="py-10 text-center text-sm text-muted-foreground">
              Nenhuma competência preparada.
            </p>
          )}
        </aside>

        <div className="space-y-5">
          {selected ? (
            <>
              <div className="rounded-2xl border bg-card p-5 shadow-sm">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h2 className="text-lg font-bold">
                      Competência {selected.reference_month.slice(0, 7)}
                    </h2>
                    <p className="text-xs text-muted-foreground">
                      Versão {selected.version} · origem{" "}
                      {selected.source_run_id?.slice(0, 8)}…
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {selected.status === "previa" &&
                      data?.permissions.prepare && (
                        <Button
                          onClick={() => void act("review")}
                          disabled={busy}
                        >
                          <ClipboardCheck className="mr-1 size-4" /> Enviar à
                          conferência
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
                        <Button
                          onClick={() => void act("close")}
                          disabled={busy}
                        >
                          <FileLock2 className="mr-1 size-4" /> Fechar
                          competência
                        </Button>
                      )}
                    {selected.status === "fechada" &&
                      data?.permissions.reopen && (
                        <Button
                          variant="destructive"
                          onClick={() => setReasonOpen(true)}
                          disabled={busy}
                        >
                          <RefreshCw className="mr-1 size-4" /> Reabrir
                        </Button>
                      )}
                    {selected.status === "reaberta" &&
                      data?.permissions.prepare && (
                        <Button
                          onClick={() => openPreview(selected.id)}
                          disabled={busy}
                        >
                          <RefreshCw className="mr-1 size-4" /> Gerar nova
                          prévia
                        </Button>
                      )}
                  </div>
                </div>
                <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                  <Stat
                    label="Proventos"
                    value={fmt(selected.total_earnings)}
                  />
                  <Stat
                    label="Descontos"
                    value={fmt(selected.total_deductions)}
                  />
                  <Stat label="Líquido" value={fmt(selected.total_net)} />
                  <Stat label="Itens" value={String(selected.items_count)} />
                </div>
                {selected.reopen_reason && (
                  <p className="mt-4 rounded-lg bg-amber-50 p-3 text-sm text-amber-900">
                    Reabertura: {selected.reopen_reason}
                  </p>
                )}
              </div>

              <div className="rounded-2xl border bg-card p-5 shadow-sm">
                <h2 className="mb-4 font-bold">Conferência por vínculo</h2>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="border-b text-left text-xs uppercase text-muted-foreground">
                      <tr>
                        <th className="py-2">Matrícula / servidor</th>
                        <th>Proventos</th>
                        <th>Descontos</th>
                        <th>Líquido</th>
                        <th>Integridade</th>
                      </tr>
                    </thead>
                    <tbody>
                      {results.map((result) => (
                        <tr key={result.id} className="border-b last:border-0">
                          <td className="py-3">
                            <p className="font-medium">{result.full_name}</p>
                            <p className="font-mono text-xs text-muted-foreground">
                              {result.registration_number}
                            </p>
                          </td>
                          <td className="font-mono">{fmt(result.earnings)}</td>
                          <td className="font-mono">
                            {fmt(result.deductions)}
                          </td>
                          <td className="font-mono font-bold">
                            {fmt(result.net_amount)}
                          </td>
                          <td className="font-mono text-[10px] text-muted-foreground">
                            SHA-256 {result.result_checksum.slice(0, 12)}…
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              <div className="rounded-2xl border bg-card p-5 shadow-sm">
                <h2 className="mb-4 flex items-center gap-2 font-bold">
                  <History className="size-4" /> Trilha do ciclo
                </h2>
                <div className="space-y-2">
                  {events.map((item) => (
                    <div
                      key={item.id}
                      className="rounded-xl border p-3 text-sm"
                    >
                      <p className="font-medium">
                        {item.from_status
                          ? `${statusLabel[item.from_status]} → `
                          : ""}
                        {statusLabel[item.to_status] ?? item.to_status}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {new Date(item.occurred_at).toLocaleString("pt-BR")}
                        {item.reason ? ` · ${item.reason}` : ""}
                      </p>
                    </div>
                  ))}
                </div>
              </div>
            </>
          ) : (
            <div className="rounded-2xl border bg-card p-16 text-center text-muted-foreground">
              Selecione uma competência.
            </div>
          )}
        </div>
      </div>

      <Dialog open={previewOpen} onOpenChange={setPreviewOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {previewCycleId
                ? "Nova versão da prévia"
                : "Materializar prévia mensal"}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-2">
            <Label>Simulação concluída</Label>
            <select
              className="h-10 w-full rounded-md border bg-background px-3"
              value={runId}
              onChange={(event) => setRunId(event.target.value)}
            >
              <option value="">Selecione</option>
              {availableRuns.map((run) => (
                <option key={run.id} value={run.id}>
                  {run.reference_month.slice(0, 7)} · {run.links_processed}{" "}
                  vínculos · {run.id.slice(0, 8)}
                </option>
              ))}
            </select>
            <p className="text-xs text-muted-foreground">
              A prévia copia os resultados e a memória da simulação, preservando
              o checksum de cada vínculo.
            </p>
          </div>
          <DialogFooter>
            <Button
              onClick={() => void submitPreview()}
              disabled={!runId || busy}
            >
              {busy ? "Gerando..." : "Gerar prévia"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={reasonOpen} onOpenChange={setReasonOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reabrir competência fechada</DialogTitle>
          </DialogHeader>
          <div className="space-y-2">
            <Label>Justificativa obrigatória</Label>
            <Textarea
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="Explique o motivo e a correção necessária…"
            />
          </div>
          <DialogFooter>
            <Button
              variant="destructive"
              onClick={() => void act("reopen", reason)}
              disabled={reason.trim().length < 10 || busy}
            >
              Confirmar reabertura
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border bg-muted/30 p-3">
      <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </p>
      <p className="mt-1 font-mono text-lg font-bold">{value}</p>
    </div>
  );
}
