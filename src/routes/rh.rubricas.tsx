import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { CheckCircle2, GitBranch, Plus, ReceiptText } from "lucide-react";
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
import { Textarea } from "@/components/ui/textarea";
import { useAuth } from "@/lib/auth-context";
import {
  getPayrollCatalog,
  savePayrollRubric,
  savePayrollRubricVersion,
  validatePayrollFormula,
} from "@/lib/payroll-catalog.functions";
import {
  formulaAstFromTemplate,
  PAYROLL_FORMULA_VARIABLES,
  type PayrollFormulaAst,
  type PayrollFormulaOperator,
  type PayrollFormulaVariable,
} from "@/lib/payroll-formula";

export const Route = createFileRoute("/rh/rubricas")({ component: Page });

function Page() {
  const { session, loading, hasTenantPermission } = useAuth();
  const nav = useNavigate();
  useEffect(() => {
    if (loading) return;
    if (!session) nav({ to: "/login" });
    else if (!hasTenantPermission("payroll.catalog.read")) nav({ to: "/app" });
  }, [session, loading, hasTenantPermission, nav]);
  if (!session) return null;
  return <Content />;
}

const emptyRubric = () => ({
  id: undefined as string | undefined,
  code: "",
  name: "",
  nature: "provento" as "provento" | "desconto" | "informativa",
  unit: "valor" as "valor" | "percentual" | "hora" | "dia" | "quantidade",
  order: "100",
  status: "rascunho" as "rascunho" | "ativo" | "inativo",
  description: "",
});
const emptyVersion = () => ({
  id: undefined as string | undefined,
  from: new Date().toISOString().slice(0, 10),
  to: "",
  status: "rascunho" as "rascunho" | "publicada" | "arquivada",
  scale: "2",
  rounding: "half_up" as "half_up" | "half_even" | "truncate",
  notes: "",
  bases: [] as string[],
  dependencies: [] as string[],
  formulaVariable: "fixed_amount" as PayrollFormulaVariable,
  formulaOperator: "*" as PayrollFormulaOperator,
  formulaOperand: "1",
  adjustmentOperator: "" as "" | PayrollFormulaOperator,
  adjustment: "",
  formulaChecksum: "",
  formulaPreview: "",
});

function templateFromAst(input: unknown) {
  const fallback = emptyVersion();
  if (!input || typeof input !== "object") return fallback;
  const ast = input as PayrollFormulaAst;
  const outer = ast.type === "binary" ? ast : null;
  const first = outer?.left?.type === "binary" ? outer.left : outer;
  if (
    !first ||
    first.type !== "binary" ||
    first.left.type !== "variable" ||
    first.right.type !== "number"
  )
    return fallback;
  const adjusted = outer !== first && outer?.right.type === "number";
  return {
    ...fallback,
    formulaVariable: first.left.name,
    formulaOperator: first.operator,
    formulaOperand: String(first.right.value),
    adjustmentOperator: adjusted ? outer.operator : "",
    adjustment: adjusted ? String(outer.right.value) : "",
  };
}

function Content() {
  const { activeTenant } = useAuth();
  const loadCatalog = useServerFn(getPayrollCatalog);
  const persistRubric = useServerFn(savePayrollRubric);
  const persistVersion = useServerFn(savePayrollRubricVersion);
  const validateFormula = useServerFn(validatePayrollFormula);
  const qc = useQueryClient();
  const [selectedId, setSelectedId] = useState("");
  const [rubricOpen, setRubricOpen] = useState(false);
  const [versionOpen, setVersionOpen] = useState(false);
  const [rubricForm, setRubricForm] = useState(emptyRubric());
  const [versionForm, setVersionForm] = useState(emptyVersion());
  const { data } = useQuery({
    queryKey: ["payroll-catalog", activeTenant?.id],
    enabled: Boolean(activeTenant),
    queryFn: () => loadCatalog({ data: { tenant_id: activeTenant!.id } }),
  });
  useEffect(() => {
    if (!selectedId && data?.rubrics[0]) setSelectedId(data.rubrics[0].id);
  }, [data, selectedId]);
  const selected = data?.rubrics.find((item) => item.id === selectedId);
  const versions = useMemo(
    () => data?.versions.filter((item) => item.rubric_id === selectedId) ?? [],
    [data, selectedId],
  );
  const refresh = () =>
    qc.invalidateQueries({ queryKey: ["payroll-catalog", activeTenant?.id] });

  const editRubric = () => {
    if (!selected) return;
    setRubricForm({
      id: selected.id,
      code: selected.code,
      name: selected.name,
      nature: selected.nature,
      unit: selected.unit,
      order: String(selected.calculation_order),
      status: selected.status,
      description: selected.description ?? "",
    });
    setRubricOpen(true);
  };
  const submitRubric = async () => {
    if (!activeTenant) return;
    try {
      const result = await persistRubric({
        data: {
          id: rubricForm.id,
          tenant_id: activeTenant.id,
          code: rubricForm.code,
          name: rubricForm.name,
          nature: rubricForm.nature,
          unit: rubricForm.unit,
          calculation_order: Number(rubricForm.order),
          status: rubricForm.status,
          description: rubricForm.description || null,
        },
      });
      setSelectedId(result.id);
      await refresh();
      setRubricOpen(false);
      toast.success("Rubrica salva");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Falha ao salvar");
    }
  };
  const openVersion = (
    version?: NonNullable<typeof data>["versions"][number],
  ) => {
    if (!version) setVersionForm(emptyVersion());
    else {
      const incidences = data!.incidences.filter(
        (item) => item.version_id === version.id,
      );
      const template = templateFromAst(version.formula_ast);
      setVersionForm({
        ...template,
        id: version.id,
        from: version.valid_from,
        to: version.valid_to ?? "",
        status: version.status,
        scale: String(version.rounding_scale),
        rounding: version.rounding_mode as typeof versionForm.rounding,
        notes: version.notes ?? "",
        bases: incidences.flatMap((item) =>
          item.base_code ? [item.base_code] : [],
        ),
        dependencies: incidences.flatMap((item) =>
          item.depends_on_rubric_id ? [item.depends_on_rubric_id] : [],
        ),
        formulaChecksum: version.formula_checksum ?? "",
        formulaPreview: "",
      });
    }
    setVersionOpen(true);
  };
  const buildFormulaAst = () =>
    formulaAstFromTemplate({
      variable: versionForm.formulaVariable,
      operator: versionForm.formulaOperator,
      operand: Number(versionForm.formulaOperand),
      adjustmentOperator: versionForm.adjustmentOperator || null,
      adjustment:
        versionForm.adjustmentOperator && versionForm.adjustment !== ""
          ? Number(versionForm.adjustment)
          : null,
    });
  const checkFormula = async () => {
    if (!activeTenant) return;
    try {
      const result = await validateFormula({
        data: {
          tenant_id: activeTenant.id,
          formula_ast: buildFormulaAst(),
          rounding_scale: Number(versionForm.scale),
          rounding_mode: versionForm.rounding,
          sample_variables: {
            salary_base: 5000,
            fixed_amount: 1000,
            quantity: 10,
            hours: 20,
            days: 22,
            dependency_total: 500,
            inss_base: 5000,
            irrf_base: 5000,
            fgts_base: 5000,
            patronal_base: 5000,
            dependents_ir: 1,
          },
        },
      });
      setVersionForm({
        ...versionForm,
        formulaChecksum: result.checksum,
        formulaPreview: String(result.evaluation.roundedValue),
      });
      toast.success("Fórmula segura validada");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Fórmula inválida");
    }
  };
  const submitVersion = async () => {
    if (!activeTenant || !selectedId) return;
    try {
      const result = await persistVersion({
        data: {
          id: versionForm.id,
          tenant_id: activeTenant.id,
          rubric_id: selectedId,
          valid_from: versionForm.from,
          valid_to: versionForm.to || null,
          status: versionForm.status,
          rounding_scale: Number(versionForm.scale),
          rounding_mode: versionForm.rounding,
          notes: versionForm.notes || null,
          base_codes: versionForm.bases as (
            "inss" | "irrf" | "fgts" | "patronal"
          )[],
          dependencies: versionForm.dependencies,
          formula_ast: buildFormulaAst(),
        },
      });
      await refresh();
      setVersionOpen(false);
      toast.success(
        `Versão ${result.versionNumber} salva${result.formulaChecksum ? " e validada" : ""}`,
      );
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Falha ao salvar versão",
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
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <ReceiptText className="size-7 text-primary" />
          <div>
            <h1 className="text-2xl font-extrabold">Catálogo de rubricas</h1>
            <p className="text-sm text-muted-foreground">
              Versões reproduzíveis, vigências e incidências sem ciclos.
            </p>
          </div>
        </div>
        {data?.canManage && (
          <Button
            onClick={() => {
              setRubricForm(emptyRubric());
              setRubricOpen(true);
            }}
          >
            <Plus className="mr-1 size-4" />
            Nova rubrica
          </Button>
        )}
      </div>
      <div className="grid gap-5 xl:grid-cols-[320px_minmax(0,1fr)]">
        <aside className="space-y-2 rounded-2xl border bg-card p-4 shadow-sm">
          {data?.rubrics.map((rubric) => (
            <button
              key={rubric.id}
              className={`w-full rounded-xl border p-3 text-left ${selectedId === rubric.id ? "border-primary bg-primary/5" : "hover:bg-muted"}`}
              onClick={() => setSelectedId(rubric.id)}
            >
              <div className="flex justify-between">
                <span className="font-mono text-sm font-bold">
                  {rubric.code}
                </span>
                <Badge variant="outline">{rubric.nature}</Badge>
              </div>
              <p className="mt-1 text-sm">{rubric.name}</p>
              <p className="text-[11px] text-muted-foreground">
                ordem {rubric.calculation_order} · {rubric.unit} ·{" "}
                {rubric.status}
              </p>
            </button>
          ))}
          {!data?.rubrics.length && (
            <p className="py-8 text-center text-sm text-muted-foreground">
              Nenhuma rubrica.
            </p>
          )}
        </aside>
        <div className="space-y-4">
          {selected ? (
            <>
              <div className="rounded-2xl border bg-card p-5 shadow-sm">
                <div className="flex flex-wrap justify-between gap-3">
                  <div>
                    <h2 className="text-xl font-bold">
                      {selected.code} · {selected.name}
                    </h2>
                    <p className="text-sm text-muted-foreground">
                      {selected.description || "Sem descrição"}
                    </p>
                  </div>
                  {data?.canManage && (
                    <Button variant="outline" onClick={editRubric}>
                      Editar rubrica
                    </Button>
                  )}
                </div>
              </div>
              <div className="rounded-2xl border bg-card p-5 shadow-sm">
                <div className="mb-4 flex justify-between">
                  <h2 className="flex items-center gap-2 font-bold">
                    <GitBranch className="size-4" />
                    Versões e vigências
                  </h2>
                  {data?.canManage && (
                    <Button size="sm" onClick={() => openVersion()}>
                      <Plus className="mr-1 size-3" />
                      Nova versão
                    </Button>
                  )}
                </div>
                <div className="space-y-2">
                  {versions.map((version) => {
                    const incidences = data!.incidences.filter(
                      (item) => item.version_id === version.id,
                    );
                    return (
                      <button
                        key={version.id}
                        onClick={() => openVersion(version)}
                        className="w-full rounded-xl border p-4 text-left hover:bg-muted"
                      >
                        <div className="flex justify-between">
                          <span className="font-semibold">
                            Versão {version.version_number}
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
                        </div>
                        <p className="text-xs text-muted-foreground">
                          {version.valid_from} até{" "}
                          {version.valid_to || "sem término"}
                        </p>
                        <p className="mt-1 truncate font-mono text-[10px] text-muted-foreground">
                          AST: {version.formula_checksum || "não validada"}
                        </p>
                        <p className="mt-2 text-xs">
                          Bases:{" "}
                          {incidences
                            .flatMap((item) =>
                              item.base_code
                                ? [item.base_code.toUpperCase()]
                                : [],
                            )
                            .join(", ") || "nenhuma"}{" "}
                          · dependências:{" "}
                          {
                            incidences.filter(
                              (item) => item.depends_on_rubric_id,
                            ).length
                          }
                        </p>
                      </button>
                    );
                  })}
                  {!versions.length && (
                    <p className="py-8 text-center text-sm text-muted-foreground">
                      Nenhuma versão.
                    </p>
                  )}
                </div>
              </div>
            </>
          ) : (
            <div className="rounded-2xl border bg-card p-10 text-center text-muted-foreground">
              Selecione uma rubrica.
            </div>
          )}
        </div>
      </div>

      <Dialog open={rubricOpen} onOpenChange={setRubricOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {rubricForm.id ? "Editar rubrica" : "Nova rubrica"}
            </DialogTitle>
          </DialogHeader>
          <div className="grid gap-4 md:grid-cols-2">
            <Field
              label="Código *"
              value={rubricForm.code}
              set={(code) => setRubricForm({ ...rubricForm, code })}
            />
            <Field
              label="Nome *"
              value={rubricForm.name}
              set={(name) => setRubricForm({ ...rubricForm, name })}
            />
            <Select
              label="Natureza"
              value={rubricForm.nature}
              set={(nature) =>
                setRubricForm({
                  ...rubricForm,
                  nature: nature as typeof rubricForm.nature,
                })
              }
              options={["provento", "desconto", "informativa"]}
            />
            <Select
              label="Unidade"
              value={rubricForm.unit}
              set={(unit) =>
                setRubricForm({
                  ...rubricForm,
                  unit: unit as typeof rubricForm.unit,
                })
              }
              options={["valor", "percentual", "hora", "dia", "quantidade"]}
            />
            <Field
              label="Ordem"
              type="number"
              value={rubricForm.order}
              set={(order) => setRubricForm({ ...rubricForm, order })}
            />
            <Select
              label="Situação"
              value={rubricForm.status}
              set={(status) =>
                setRubricForm({
                  ...rubricForm,
                  status: status as typeof rubricForm.status,
                })
              }
              options={["rascunho", "ativo", "inativo"]}
            />
          </div>
          <div className="space-y-1">
            <Label>Descrição</Label>
            <Textarea
              value={rubricForm.description}
              onChange={(e) =>
                setRubricForm({ ...rubricForm, description: e.target.value })
              }
            />
          </div>
          <DialogFooter>
            <Button onClick={() => void submitRubric()}>Salvar</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={versionOpen} onOpenChange={setVersionOpen}>
        <DialogContent className="max-h-[88vh] max-w-2xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Versão da rubrica {selected?.code}</DialogTitle>
          </DialogHeader>
          <div className="grid gap-4 md:grid-cols-2">
            <Field
              label="Início *"
              type="date"
              value={versionForm.from}
              set={(from) => setVersionForm({ ...versionForm, from })}
            />
            <Field
              label="Fim"
              type="date"
              value={versionForm.to}
              set={(to) => setVersionForm({ ...versionForm, to })}
            />
            <Select
              label="Situação"
              value={versionForm.status}
              set={(status) =>
                setVersionForm({
                  ...versionForm,
                  status: status as typeof versionForm.status,
                })
              }
              options={["rascunho", "publicada", "arquivada"]}
            />
            <Field
              label="Casas decimais"
              type="number"
              value={versionForm.scale}
              set={(scale) => setVersionForm({ ...versionForm, scale })}
            />
            <Select
              label="Arredondamento"
              value={versionForm.rounding}
              set={(rounding) =>
                setVersionForm({
                  ...versionForm,
                  rounding: rounding as typeof versionForm.rounding,
                })
              }
              options={["half_up", "half_even", "truncate"]}
            />
          </div>
          <div>
            <Label className="mb-2 block">Incide nas bases</Label>
            <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
              {["inss", "irrf", "fgts", "patronal"].map((base) => (
                <label
                  key={base}
                  className="flex items-center gap-2 rounded-lg border p-2 text-sm uppercase"
                >
                  <Checkbox
                    checked={versionForm.bases.includes(base)}
                    onCheckedChange={(checked) =>
                      setVersionForm({
                        ...versionForm,
                        bases: checked
                          ? [...versionForm.bases, base]
                          : versionForm.bases.filter((item) => item !== base),
                      })
                    }
                  />
                  {base}
                </label>
              ))}
            </div>
          </div>
          <div>
            <Label className="mb-2 block">Depende de outras rubricas</Label>
            <div className="grid gap-2 md:grid-cols-2">
              {data?.rubrics
                .filter((rubric) => rubric.id !== selectedId)
                .map((rubric) => (
                  <label
                    key={rubric.id}
                    className="flex items-center gap-2 rounded-lg border p-2 text-sm"
                  >
                    <Checkbox
                      checked={versionForm.dependencies.includes(rubric.id)}
                      onCheckedChange={(checked) =>
                        setVersionForm({
                          ...versionForm,
                          dependencies: checked
                            ? [...versionForm.dependencies, rubric.id]
                            : versionForm.dependencies.filter(
                                (id) => id !== rubric.id,
                              ),
                        })
                      }
                    />
                    {rubric.code} · {rubric.name}
                  </label>
                ))}
            </div>
          </div>
          <div className="space-y-3 rounded-xl border bg-muted/30 p-4">
            <div>
              <Label className="font-semibold">Editor seguro de fórmula</Label>
              <p className="text-xs text-muted-foreground">
                O construtor gera uma AST permitida. Nenhum texto livre é
                executado.
              </p>
            </div>
            <div className="grid gap-3 md:grid-cols-3">
              <Select
                label="Variável"
                value={versionForm.formulaVariable}
                set={(formulaVariable) =>
                  setVersionForm({
                    ...versionForm,
                    formulaVariable: formulaVariable as PayrollFormulaVariable,
                    formulaChecksum: "",
                  })
                }
                options={[...PAYROLL_FORMULA_VARIABLES]}
              />
              <Select
                label="Operador"
                value={versionForm.formulaOperator}
                set={(formulaOperator) =>
                  setVersionForm({
                    ...versionForm,
                    formulaOperator: formulaOperator as PayrollFormulaOperator,
                    formulaChecksum: "",
                  })
                }
                options={["*", "/", "+", "-"]}
              />
              <Field
                label="Operando"
                type="number"
                value={versionForm.formulaOperand}
                set={(formulaOperand) =>
                  setVersionForm({
                    ...versionForm,
                    formulaOperand,
                    formulaChecksum: "",
                  })
                }
              />
              <Select
                label="Ajuste opcional"
                value={versionForm.adjustmentOperator}
                set={(adjustmentOperator) =>
                  setVersionForm({
                    ...versionForm,
                    adjustmentOperator: adjustmentOperator as
                      "" | PayrollFormulaOperator,
                    formulaChecksum: "",
                  })
                }
                options={["", "+", "-", "*", "/"]}
              />
              <Field
                label="Valor do ajuste"
                type="number"
                value={versionForm.adjustment}
                set={(adjustment) =>
                  setVersionForm({
                    ...versionForm,
                    adjustment,
                    formulaChecksum: "",
                  })
                }
              />
              <div className="flex items-end">
                <Button
                  type="button"
                  variant="outline"
                  className="w-full"
                  onClick={() => void checkFormula()}
                >
                  <CheckCircle2 className="mr-1 size-4" /> Validar e testar
                </Button>
              </div>
            </div>
            {versionForm.formulaChecksum && (
              <div className="rounded-lg bg-emerald-50 p-3 text-xs text-emerald-900">
                Resultado da amostra:{" "}
                <strong>{versionForm.formulaPreview}</strong>
                <div className="mt-1 break-all font-mono text-[10px]">
                  SHA-256: {versionForm.formulaChecksum}
                </div>
              </div>
            )}
          </div>
          <div className="space-y-1">
            <Label>Notas</Label>
            <Textarea
              value={versionForm.notes}
              onChange={(e) =>
                setVersionForm({ ...versionForm, notes: e.target.value })
              }
            />
          </div>
          <DialogFooter>
            <Button onClick={() => void submitVersion()}>Salvar versão</Button>
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
        className="h-9 w-full rounded-md border bg-background px-3"
        value={value}
        onChange={(e) => set(e.target.value)}
      >
        {options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    </div>
  );
}
