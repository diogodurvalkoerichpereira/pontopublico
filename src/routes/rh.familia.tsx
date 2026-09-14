import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Baby, Banknote, Plus, UsersRound } from "lucide-react";
import { toast } from "sonner";
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
import {
  getFamilyWorkspace,
  saveDependent,
  savePensionBeneficiary,
  getValidDependents,
  getPensionAllocation,
} from "@/lib/family.functions";
import { getPeopleRegistry } from "@/lib/people.functions";

export const Route = createFileRoute("/rh/familia")({ component: Page });

function Page() {
  const { session, loading, hasTenantPermission } = useAuth();
  const nav = useNavigate();
  useEffect(() => {
    if (loading) return;
    if (!session) nav({ to: "/login" });
    else if (!hasTenantPermission("family.read")) nav({ to: "/app" });
  }, [session, loading, hasTenantPermission, nav]);
  if (!session) return null;
  return (
    <>
      <Content />
    </>
  );
}

const today = () => new Date().toISOString().slice(0, 10);

function Content() {
  const { activeTenant } = useAuth();
  const listPeople = useServerFn(getPeopleRegistry);
  const loadFamily = useServerFn(getFamilyWorkspace);
  const persistDependent = useServerFn(saveDependent);
  const persistPension = useServerFn(savePensionBeneficiary);
  const qc = useQueryClient();
  const [personId, setPersonId] = useState("");
  const [dependentOpen, setDependentOpen] = useState(false);
  const [pensionOpen, setPensionOpen] = useState(false);
  const [dependent, setDependent] = useState({
    name: "",
    cpf: "",
    birth: "",
    relationship: "",
    ir: true,
    socialSecurity: false,
    from: today(),
    to: "",
  });
  const [pension, setPension] = useState({
    linkId: "",
    name: "",
    cpf: "",
    type: "percentual" as "percentual" | "valor_fixo",
    value: "",
    priority: "1",
    from: today(),
    to: "",
    legalBasis: "",
  });

  const { data: registry } = useQuery({
    queryKey: ["family-people", activeTenant?.id],
    enabled: Boolean(activeTenant),
    queryFn: () =>
      listPeople({
        data: { tenant_id: activeTenant!.id, search: "", status: "todos" },
      }),
  });
  useEffect(() => {
    if (!personId && registry?.people[0]) setPersonId(registry.people[0].id);
  }, [registry, personId]);
  const { data } = useQuery({
    queryKey: ["family-workspace", activeTenant?.id, personId],
    enabled: Boolean(activeTenant && personId),
    queryFn: () =>
      loadFamily({
        data: { tenant_id: activeTenant!.id, holder_person_id: personId },
      }),
  });
  const loadValid = useServerFn(getValidDependents);
  const { data: valid } = useQuery({
    queryKey: ["valid-dependents", activeTenant?.id, personId],
    enabled: Boolean(activeTenant && personId),
    queryFn: () =>
      loadValid({
        data: {
          tenant_id: activeTenant!.id,
          holder_person_id: personId,
          data_referencia: new Date().toISOString().slice(0, 10),
        },
      }),
  });

  const pensionLinkId = data?.pensions[0]?.employment_link_id ?? "";
  const loadAllocation = useServerFn(getPensionAllocation);
  const { data: allocation } = useQuery({
    queryKey: ["pension-allocation", activeTenant?.id, personId, pensionLinkId],
    enabled: Boolean(activeTenant && personId && pensionLinkId),
    queryFn: () =>
      loadAllocation({
        data: {
          tenant_id: activeTenant!.id,
          holder_person_id: personId,
          employment_link_id: pensionLinkId,
          data_referencia: new Date().toISOString().slice(0, 10),
        },
      }),
  });

  const refresh = () => {
    qc.invalidateQueries({
      queryKey: ["family-workspace", activeTenant?.id, personId],
    });
    qc.invalidateQueries({
      queryKey: ["valid-dependents", activeTenant?.id, personId],
    });
    qc.invalidateQueries({
      queryKey: ["pension-allocation", activeTenant?.id, personId],
    });
  };
  const submitDependent = async () => {
    if (!activeTenant || !personId) return;
    try {
      const result = await persistDependent({
        data: {
          tenant_id: activeTenant.id,
          holder_person_id: personId,
          dependent: {
            full_name: dependent.name,
            cpf: dependent.cpf || null,
            birth_date: dependent.birth || null,
          },
          relationship: dependent.relationship,
          income_tax_effect: dependent.ir,
          social_security_effect: dependent.socialSecurity,
          valid_from: dependent.from,
          valid_to: dependent.to || null,
        },
      });
      await refresh();
      setDependentOpen(false);
      toast.success(
        result.reusedPerson
          ? "Pessoa existente vinculada como dependente"
          : "Dependente cadastrado",
      );
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Falha ao salvar");
    }
  };
  const submitPension = async () => {
    if (!activeTenant || !personId) return;
    try {
      await persistPension({
        data: {
          tenant_id: activeTenant.id,
          holder_person_id: personId,
          employment_link_id: pension.linkId,
          beneficiary: {
            full_name: pension.name,
            cpf: pension.cpf || null,
            birth_date: null,
          },
          calculation_type: pension.type,
          percentage:
            pension.type === "percentual" ? Number(pension.value) : null,
          fixed_amount:
            pension.type === "valor_fixo" ? Number(pension.value) : null,
          priority: Number(pension.priority),
          valid_from: pension.from,
          valid_to: pension.to || null,
          legal_basis: pension.legalBasis || null,
        },
      });
      await refresh();
      setPensionOpen(false);
      toast.success("Pensionista cadastrado");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Falha ao salvar");
    }
  };

  if (!activeTenant)
    return (
      <div className="rounded-xl border bg-amber-50 p-6">
        Selecione uma entidade ativa.
      </div>
    );
  return (
    <section className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex items-center gap-3">
          <UsersRound className="size-7 text-primary" />
          <div>
            <h1 className="text-2xl font-extrabold">
              Dependentes e pensionistas
            </h1>
            <p className="text-sm text-muted-foreground">
              Vigências e efeitos tributários/previdenciários.
            </p>
          </div>
        </div>
        <div className="min-w-72 space-y-1">
          <Label>Titular</Label>
          <select
            className="h-9 w-full rounded-md border bg-background px-3 text-sm"
            value={personId}
            onChange={(e) => setPersonId(e.target.value)}
          >
            <option value="">Selecione</option>
            {registry?.people.map((person) => (
              <option key={person.id} value={person.id}>
                {person.full_name} ·{" "}
                {person.links.map((l) => l.registration_number).join(", ")}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="grid gap-5 xl:grid-cols-2">
        <div className="rounded-2xl border bg-card p-5 shadow-sm">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="flex items-center gap-2 font-bold">
              <Baby className="size-5" />
              Dependentes
              {valid && (
                <span className="text-xs font-normal text-muted-foreground">
                  · válidos hoje: IRRF {valid.irrf} · prev. {valid.previdencia}
                </span>
              )}
            </h2>
            {data?.canManage && (
              <Button size="sm" onClick={() => setDependentOpen(true)}>
                <Plus className="mr-1 size-3" />
                Adicionar
              </Button>
            )}
          </div>
          <div className="space-y-2">
            {data?.dependents.map((item) => (
              <div key={item.id} className="rounded-xl border p-3">
                <div className="flex justify-between">
                  <span className="font-semibold">{item.full_name}</span>
                  <Badge variant="outline">{item.relationship}</Badge>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  {item.valid_from} até {item.valid_to || "sem término"}
                </p>
                <div className="mt-2 flex gap-2">
                  {item.income_tax_effect && <Badge>IR</Badge>}
                  {item.social_security_effect && (
                    <Badge variant="secondary">Previdência</Badge>
                  )}
                </div>
              </div>
            ))}
            {!data?.dependents.length && (
              <p className="py-8 text-center text-sm text-muted-foreground">
                Nenhum dependente.
              </p>
            )}
          </div>
        </div>
        <div className="rounded-2xl border bg-card p-5 shadow-sm">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="flex items-center gap-2 font-bold">
              <Banknote className="size-5" />
              Pensionistas
            </h2>
            {data?.canManage && (
              <Button
                size="sm"
                onClick={() => {
                  setPension((current) => ({
                    ...current,
                    linkId: data.links[0]?.id ?? "",
                  }));
                  setPensionOpen(true);
                }}
              >
                <Plus className="mr-1 size-3" />
                Adicionar
              </Button>
            )}
          </div>
          {allocation && (
            <div
              className={`mb-3 rounded-lg border p-3 text-sm ${
                allocation.rateio_completo
                  ? "border-emerald-500/40 bg-emerald-500/5"
                  : "border-amber-500/40 bg-amber-500/5"
              }`}
            >
              Rateio percentual vigente hoje:{" "}
              <b className="tabular-nums">{allocation.total_percentual}%</b>{" "}
              {allocation.rateio_completo
                ? "— rateio completo."
                : allocation.rateio_excedido
                  ? "— excede 100%."
                  : "— rateio incompleto (falta distribuir)."}
            </div>
          )}
          <div className="space-y-2">
            {data?.pensions.map((item) => (
              <div key={item.id} className="rounded-xl border p-3">
                <div className="flex justify-between">
                  <span className="font-semibold">{item.full_name}</span>
                  <Badge variant="outline">Ordem {item.priority}</Badge>
                </div>
                <p className="text-sm">
                  {item.calculation_type === "percentual"
                    ? `${item.percentage}%`
                    : Number(item.fixed_amount).toLocaleString("pt-BR", {
                        style: "currency",
                        currency: "BRL",
                      })}
                </p>
                <p className="text-xs text-muted-foreground">
                  {item.valid_from} até {item.valid_to || "sem término"}
                </p>
              </div>
            ))}
            {!data?.pensions.length && (
              <p className="py-8 text-center text-sm text-muted-foreground">
                Nenhum pensionista.
              </p>
            )}
          </div>
        </div>
      </div>

      <Dialog open={dependentOpen} onOpenChange={setDependentOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Novo dependente</DialogTitle>
          </DialogHeader>
          <div className="grid gap-4 md:grid-cols-2">
            <Field
              label="Nome *"
              value={dependent.name}
              set={(name) => setDependent({ ...dependent, name })}
            />
            <Field
              label="CPF"
              value={dependent.cpf}
              set={(cpf) => setDependent({ ...dependent, cpf })}
            />
            <Field
              label="Nascimento"
              type="date"
              value={dependent.birth}
              set={(birth) => setDependent({ ...dependent, birth })}
            />
            <Field
              label="Parentesco *"
              value={dependent.relationship}
              set={(relationship) =>
                setDependent({ ...dependent, relationship })
              }
            />
            <Field
              label="Início *"
              type="date"
              value={dependent.from}
              set={(from) => setDependent({ ...dependent, from })}
            />
            <Field
              label="Fim"
              type="date"
              value={dependent.to}
              set={(to) => setDependent({ ...dependent, to })}
            />
          </div>
          <label className="flex items-center gap-2">
            <Checkbox
              checked={dependent.ir}
              onCheckedChange={(checked) =>
                setDependent({ ...dependent, ir: Boolean(checked) })
              }
            />
            Efeito no IR
          </label>
          <label className="flex items-center gap-2">
            <Checkbox
              checked={dependent.socialSecurity}
              onCheckedChange={(checked) =>
                setDependent({ ...dependent, socialSecurity: Boolean(checked) })
              }
            />
            Efeito previdenciário
          </label>
          <DialogFooter>
            <Button onClick={() => void submitDependent()}>Salvar</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={pensionOpen} onOpenChange={setPensionOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Novo pensionista</DialogTitle>
          </DialogHeader>
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-1">
              <Label>Vínculo de origem *</Label>
              <select
                className="h-9 w-full rounded-md border bg-background px-3 text-sm"
                value={pension.linkId}
                onChange={(e) =>
                  setPension({ ...pension, linkId: e.target.value })
                }
              >
                {data?.links.map((link) => (
                  <option key={link.id} value={link.id}>
                    #{link.registration_number}
                  </option>
                ))}
              </select>
            </div>
            <Field
              label="Beneficiário *"
              value={pension.name}
              set={(name) => setPension({ ...pension, name })}
            />
            <Field
              label="CPF"
              value={pension.cpf}
              set={(cpf) => setPension({ ...pension, cpf })}
            />
            <div className="space-y-1">
              <Label>Forma *</Label>
              <select
                className="h-9 w-full rounded-md border bg-background px-3 text-sm"
                value={pension.type}
                onChange={(e) =>
                  setPension({
                    ...pension,
                    type: e.target.value as typeof pension.type,
                  })
                }
              >
                <option value="percentual">Percentual</option>
                <option value="valor_fixo">Valor fixo</option>
              </select>
            </div>
            <Field
              label={
                pension.type === "percentual" ? "Percentual *" : "Valor fixo *"
              }
              type="number"
              value={pension.value}
              set={(value) => setPension({ ...pension, value })}
            />
            <Field
              label="Ordem *"
              type="number"
              value={pension.priority}
              set={(priority) => setPension({ ...pension, priority })}
            />
            <Field
              label="Início *"
              type="date"
              value={pension.from}
              set={(from) => setPension({ ...pension, from })}
            />
            <Field
              label="Fim"
              type="date"
              value={pension.to}
              set={(to) => setPension({ ...pension, to })}
            />
            <Field
              label="Base legal"
              value={pension.legalBasis}
              set={(legalBasis) => setPension({ ...pension, legalBasis })}
            />
          </div>
          <DialogFooter>
            <Button onClick={() => void submitPension()}>Salvar</Button>
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
