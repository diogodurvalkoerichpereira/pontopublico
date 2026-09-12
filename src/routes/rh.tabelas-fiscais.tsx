import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Landmark, Plus, Trash2 } from "lucide-react";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuth } from "@/lib/auth-context";
import {
  getFiscalTables,
  saveFiscalTable,
  saveFiscalTableVersion,
} from "@/lib/fiscal-tables.functions";

export const Route = createFileRoute("/rh/tabelas-fiscais")({
  component: Page,
});

function Page() {
  const { session, loading, hasTenantPermission } = useAuth();
  const nav = useNavigate();
  useEffect(() => {
    if (loading) return;
    if (!session) nav({ to: "/login" });
    else if (!hasTenantPermission("fiscal.read")) nav({ to: "/app" });
  }, [session, loading, hasTenantPermission, nav]);
  if (!session) return null;
  return <Content />;
}

type BracketRow = { ate: string; aliquotaPct: string; deduzir: string };

const emptyBracket = (): BracketRow => ({
  ate: "",
  aliquotaPct: "",
  deduzir: "",
});

function Content() {
  const { activeTenant } = useAuth();
  const load = useServerFn(getFiscalTables);
  const saveTable = useServerFn(saveFiscalTable);
  const saveVersion = useServerFn(saveFiscalTableVersion);
  const qc = useQueryClient();

  const [tableOpen, setTableOpen] = useState(false);
  const [versionOpen, setVersionOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const [editTableId, setEditTableId] = useState<string | undefined>();
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [tableStatus, setTableStatus] = useState<"ativo" | "inativo">("ativo");
  const [description, setDescription] = useState("");

  const [versionTableId, setVersionTableId] = useState("");
  const [validFrom, setValidFrom] = useState("");
  const [validTo, setValidTo] = useState("");
  const [versionStatus, setVersionStatus] = useState<"rascunho" | "publicada">(
    "rascunho",
  );
  const [brackets, setBrackets] = useState<BracketRow[]>([emptyBracket()]);

  const { data } = useQuery({
    queryKey: ["fiscal-tables", activeTenant?.id],
    enabled: Boolean(activeTenant),
    queryFn: () => load({ data: { tenant_id: activeTenant!.id } }),
  });

  const versionsByTable = useMemo(() => {
    const map = new Map<string, NonNullable<typeof data>["versions"]>();
    for (const version of data?.versions ?? []) {
      if (!map.has(version.fiscal_table_id))
        map.set(version.fiscal_table_id, []);
      map.get(version.fiscal_table_id)!.push(version);
    }
    return map;
  }, [data]);

  const canManage = data?.canManage ?? false;
  const refresh = () =>
    qc.invalidateQueries({ queryKey: ["fiscal-tables", activeTenant?.id] });

  const openNewTable = () => {
    setEditTableId(undefined);
    setCode("");
    setName("");
    setTableStatus("ativo");
    setDescription("");
    setTableOpen(true);
  };

  const submitTable = async () => {
    if (!activeTenant) return;
    setBusy(true);
    try {
      await saveTable({
        data: {
          id: editTableId,
          tenant_id: activeTenant.id,
          code: code.trim().toUpperCase(),
          name: name.trim(),
          status: tableStatus,
          description: description.trim() || null,
        },
      });
      toast.success("Tabela salva");
      setTableOpen(false);
      refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Falha ao salvar");
    } finally {
      setBusy(false);
    }
  };

  const openNewVersion = (tableId: string) => {
    setVersionTableId(tableId);
    setValidFrom("");
    setValidTo("");
    setVersionStatus("rascunho");
    setBrackets([emptyBracket()]);
    setVersionOpen(true);
  };

  const submitVersion = async () => {
    if (!activeTenant) return;
    const parsed = brackets
      .filter((b) => b.ate !== "" || b.aliquotaPct !== "")
      .map((b) => ({
        ate: Number(b.ate),
        aliquota: Number(b.aliquotaPct) / 100,
        ...(b.deduzir !== "" ? { deduzir: Number(b.deduzir) } : {}),
      }));
    if (!parsed.length) {
      toast.error("Informe ao menos uma faixa");
      return;
    }
    setBusy(true);
    try {
      await saveVersion({
        data: {
          tenant_id: activeTenant.id,
          fiscal_table_id: versionTableId,
          valid_from: validFrom,
          valid_to: validTo || null,
          status: versionStatus,
          brackets: parsed,
        },
      });
      toast.success("Versão salva");
      setVersionOpen(false);
      refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Falha ao salvar");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="space-y-6">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3">
          <Landmark className="size-6 text-primary" />
          <div>
            <h1 className="text-2xl font-extrabold tracking-tight">
              Tabelas fiscais
            </h1>
            <p className="text-sm text-muted-foreground">
              Faixas de INSS/IRRF/RPPS por vigência. As nacionais são somente
              leitura; as do ente você versiona aqui (checksum na memória de
              cálculo).
            </p>
          </div>
        </div>
        {canManage && (
          <Button onClick={openNewTable}>
            <Plus className="size-4" /> Nova tabela do ente
          </Button>
        )}
      </div>

      <div className="space-y-3">
        {(data?.tables ?? []).map((table) => {
          const nacional = table.tenant_id === null;
          const versions = versionsByTable.get(table.id) ?? [];
          return (
            <div key={table.id} className="rounded-lg border bg-card">
              <div className="flex items-center justify-between gap-3 border-b px-4 py-3">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-sm font-bold">
                    {table.code}
                  </span>
                  <span className="text-sm text-muted-foreground">
                    {table.name}
                  </span>
                  {nacional ? (
                    <Badge variant="outline">nacional</Badge>
                  ) : (
                    <Badge variant="secondary">do ente</Badge>
                  )}
                  {table.status === "inativo" && (
                    <Badge variant="outline">inativo</Badge>
                  )}
                </div>
                {canManage && !nacional && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => openNewVersion(table.id)}
                  >
                    <Plus className="size-4" /> Nova versão
                  </Button>
                )}
              </div>
              <div className="divide-y">
                {versions.map((version) => (
                  <div
                    key={version.id}
                    className="flex items-center justify-between gap-3 px-4 py-2 text-sm"
                  >
                    <div className="flex items-center gap-2">
                      <Badge variant="outline">v{version.version_number}</Badge>
                      <span>
                        {version.valid_from}
                        {version.valid_to ? ` → ${version.valid_to}` : " → ∞"}
                      </span>
                      <Badge
                        variant={
                          version.status === "publicada"
                            ? "default"
                            : "secondary"
                        }
                      >
                        {version.status}
                      </Badge>
                      <span className="text-muted-foreground">
                        {version.brackets.length} faixa(s)
                      </span>
                    </div>
                    <span
                      className="font-mono text-[10px] text-muted-foreground"
                      title="checksum"
                    >
                      {version.checksum.slice(0, 12)}
                    </span>
                  </div>
                ))}
                {!versions.length && (
                  <div className="px-4 py-3 text-sm text-muted-foreground">
                    Sem versões.
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <Dialog open={tableOpen} onOpenChange={setTableOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Nova tabela do ente</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label>Código</Label>
                <Input
                  value={code}
                  onChange={(e) => setCode(e.target.value.toUpperCase())}
                  placeholder="RPPS_MUNICIPAL"
                />
              </div>
              <div className="space-y-1">
                <Label>Situação</Label>
                <select
                  className="h-9 w-full rounded-md border bg-background px-3 text-sm"
                  value={tableStatus}
                  onChange={(e) =>
                    setTableStatus(e.target.value as "ativo" | "inativo")
                  }
                >
                  <option value="ativo">Ativo</option>
                  <option value="inativo">Inativo</option>
                </select>
              </div>
            </div>
            <div className="space-y-1">
              <Label>Nome</Label>
              <Input value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label>Descrição (opcional)</Label>
              <Input
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setTableOpen(false)}>
              Cancelar
            </Button>
            <Button onClick={submitTable} disabled={busy}>
              Salvar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={versionOpen} onOpenChange={setVersionOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Nova versão de tabela fiscal</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="grid grid-cols-3 gap-3">
              <div className="space-y-1">
                <Label>Vigência de</Label>
                <Input
                  type="date"
                  value={validFrom}
                  onChange={(e) => setValidFrom(e.target.value)}
                />
              </div>
              <div className="space-y-1">
                <Label>até (opcional)</Label>
                <Input
                  type="date"
                  value={validTo}
                  onChange={(e) => setValidTo(e.target.value)}
                />
              </div>
              <div className="space-y-1">
                <Label>Situação</Label>
                <select
                  className="h-9 w-full rounded-md border bg-background px-3 text-sm"
                  value={versionStatus}
                  onChange={(e) =>
                    setVersionStatus(e.target.value as "rascunho" | "publicada")
                  }
                >
                  <option value="rascunho">Rascunho</option>
                  <option value="publicada">Publicada</option>
                </select>
              </div>
            </div>
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label>Faixas (`até` crescente; alíquota em %)</Label>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setBrackets([...brackets, emptyBracket()])}
                >
                  <Plus className="size-4" /> Faixa
                </Button>
              </div>
              <div className="space-y-2">
                {brackets.map((bracket, index) => (
                  <div
                    key={index}
                    className="grid grid-cols-[1fr_1fr_1fr_auto] gap-2"
                  >
                    <Input
                      type="number"
                      placeholder="até (R$)"
                      value={bracket.ate}
                      onChange={(e) =>
                        setBrackets(
                          brackets.map((b, i) =>
                            i === index ? { ...b, ate: e.target.value } : b,
                          ),
                        )
                      }
                    />
                    <Input
                      type="number"
                      placeholder="alíquota %"
                      value={bracket.aliquotaPct}
                      onChange={(e) =>
                        setBrackets(
                          brackets.map((b, i) =>
                            i === index
                              ? { ...b, aliquotaPct: e.target.value }
                              : b,
                          ),
                        )
                      }
                    />
                    <Input
                      type="number"
                      placeholder="deduzir (R$)"
                      value={bracket.deduzir}
                      onChange={(e) =>
                        setBrackets(
                          brackets.map((b, i) =>
                            i === index ? { ...b, deduzir: e.target.value } : b,
                          ),
                        )
                      }
                    />
                    <Button
                      size="icon"
                      variant="ghost"
                      onClick={() =>
                        setBrackets(
                          brackets.length > 1
                            ? brackets.filter((_, i) => i !== index)
                            : brackets,
                        )
                      }
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </div>
                ))}
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setVersionOpen(false)}>
              Cancelar
            </Button>
            <Button onClick={submitVersion} disabled={busy}>
              Salvar versão
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
