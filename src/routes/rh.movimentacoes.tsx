import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { ArrowRightLeft, FileCheck2, Plus } from "lucide-react";
import { toast } from "sonner";
import { AppShell } from "@/components/AppShell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
  getMovementWorkspace,
  saveEmploymentMovement,
} from "@/lib/movement.functions";

export const Route = createFileRoute("/rh/movimentacoes")({ component: Page });

function Page() {
  const { session, loading, hasTenantPermission } = useAuth();
  const nav = useNavigate();
  useEffect(() => {
    if (loading) return;
    if (!session) nav({ to: "/login" });
    else if (!hasTenantPermission("movements.read")) nav({ to: "/app" });
  }, [session, loading, hasTenantPermission, nav]);
  if (!session) return null;
  return (
    <AppShell>
      <Content />
    </AppShell>
  );
}

type MovementType =
  | "admissao"
  | "lotacao"
  | "afastamento"
  | "cessao"
  | "retorno"
  | "desligamento";

function Content() {
  const { activeTenant } = useAuth();
  const loadWorkspace = useServerFn(getMovementWorkspace);
  const persist = useServerFn(saveEmploymentMovement);
  const qc = useQueryClient();
  const [linkId, setLinkId] = useState("");
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({
    type: "lotacao" as MovementType,
    date: new Date().toISOString().slice(0, 10),
    unitId: "",
    status: "",
    legalBasis: "",
    notes: "",
    document: null as { name: string; base64: string } | null,
  });
  const { data } = useQuery({
    queryKey: ["movement-workspace", activeTenant?.id],
    enabled: Boolean(activeTenant),
    queryFn: () => loadWorkspace({ data: { tenant_id: activeTenant!.id } }),
  });
  useEffect(() => {
    if (!linkId && data?.links[0]) setLinkId(data.links[0].id);
  }, [data, linkId]);
  const link = data?.links.find((item) => item.id === linkId);
  const movements = useMemo(
    () =>
      data?.movements.filter((item) => item.employment_link_id === linkId) ??
      [],
    [data, linkId],
  );

  const readDocument = async (file?: File) => {
    if (!file) return setForm({ ...form, document: null });
    const base64 = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
    setForm({ ...form, document: { name: file.name, base64 } });
  };
  const submit = async () => {
    if (!activeTenant || !linkId) return;
    try {
      const result = await persist({
        data: {
          tenant_id: activeTenant.id,
          employment_link_id: linkId,
          movement_type: form.type,
          effective_date: form.date,
          to_unit_id: form.type === "lotacao" ? form.unitId || null : null,
          to_status: form.status
            ? (form.status as
                "rascunho" | "ativo" | "afastado" | "ferias" | "desligado")
            : null,
          legal_basis: form.legalBasis,
          notes: form.notes || null,
          document: form.document,
        },
      });
      await qc.invalidateQueries({
        queryKey: ["movement-workspace", activeTenant.id],
      });
      setOpen(false);
      toast.success(
        result.applied
          ? "Movimentação registrada e aplicada"
          : "Movimentação futura agendada",
      );
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Falha ao registrar",
      );
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
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex items-center gap-3">
          <ArrowRightLeft className="size-7 text-primary" />
          <div>
            <h1 className="text-2xl font-extrabold">
              Movimentações funcionais
            </h1>
            <p className="text-sm text-muted-foreground">
              Histórico imutável de lotação, situação e base legal.
            </p>
          </div>
        </div>
        {data?.canManage && (
          <Button onClick={() => setOpen(true)} disabled={!linkId}>
            <Plus className="mr-1 size-4" />
            Nova movimentação
          </Button>
        )}
      </div>
      <div className="rounded-2xl border bg-card p-4 shadow-sm">
        <Label>Vínculo</Label>
        <select
          className="mt-1 h-10 w-full rounded-md border bg-background px-3"
          value={linkId}
          onChange={(e) => setLinkId(e.target.value)}
        >
          <option value="">Selecione</option>
          {data?.links.map((item) => (
            <option key={item.id} value={item.id}>
              {item.full_name} · #{item.registration_number} ·{" "}
              {item.unit_name || "sem lotação"}
            </option>
          ))}
        </select>
        {link && (
          <p className="mt-2 text-xs text-muted-foreground">
            Situação atual: {link.status} · lotação:{" "}
            {link.unit_name || "não informada"}
          </p>
        )}
      </div>
      <div className="relative space-y-3 border-l-2 border-primary/30 pl-6">
        {movements.map((movement) => (
          <article
            key={movement.id}
            className="relative rounded-2xl border bg-card p-4 shadow-sm before:absolute before:-left-[31px] before:top-5 before:size-3 before:rounded-full before:bg-primary"
          >
            <div className="flex flex-wrap justify-between gap-2">
              <div>
                <h2 className="font-bold capitalize">
                  {movement.movement_type}
                </h2>
                <p className="text-xs text-muted-foreground">
                  Efeito em {movement.effective_date} · criado em{" "}
                  {new Date(movement.created_at).toLocaleString("pt-BR")}
                </p>
              </div>
              <Badge variant={movement.applied_at ? "default" : "secondary"}>
                {movement.applied_at ? "aplicada" : "futura"}
              </Badge>
            </div>
            <p className="mt-3 text-sm">
              {movement.from_unit_name || movement.from_status || "—"} →{" "}
              {movement.to_unit_name || movement.to_status || "—"}
            </p>
            <p className="mt-1 text-xs">Base legal: {movement.legal_basis}</p>
            {movement.document_sha256 && (
              <p className="mt-2 flex items-center gap-1 break-all font-mono text-[10px] text-muted-foreground">
                <FileCheck2 className="size-3" />
                SHA-256 {movement.document_sha256}
              </p>
            )}
          </article>
        ))}
        {!movements.length && (
          <p className="py-10 text-center text-muted-foreground">
            Nenhuma movimentação para este vínculo.
          </p>
        )}
      </div>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Registrar movimentação</DialogTitle>
          </DialogHeader>
          <div className="grid gap-4 md:grid-cols-2">
            <Select
              label="Tipo"
              value={form.type}
              set={(type) => setForm({ ...form, type: type as MovementType })}
              options={[
                "admissao",
                "lotacao",
                "afastamento",
                "cessao",
                "retorno",
                "desligamento",
              ]}
            />
            <Field
              label="Data de efeito"
              type="date"
              value={form.date}
              set={(date) => setForm({ ...form, date })}
            />
            {form.type === "lotacao" && (
              <div className="space-y-1">
                <Label>Nova lotação *</Label>
                <select
                  className="h-9 w-full rounded-md border bg-background px-3"
                  value={form.unitId}
                  onChange={(e) => setForm({ ...form, unitId: e.target.value })}
                >
                  <option value="">Selecione</option>
                  {data?.units.map((unit) => (
                    <option key={unit.id} value={unit.id}>
                      {unit.codigo} · {unit.nome}
                    </option>
                  ))}
                </select>
              </div>
            )}
            <Select
              label="Situação resultante"
              value={form.status}
              set={(status) => setForm({ ...form, status })}
              options={[
                "",
                "rascunho",
                "ativo",
                "afastado",
                "ferias",
                "desligado",
              ]}
            />
            <Field
              label="Base legal *"
              value={form.legalBasis}
              set={(legalBasis) => setForm({ ...form, legalBasis })}
            />
            <div className="space-y-1">
              <Label>Documento comprobatório</Label>
              <Input
                type="file"
                onChange={(e) => void readDocument(e.target.files?.[0])}
              />
            </div>
          </div>
          <div className="space-y-1">
            <Label>Observações</Label>
            <Textarea
              value={form.notes}
              onChange={(e) => setForm({ ...form, notes: e.target.value })}
            />
          </div>
          <DialogFooter>
            <Button onClick={() => void submit()}>Registrar</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}

function Field({
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
    <div className="space-y-1">
      <Label>{label}</Label>
      <Input type={type} value={value} onChange={(e) => set(e.target.value)} />
    </div>
  );
}
function Select({
  label,
  value,
  set,
  options,
}: {
  label: string;
  value: string;
  set: (value: string) => void;
  options: string[];
}) {
  return (
    <div className="space-y-1">
      <Label>{label}</Label>
      <select
        className="h-9 w-full rounded-md border bg-background px-3 capitalize"
        value={value}
        onChange={(e) => set(e.target.value)}
      >
        {options.map((option) => (
          <option key={option || "auto"} value={option}>
            {option || "Automática"}
          </option>
        ))}
      </select>
    </div>
  );
}
