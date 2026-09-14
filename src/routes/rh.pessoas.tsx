import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  BriefcaseBusiness,
  Pencil,
  Plus,
  Search,
  UserRound,
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuth } from "@/lib/auth-context";
import {
  getPeopleRegistry,
  getPeopleUnits,
  savePersonAndLink,
  type EmploymentLinkView,
  type PersonRegistryRow,
} from "@/lib/people.functions";
import { getPensionRegimes } from "@/lib/pension-regimes.functions";

export const Route = createFileRoute("/rh/pessoas")({ component: Page });

type FormState = {
  personId?: string;
  linkId?: string;
  cpf: string;
  fullName: string;
  socialName: string;
  birthDate: string;
  motherName: string;
  personalEmail: string;
  phone: string;
  registrationNumber: string;
  unitId: string;
  pensionRegimeId: string;
  employmentType: string;
  workRegime: string;
  jobTitle: string;
  functionTitle: string;
  weeklyHours: string;
  costCenter: string;
  baseSalary: string;
  admissionDate: string;
  terminationDate: string;
  status: EmploymentLinkView["status"];
};

const emptyForm = (): FormState => ({
  cpf: "",
  fullName: "",
  socialName: "",
  birthDate: "",
  motherName: "",
  personalEmail: "",
  phone: "",
  registrationNumber: "",
  unitId: "",
  pensionRegimeId: "",
  employmentType: "",
  workRegime: "",
  jobTitle: "",
  functionTitle: "",
  weeklyHours: "",
  costCenter: "",
  baseSalary: "",
  admissionDate: "",
  terminationDate: "",
  status: "rascunho",
});

function Page() {
  const { session, loading, hasTenantPermission } = useAuth();
  const nav = useNavigate();
  useEffect(() => {
    if (loading) return;
    if (!session) nav({ to: "/login" });
    else if (!hasTenantPermission("people.read")) {
      toast.error("Sem acesso ao cadastro de pessoas");
      nav({ to: "/app" });
    }
  }, [session, loading, hasTenantPermission, nav]);
  if (!session) return null;
  return (
    <>
      <Content />
    </>
  );
}

function Content() {
  const { activeTenant } = useAuth();
  const listPeople = useServerFn(getPeopleRegistry);
  const listUnits = useServerFn(getPeopleUnits);
  const saveRecord = useServerFn(savePersonAndLink);
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("todos");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [form, setForm] = useState<FormState>(emptyForm());
  const [saving, setSaving] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ["people-registry", activeTenant?.id, search, status],
    enabled: Boolean(activeTenant),
    queryFn: () =>
      listPeople({
        data: {
          tenant_id: activeTenant!.id,
          search,
          status: status as
            | "todos"
            | "rascunho"
            | "ativo"
            | "afastado"
            | "ferias"
            | "desligado",
        },
      }),
  });
  const { data: units = [] } = useQuery({
    queryKey: ["people-units", activeTenant?.id],
    enabled: Boolean(activeTenant),
    queryFn: () => listUnits({ data: { tenant_id: activeTenant!.id } }),
  });
  const listRegimes = useServerFn(getPensionRegimes);
  const { data: regimeData } = useQuery({
    queryKey: ["people-pension-regimes", activeTenant?.id],
    enabled: Boolean(activeTenant),
    queryFn: () => listRegimes({ data: { tenant_id: activeTenant!.id } }),
  });
  const regimes = (regimeData?.regimes ?? []).filter(
    (r) => r.status === "ativo",
  );

  const openNew = () => {
    setForm(emptyForm());
    setDialogOpen(true);
  };
  const openLink = (person: PersonRegistryRow, link?: EmploymentLinkView) => {
    setForm({
      ...emptyForm(),
      personId: person.id,
      linkId: link?.id,
      cpf: person.cpf ?? "",
      fullName: person.full_name,
      socialName: person.social_name ?? "",
      personalEmail: person.personal_email ?? "",
      phone: person.phone ?? "",
      birthDate: person.birth_date ?? "",
      motherName: person.mother_name ?? "",
      registrationNumber: link?.registration_number ?? "",
      unitId: link?.unit_id ?? "",
      pensionRegimeId: link?.pension_regime_id ?? "",
      employmentType: link?.employment_type ?? "",
      workRegime: link?.work_regime ?? "",
      jobTitle: link?.job_title ?? "",
      functionTitle: link?.function_title ?? "",
      weeklyHours: link?.weekly_hours?.toString() ?? "",
      costCenter: link?.cost_center ?? "",
      baseSalary: link?.base_salary?.toString() ?? "",
      admissionDate: link?.admission_date ?? "",
      terminationDate: link?.termination_date ?? "",
      status: link?.status ?? "rascunho",
    });
    setDialogOpen(true);
  };

  const submit = async () => {
    if (!activeTenant) return;
    setSaving(true);
    try {
      const result = await saveRecord({
        data: {
          tenant_id: activeTenant.id,
          person: {
            id: form.personId,
            cpf: form.cpf || null,
            full_name: form.fullName,
            social_name: form.socialName || null,
            birth_date: form.birthDate || null,
            mother_name: form.motherName || null,
            personal_email: form.personalEmail || null,
            phone: form.phone || null,
          },
          link: {
            id: form.linkId,
            registration_number: form.registrationNumber,
            unit_id: form.unitId || null,
            pension_regime_id: form.pensionRegimeId || null,
            employment_type: form.employmentType || null,
            work_regime: form.workRegime || null,
            job_title: form.jobTitle || null,
            function_title: form.functionTitle || null,
            weekly_hours: form.weeklyHours ? Number(form.weeklyHours) : null,
            cost_center: form.costCenter || null,
            base_salary: form.baseSalary ? Number(form.baseSalary) : null,
            admission_date: form.admissionDate || null,
            termination_date: form.terminationDate || null,
            status: form.status,
          },
        },
      });
      await queryClient.invalidateQueries({
        queryKey: ["people-registry", activeTenant.id],
      });
      setDialogOpen(false);
      toast.success(
        result.reusedPerson
          ? "CPF localizado: novo vínculo associado à pessoa existente"
          : form.linkId
            ? "Pessoa e vínculo atualizados"
            : "Pessoa e vínculo salvos",
      );
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Não foi possível salvar",
      );
    } finally {
      setSaving(false);
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
          <UserRound className="size-7 text-primary" />
          <div>
            <h1 className="text-2xl font-extrabold">Pessoas e vínculos</h1>
            <p className="text-sm text-muted-foreground">
              {activeTenant.nome} · cadastro único por CPF e matrículas
              independentes.
            </p>
          </div>
        </div>
        {data?.canManage && (
          <Button onClick={openNew}>
            <Plus className="mr-2 size-4" />
            Nova pessoa
          </Button>
        )}
      </div>

      <div className="flex flex-wrap gap-3 rounded-2xl border bg-card p-4 shadow-sm">
        <div className="relative min-w-64 flex-1">
          <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            className="pl-9"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Nome, CPF, matrícula ou cargo"
          />
        </div>
        <select
          className="h-9 rounded-md border bg-background px-3 text-sm"
          value={status}
          onChange={(e) => setStatus(e.target.value)}
        >
          <option value="todos">Todos os status</option>
          <option value="rascunho">Rascunho</option>
          <option value="ativo">Ativo</option>
          <option value="afastado">Afastado</option>
          <option value="ferias">Férias</option>
          <option value="desligado">Desligado</option>
        </select>
      </div>

      <div className="space-y-3">
        {isLoading && (
          <p className="py-10 text-center text-muted-foreground">
            Carregando...
          </p>
        )}
        {!isLoading && !data?.people.length && (
          <div className="rounded-2xl border bg-card p-10 text-center text-muted-foreground">
            Nenhuma pessoa encontrada no seu escopo.
          </div>
        )}
        {data?.people.map((person) => (
          <article
            key={person.id}
            className="rounded-2xl border bg-card p-5 shadow-sm"
          >
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 className="font-bold">
                  {person.social_name || person.full_name}
                </h2>
                <p className="text-xs text-muted-foreground">
                  CPF {person.cpf || "não informado"} · {person.link_count}{" "}
                  vínculo(s)
                </p>
              </div>
              {data.canManage && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => openLink(person)}
                >
                  <Plus className="mr-1 size-3" />
                  Novo vínculo
                </Button>
              )}
            </div>
            <div className="mt-4 grid gap-2 lg:grid-cols-2">
              {person.links.map((link) => (
                <div
                  key={link.id}
                  className="flex items-center gap-3 rounded-xl border p-3"
                >
                  <BriefcaseBusiness className="size-5 text-primary" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold">
                      #{link.registration_number} ·{" "}
                      {link.job_title || "Cargo não informado"}
                    </p>
                    <p className="truncate text-xs text-muted-foreground">
                      {link.unit_name || "Sem lotação"} ·{" "}
                      {link.work_regime || "sem regime"}
                    </p>
                  </div>
                  <Badge
                    variant={link.status === "ativo" ? "default" : "secondary"}
                  >
                    {link.status}
                  </Badge>
                  {data.canManage && (
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => openLink(person, link)}
                    >
                      <Pencil className="size-4" />
                    </Button>
                  )}
                </div>
              ))}
            </div>
          </article>
        ))}
      </div>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {form.linkId
                ? "Editar vínculo"
                : form.personId
                  ? "Novo vínculo"
                  : "Nova pessoa e vínculo"}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-5">
            <FormSection title="Pessoa">
              <Field
                label="Nome completo *"
                value={form.fullName}
                set={(fullName) => setForm({ ...form, fullName })}
              />
              <Field
                label="CPF"
                value={form.cpf}
                set={(cpf) => setForm({ ...form, cpf })}
              />
              <Field
                label="Nome social"
                value={form.socialName}
                set={(socialName) => setForm({ ...form, socialName })}
              />
              {data?.canSensitive && (
                <Field
                  label="Nascimento"
                  type="date"
                  value={form.birthDate}
                  set={(birthDate) => setForm({ ...form, birthDate })}
                />
              )}
              {data?.canSensitive && (
                <Field
                  label="Nome da mãe"
                  value={form.motherName}
                  set={(motherName) => setForm({ ...form, motherName })}
                />
              )}
              <Field
                label="E-mail pessoal"
                type="email"
                value={form.personalEmail}
                set={(personalEmail) => setForm({ ...form, personalEmail })}
              />
              <Field
                label="Telefone"
                value={form.phone}
                set={(phone) => setForm({ ...form, phone })}
              />
            </FormSection>
            <FormSection title="Vínculo funcional">
              <Field
                label="Matrícula *"
                value={form.registrationNumber}
                set={(registrationNumber) =>
                  setForm({ ...form, registrationNumber })
                }
              />
              <SelectField
                label="Lotação"
                value={form.unitId}
                set={(unitId) => setForm({ ...form, unitId })}
                options={units.map((u) => ({
                  value: u.id,
                  label: `${u.codigo} · ${u.nome}`,
                }))}
              />
              <SelectField
                label="Regime previdenciário"
                value={form.pensionRegimeId}
                set={(pensionRegimeId) => setForm({ ...form, pensionRegimeId })}
                options={regimes.map((r) => ({
                  value: r.id,
                  label: `${r.code} · ${r.name}`,
                }))}
              />
              <Field
                label="Tipo de vínculo"
                value={form.employmentType}
                set={(employmentType) => setForm({ ...form, employmentType })}
                placeholder="Efetivo, comissionado..."
              />
              <Field
                label="Regime"
                value={form.workRegime}
                set={(workRegime) => setForm({ ...form, workRegime })}
                placeholder="Estatutário, CLT..."
              />
              <Field
                label="Cargo"
                value={form.jobTitle}
                set={(jobTitle) => setForm({ ...form, jobTitle })}
              />
              <Field
                label="Função"
                value={form.functionTitle}
                set={(functionTitle) => setForm({ ...form, functionTitle })}
              />
              <Field
                label="Jornada semanal"
                type="number"
                value={form.weeklyHours}
                set={(weeklyHours) => setForm({ ...form, weeklyHours })}
              />
              <Field
                label="Centro de custo"
                value={form.costCenter}
                set={(costCenter) => setForm({ ...form, costCenter })}
              />
              <Field
                label="Salário-base"
                type="number"
                value={form.baseSalary}
                set={(baseSalary) => setForm({ ...form, baseSalary })}
              />
              <Field
                label="Admissão"
                type="date"
                value={form.admissionDate}
                set={(admissionDate) => setForm({ ...form, admissionDate })}
              />
              <Field
                label="Desligamento"
                type="date"
                value={form.terminationDate}
                set={(terminationDate) => setForm({ ...form, terminationDate })}
              />
              <SelectField
                label="Status"
                value={form.status}
                set={(value) =>
                  setForm({ ...form, status: value as FormState["status"] })
                }
                options={[
                  { value: "rascunho", label: "Rascunho" },
                  { value: "ativo", label: "Ativo" },
                  { value: "afastado", label: "Afastado" },
                  { value: "ferias", label: "Férias" },
                  { value: "desligado", label: "Desligado" },
                ]}
              />
            </FormSection>
          </div>
          <DialogFooter>
            <Button onClick={() => void submit()} disabled={saving}>
              {saving ? "Salvando..." : "Salvar"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}

function FormSection({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <fieldset className="grid gap-4 rounded-xl border p-4 md:grid-cols-2">
      <legend className="px-2 text-sm font-bold">{title}</legend>
      {children}
    </fieldset>
  );
}

function Field({
  label,
  value,
  set,
  type = "text",
  placeholder,
}: {
  label: string;
  value: string;
  set: (value: string) => void;
  type?: string;
  placeholder?: string;
}) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      <Input
        type={type}
        value={value}
        onChange={(e) => set(e.target.value)}
        placeholder={placeholder}
      />
    </div>
  );
}

function SelectField({
  label,
  value,
  set,
  options,
}: {
  label: string;
  value: string;
  set: (value: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      <select
        className="h-9 w-full rounded-md border bg-background px-3 text-sm"
        value={value}
        onChange={(e) => set(e.target.value)}
      >
        <option value="">Selecione</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}
