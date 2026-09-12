import { createFileRoute, useNavigate, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  ArrowLeft,
  Save,
  Download,
  Check,
  X,
  FileText,
  Loader2,
  Trash2,
  KeyRound,
  Upload,
  Clock,
  Plus,
  Pencil,
} from "lucide-react";
import { useServerFn } from "@tanstack/react-start";
import {
  adminDeleteUser,
  adminResetPassword,
  adminUpdateUserEmail,
} from "@/lib/admin-users.functions";
import { rhUploadEmployeeDocument } from "@/lib/data.functions";
import {
  registerManualTimeEntry,
  updateManualTimeEntry,
  softDeleteTimeEntry,
} from "@/lib/timesheet.functions";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth-context";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { StatusBadge } from "@/components/StatusBadge";
import {
  CATEGORIA_LABEL,
  STATUS_LABEL,
  type EmployeeStatus,
  type DocumentoCategoria,
} from "@/lib/employee-types";
import { workedMinutesForDay, type TimeEntry } from "@/lib/payroll";

export const Route = createFileRoute("/rh/funcionarios/$id")({
  component: Page,
});

const UF_OPTS = [
  "AC",
  "AL",
  "AP",
  "AM",
  "BA",
  "CE",
  "DF",
  "ES",
  "GO",
  "MA",
  "MT",
  "MS",
  "MG",
  "PA",
  "PB",
  "PR",
  "PE",
  "PI",
  "RJ",
  "RN",
  "RS",
  "RO",
  "RR",
  "SC",
  "SP",
  "SE",
  "TO",
];
const SEXO_OPTS = ["Feminino", "Masculino", "Outro", "Não informar"];
const ESTADO_CIVIL_OPTS = [
  "Solteiro(a)",
  "Casado(a)",
  "Divorciado(a)",
  "Viúvo(a)",
  "União estável",
  "Separado(a)",
];
const ESCOLARIDADE_OPTS = [
  "Fundamental incompleto",
  "Fundamental completo",
  "Médio incompleto",
  "Médio completo",
  "Superior incompleto",
  "Superior completo",
  "Pós-graduação",
  "Mestrado",
  "Doutorado",
];
const RACA_COR_OPTS = [
  "Branca",
  "Preta",
  "Parda",
  "Amarela",
  "Indígena",
  "Não informada",
];
const TIPO_CONTRATO_OPTS = [
  "CLT",
  "PJ",
  "Estágio",
  "Temporário",
  "Aprendiz",
  "Terceirizado",
  "Autônomo",
];
const REGIME_OPTS = ["Mensalista", "Horista", "Diarista"];
const TIPO_CONTA_OPTS = ["Corrente", "Poupança", "Conta-salário", "Pagamento"];
const CNH_CAT_OPTS = ["A", "B", "AB", "C", "D", "E", "ACC"];
const TIPO_CHAVE_PIX_OPTS = ["CPF", "CNPJ", "E-mail", "Telefone", "Aleatória"];

function Page() {
  const { session, hasPermission, loading } = useAuth();
  const nav = useNavigate();
  useEffect(() => {
    if (loading) return;
    if (!session) nav({ to: "/login" });
    else if (!hasPermission("manage_employees")) {
      toast.error("Sem permissão");
      nav({ to: "/app" });
    }
  }, [session, hasPermission, loading, nav]);
  if (!session || !hasPermission("manage_employees")) return null;
  return <Content />;
}

type ProfileForm = {
  full_name: string;
  email: string;
  cpf: string;
  matricula: string;
  setor: string;
  operacao: string;
  cargo: string;
  data_admissao: string;
  status: EmployeeStatus;
  telefone: string;
  endereco: string;
  contato_emergencia_nome: string;
  contato_emergencia_telefone: string;
  salario: string;
  centro_custo: string;
  gestor_id: string;
  schedule_id: string;
  tipo_ponto: "2_batidas" | "4_batidas";
  valor_hora: string;
  vale_alimentacao_diario: string;
  beneficio_alimentacao: "VA" | "VR";
  vale_transporte_diario: string;
  desconto_vt_funcionario: boolean;
  insalubridade_pct: string;
  periculosidade_pct: string;
  adicional_noturno: boolean;
  plano_saude_desconto: string;
  outros_descontos: string;
  outros_proventos: string;
  dependentes_ir: string;
  desconta_inss: boolean;
  desconta_irrf: boolean;
  // Dados pessoais
  data_nascimento: string;
  sexo: string;
  estado_civil: string;
  nacionalidade: string;
  naturalidade: string;
  nome_mae: string;
  nome_pai: string;
  escolaridade: string;
  raca_cor: string;
  pcd: boolean;
  tipo_deficiencia: string;
  email_pessoal: string;
  celular: string;
  // Documentos
  rg: string;
  rg_orgao_emissor: string;
  rg_uf: string;
  rg_data_emissao: string;
  pis_pasep: string;
  ctps_numero: string;
  ctps_serie: string;
  ctps_uf: string;
  titulo_eleitor: string;
  titulo_zona: string;
  titulo_secao: string;
  reservista: string;
  cnh_numero: string;
  cnh_categoria: string;
  cnh_validade: string;
  // Endereço estruturado
  cep: string;
  logradouro: string;
  numero_endereco: string;
  complemento: string;
  bairro: string;
  cidade: string;
  uf: string;
  // Dados contratuais
  tipo_contrato: string;
  regime_trabalho: string;
  data_demissao: string;
  cbo: string;
  jornada_semanal_horas: string;
  // Dados bancários
  banco: string;
  agencia: string;
  conta: string;
  tipo_conta: string;
  chave_pix: string;
  tipo_chave_pix: string;
  // Benefícios · exportação VT/VA
  unidade_id: string;
  vt_beneficio_codigo: string;
  vt_quantidade_diaria: string;
  vt_tipo_valor: string;
  vt_rede_recarga: string;
  va_quantidade_diaria: string;
};

function Content() {
  const { id } = Route.useParams();
  const { user, isAdmin } = useAuth();
  const nav = useNavigate();
  const qc = useQueryClient();
  const deleteUser = useServerFn(adminDeleteUser);
  const resetPassword = useServerFn(adminResetPassword);
  const updateEmail = useServerFn(adminUpdateUserEmail);
  const [confirmDel, setConfirmDel] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [newPassword, setNewPassword] = useState("");

  const onResetPassword = async () => {
    setResetting(true);
    try {
      await resetPassword({ data: { user_id: id, password: newPassword } });
      toast.success("Senha redefinida; sessões anteriores revogadas");
      setNewPassword("");
      setConfirmReset(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Erro ao redefinir senha");
    } finally {
      setResetting(false);
    }
  };

  const { data: profile, isLoading } = useQuery({
    queryKey: ["funcionario", id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("profiles")
        .select("*")
        .eq("id", id)
        .single();
      if (error) throw error;
      return data;
    },
  });

  const { data: gestores } = useQuery({
    queryKey: ["gestores-options"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("profiles")
        .select("id, full_name, email")
        .order("full_name");
      if (error) throw error;
      return data;
    },
  });

  const { data: schedules } = useQuery({
    queryKey: ["schedules-options"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("work_schedules")
        .select("id, nome, tipo, carga_horaria_mensal")
        .order("nome");
      if (error) throw error;
      return data;
    },
  });

  const { data: unidades } = useQuery({
    queryKey: ["unidades-options"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("unidades")
        .select("id, nome, cnpj, uf")
        .order("nome");
      if (error) throw error;
      return (data ?? []) as {
        id: string;
        nome: string;
        cnpj: string | null;
        uf: string | null;
      }[];
    },
  });

  const [form, setForm] = useState<ProfileForm | null>(null);
  useEffect(() => {
    if (profile) {
      setForm({
        full_name: profile.full_name ?? "",
        email: profile.email ?? "",
        cpf: profile.cpf ?? "",
        matricula: profile.matricula ?? "",
        setor: profile.setor ?? "",
        operacao: profile.operacao ?? "",
        cargo: profile.cargo ?? "",
        data_admissao: profile.data_admissao ?? "",
        status: (profile.status ?? "ativo") as EmployeeStatus,
        telefone: profile.telefone ?? "",
        endereco: profile.endereco ?? "",
        contato_emergencia_nome: profile.contato_emergencia_nome ?? "",
        contato_emergencia_telefone: profile.contato_emergencia_telefone ?? "",
        salario: profile.salario != null ? String(profile.salario) : "",
        centro_custo: profile.centro_custo ?? "",
        gestor_id: profile.gestor_id ?? "",
        schedule_id: profile.schedule_id ?? "",
        tipo_ponto: profile.tipo_ponto ?? "4_batidas",
        valor_hora:
          profile.valor_hora != null ? String(profile.valor_hora) : "",
        vale_alimentacao_diario:
          profile.vale_alimentacao_diario != null
            ? String(profile.vale_alimentacao_diario)
            : "",
        beneficio_alimentacao:
          (profile.beneficio_alimentacao as "VA" | "VR") ?? "VA",
        vale_transporte_diario:
          profile.vale_transporte_diario != null
            ? String(profile.vale_transporte_diario)
            : "",
        desconto_vt_funcionario: profile.desconto_vt_funcionario ?? true,
        insalubridade_pct:
          profile.insalubridade_pct != null
            ? String(profile.insalubridade_pct)
            : "0",
        periculosidade_pct:
          profile.periculosidade_pct != null
            ? String(profile.periculosidade_pct)
            : "0",
        adicional_noturno: profile.adicional_noturno ?? false,
        plano_saude_desconto:
          profile.plano_saude_desconto != null
            ? String(profile.plano_saude_desconto)
            : "0",
        outros_descontos:
          profile.outros_descontos != null
            ? String(profile.outros_descontos)
            : "0",
        outros_proventos:
          profile.outros_proventos != null
            ? String(profile.outros_proventos)
            : "0",
        dependentes_ir:
          profile.dependentes_ir != null ? String(profile.dependentes_ir) : "0",
        desconta_inss: profile.desconta_inss ?? true,
        desconta_irrf: profile.desconta_irrf ?? true,
        data_nascimento: profile.data_nascimento ?? "",
        sexo: profile.sexo ?? "",
        estado_civil: profile.estado_civil ?? "",
        nacionalidade: profile.nacionalidade ?? "",
        naturalidade: profile.naturalidade ?? "",
        nome_mae: profile.nome_mae ?? "",
        nome_pai: profile.nome_pai ?? "",
        escolaridade: profile.escolaridade ?? "",
        raca_cor: profile.raca_cor ?? "",
        pcd: profile.pcd ?? false,
        tipo_deficiencia: profile.tipo_deficiencia ?? "",
        email_pessoal: profile.email_pessoal ?? "",
        celular: profile.celular ?? "",
        rg: profile.rg ?? "",
        rg_orgao_emissor: profile.rg_orgao_emissor ?? "",
        rg_uf: profile.rg_uf ?? "",
        rg_data_emissao: profile.rg_data_emissao ?? "",
        pis_pasep: profile.pis_pasep ?? "",
        ctps_numero: profile.ctps_numero ?? "",
        ctps_serie: profile.ctps_serie ?? "",
        ctps_uf: profile.ctps_uf ?? "",
        titulo_eleitor: profile.titulo_eleitor ?? "",
        titulo_zona: profile.titulo_zona ?? "",
        titulo_secao: profile.titulo_secao ?? "",
        reservista: profile.reservista ?? "",
        cnh_numero: profile.cnh_numero ?? "",
        cnh_categoria: profile.cnh_categoria ?? "",
        cnh_validade: profile.cnh_validade ?? "",
        cep: profile.cep ?? "",
        logradouro: profile.logradouro ?? "",
        numero_endereco: profile.numero_endereco ?? "",
        complemento: profile.complemento ?? "",
        bairro: profile.bairro ?? "",
        cidade: profile.cidade ?? "",
        uf: profile.uf ?? "",
        tipo_contrato: profile.tipo_contrato ?? "",
        regime_trabalho: profile.regime_trabalho ?? "",
        data_demissao: profile.data_demissao ?? "",
        cbo: profile.cbo ?? "",
        jornada_semanal_horas:
          profile.jornada_semanal_horas != null
            ? String(profile.jornada_semanal_horas)
            : "",
        banco: profile.banco ?? "",
        agencia: profile.agencia ?? "",
        conta: profile.conta ?? "",
        tipo_conta: profile.tipo_conta ?? "",
        chave_pix: profile.chave_pix ?? "",
        tipo_chave_pix: profile.tipo_chave_pix ?? "",
        unidade_id: profile.unidade_id ?? "",
        vt_beneficio_codigo: profile.vt_beneficio_codigo ?? "",
        vt_quantidade_diaria:
          profile.vt_quantidade_diaria != null
            ? String(profile.vt_quantidade_diaria)
            : "",
        vt_tipo_valor: profile.vt_tipo_valor ?? "",
        vt_rede_recarga: profile.vt_rede_recarga ?? "",
        va_quantidade_diaria:
          profile.va_quantidade_diaria != null
            ? String(profile.va_quantidade_diaria)
            : "",
      });
    }
  }, [profile]);

  const save = async () => {
    if (!form) return;
    // E-mail (login) é atualizado à parte, pois altera app_users + profiles.
    const emailChanged =
      !!form.email.trim() &&
      !!profile &&
      form.email.trim().toLowerCase() !== (profile.email ?? "").toLowerCase();
    if (emailChanged) {
      try {
        await updateEmail({ data: { user_id: id, email: form.email.trim() } });
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Erro ao alterar e-mail");
        return;
      }
    }
    const { error } = await supabase
      .from("profiles")
      .update({
        full_name: form.full_name || null,
        cpf: form.cpf || null,
        matricula: form.matricula || null,
        setor: form.setor || null,
        operacao: form.operacao || null,
        cargo: form.cargo || null,
        data_admissao: form.data_admissao || null,
        status: form.status,
        telefone: form.telefone || null,
        endereco: form.endereco || null,
        contato_emergencia_nome: form.contato_emergencia_nome || null,
        contato_emergencia_telefone: form.contato_emergencia_telefone || null,
        salario: form.salario ? Number(form.salario) : null,
        centro_custo: form.centro_custo || null,
        gestor_id: form.gestor_id || null,
        schedule_id: form.schedule_id || null,
        tipo_ponto: form.tipo_ponto,
        valor_hora: form.valor_hora ? Number(form.valor_hora) : null,
        vale_alimentacao_diario: Number(form.vale_alimentacao_diario || 0),
        beneficio_alimentacao: form.beneficio_alimentacao,
        vale_transporte_diario: Number(form.vale_transporte_diario || 0),
        desconto_vt_funcionario: form.desconto_vt_funcionario,
        insalubridade_pct: Number(form.insalubridade_pct || 0),
        periculosidade_pct: Number(form.periculosidade_pct || 0),
        adicional_noturno: form.adicional_noturno,
        plano_saude_desconto: Number(form.plano_saude_desconto || 0),
        outros_descontos: Number(form.outros_descontos || 0),
        outros_proventos: Number(form.outros_proventos || 0),
        dependentes_ir: Number(form.dependentes_ir || 0),
        desconta_inss: form.desconta_inss,
        desconta_irrf: form.desconta_irrf,
        data_nascimento: form.data_nascimento || null,
        sexo: form.sexo || null,
        estado_civil: form.estado_civil || null,
        nacionalidade: form.nacionalidade || null,
        naturalidade: form.naturalidade || null,
        nome_mae: form.nome_mae || null,
        nome_pai: form.nome_pai || null,
        escolaridade: form.escolaridade || null,
        raca_cor: form.raca_cor || null,
        pcd: form.pcd,
        tipo_deficiencia: form.tipo_deficiencia || null,
        email_pessoal: form.email_pessoal || null,
        celular: form.celular || null,
        rg: form.rg || null,
        rg_orgao_emissor: form.rg_orgao_emissor || null,
        rg_uf: form.rg_uf || null,
        rg_data_emissao: form.rg_data_emissao || null,
        pis_pasep: form.pis_pasep || null,
        ctps_numero: form.ctps_numero || null,
        ctps_serie: form.ctps_serie || null,
        ctps_uf: form.ctps_uf || null,
        titulo_eleitor: form.titulo_eleitor || null,
        titulo_zona: form.titulo_zona || null,
        titulo_secao: form.titulo_secao || null,
        reservista: form.reservista || null,
        cnh_numero: form.cnh_numero || null,
        cnh_categoria: form.cnh_categoria || null,
        cnh_validade: form.cnh_validade || null,
        cep: form.cep || null,
        logradouro: form.logradouro || null,
        numero_endereco: form.numero_endereco || null,
        complemento: form.complemento || null,
        bairro: form.bairro || null,
        cidade: form.cidade || null,
        uf: form.uf || null,
        tipo_contrato: form.tipo_contrato || null,
        regime_trabalho: form.regime_trabalho || null,
        data_demissao: form.data_demissao || null,
        cbo: form.cbo || null,
        jornada_semanal_horas: form.jornada_semanal_horas
          ? Number(form.jornada_semanal_horas)
          : null,
        banco: form.banco || null,
        agencia: form.agencia || null,
        conta: form.conta || null,
        tipo_conta: form.tipo_conta || null,
        chave_pix: form.chave_pix || null,
        tipo_chave_pix: form.tipo_chave_pix || null,
        unidade_id: form.unidade_id || null,
        vt_beneficio_codigo: form.vt_beneficio_codigo || null,
        vt_quantidade_diaria: form.vt_quantidade_diaria
          ? Number(form.vt_quantidade_diaria)
          : null,
        vt_tipo_valor: form.vt_tipo_valor || null,
        vt_rede_recarga: form.vt_rede_recarga || null,
        va_quantidade_diaria: form.va_quantidade_diaria
          ? Number(form.va_quantidade_diaria)
          : null,
      })
      .eq("id", id);
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success("Dados atualizados");
    qc.invalidateQueries({ queryKey: ["funcionario", id] });
    qc.invalidateQueries({ queryKey: ["funcionarios"] });
  };

  if (isLoading || !form) {
    return (
      <div className="p-10 text-center text-muted-foreground">
        Carregando...
      </div>
    );
  }

  return (
    <div className="space-y-6 animate-in-up">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3">
          <Link
            to="/rh/funcionarios"
            className="text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="size-4" />
          </Link>
          <div>
            <h1 className="text-2xl md:text-3xl font-extrabold tracking-tight">
              {form.full_name || form.email}
            </h1>
            <p className="text-xs font-mono text-muted-foreground mt-1">
              {form.cargo || "—"} · {form.setor || "—"}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="secondary" className="capitalize">
            {STATUS_LABEL[form.status]}
          </Badge>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setConfirmReset(true)}
          >
            <KeyRound className="size-3.5 mr-1" /> Resetar senha
          </Button>
          {isAdmin && user?.id !== id && (
            <Button
              size="sm"
              variant="destructive"
              onClick={() => setConfirmDel(true)}
            >
              <Trash2 className="size-3.5 mr-1" /> Excluir
            </Button>
          )}
        </div>
      </div>

      <Dialog
        open={confirmReset}
        onOpenChange={(o) => !o && setConfirmReset(false)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Redefinir senha</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            Defina uma senha temporária forte para{" "}
            <strong>{form.full_name || form.email}</strong>. Todas as sessões
            anteriores serão revogadas.
          </p>
          <div className="space-y-1">
            <Label>Nova senha temporária</Label>
            <Input
              type="password"
              value={newPassword}
              onChange={(event) => setNewPassword(event.target.value)}
              minLength={12}
              maxLength={72}
              placeholder="12+ caracteres, Aa, número e símbolo"
            />
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setConfirmReset(false)}
              disabled={resetting}
            >
              Cancelar
            </Button>
            <Button
              onClick={onResetPassword}
              disabled={resetting || newPassword.length < 12}
            >
              {resetting ? "Redefinindo..." : "Redefinir senha"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={confirmDel} onOpenChange={setConfirmDel}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Excluir funcionário</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            Tem certeza que deseja excluir{" "}
            <strong>{form.full_name || form.email}</strong>? Esta ação é
            permanente.
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmDel(false)}>
              Cancelar
            </Button>
            <Button
              variant="destructive"
              onClick={async () => {
                try {
                  await deleteUser({ data: { user_id: id } });
                  toast.success("Funcionário excluído");
                  qc.invalidateQueries({ queryKey: ["funcionarios"] });
                  nav({ to: "/rh/funcionarios" });
                } catch (e) {
                  toast.error(e instanceof Error ? e.message : "Erro");
                }
              }}
            >
              Excluir
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Tabs defaultValue="dados">
        <TabsList>
          <TabsTrigger value="dados">Dados</TabsTrigger>
          <TabsTrigger value="ponto">Ponto</TabsTrigger>
          <TabsTrigger value="documentos">Documentos</TabsTrigger>
          <TabsTrigger value="atestados">Atestados</TabsTrigger>
        </TabsList>

        <TabsContent value="dados" className="mt-6 space-y-6">
          <Section title="Identificação">
            <Grid>
              <FieldText
                label="Nome completo"
                value={form.full_name}
                onChange={(v) => setForm({ ...form, full_name: v })}
              />
              <FieldText
                label="E-mail (login)"
                type="email"
                value={form.email}
                onChange={(v) => setForm({ ...form, email: v })}
              />
              <FieldText
                label="CPF"
                value={form.cpf}
                onChange={(v) => setForm({ ...form, cpf: v })}
              />
              <FieldText
                label="Matrícula"
                value={form.matricula}
                onChange={(v) => setForm({ ...form, matricula: v })}
              />
            </Grid>
          </Section>

          <Section title="Dados pessoais">
            <Grid>
              <FieldText
                label="Data de nascimento"
                type="date"
                value={form.data_nascimento}
                onChange={(v) => setForm({ ...form, data_nascimento: v })}
              />
              <FieldSelect
                label="Sexo"
                value={form.sexo}
                options={SEXO_OPTS}
                onChange={(v) => setForm({ ...form, sexo: v })}
              />
              <FieldSelect
                label="Estado civil"
                value={form.estado_civil}
                options={ESTADO_CIVIL_OPTS}
                onChange={(v) => setForm({ ...form, estado_civil: v })}
              />
              <FieldText
                label="Nacionalidade"
                value={form.nacionalidade}
                onChange={(v) => setForm({ ...form, nacionalidade: v })}
              />
              <FieldText
                label="Naturalidade (cidade/UF)"
                value={form.naturalidade}
                onChange={(v) => setForm({ ...form, naturalidade: v })}
              />
              <FieldSelect
                label="Escolaridade"
                value={form.escolaridade}
                options={ESCOLARIDADE_OPTS}
                onChange={(v) => setForm({ ...form, escolaridade: v })}
              />
              <FieldSelect
                label="Raça/cor"
                value={form.raca_cor}
                options={RACA_COR_OPTS}
                onChange={(v) => setForm({ ...form, raca_cor: v })}
              />
              <FieldText
                label="Nome da mãe"
                value={form.nome_mae}
                onChange={(v) => setForm({ ...form, nome_mae: v })}
              />
              <FieldText
                label="Nome do pai"
                value={form.nome_pai}
                onChange={(v) => setForm({ ...form, nome_pai: v })}
              />
              <FieldToggle
                label="Pessoa com deficiência (PCD)"
                checked={form.pcd}
                onChange={(v) => setForm({ ...form, pcd: v })}
              />
              {form.pcd && (
                <FieldText
                  label="Tipo de deficiência"
                  value={form.tipo_deficiencia}
                  onChange={(v) => setForm({ ...form, tipo_deficiencia: v })}
                />
              )}
            </Grid>
          </Section>

          <Section title="Documentos">
            <Grid>
              <FieldText
                label="RG"
                value={form.rg}
                onChange={(v) => setForm({ ...form, rg: v })}
              />
              <FieldText
                label="RG — órgão emissor"
                value={form.rg_orgao_emissor}
                onChange={(v) => setForm({ ...form, rg_orgao_emissor: v })}
              />
              <FieldSelect
                label="RG — UF"
                value={form.rg_uf}
                options={UF_OPTS}
                onChange={(v) => setForm({ ...form, rg_uf: v })}
              />
              <FieldText
                label="RG — data de emissão"
                type="date"
                value={form.rg_data_emissao}
                onChange={(v) => setForm({ ...form, rg_data_emissao: v })}
              />
              <FieldText
                label="PIS/PASEP (NIT)"
                value={form.pis_pasep}
                onChange={(v) => setForm({ ...form, pis_pasep: v })}
              />
              <FieldText
                label="CTPS — número"
                value={form.ctps_numero}
                onChange={(v) => setForm({ ...form, ctps_numero: v })}
              />
              <FieldText
                label="CTPS — série"
                value={form.ctps_serie}
                onChange={(v) => setForm({ ...form, ctps_serie: v })}
              />
              <FieldSelect
                label="CTPS — UF"
                value={form.ctps_uf}
                options={UF_OPTS}
                onChange={(v) => setForm({ ...form, ctps_uf: v })}
              />
              <FieldText
                label="Título de eleitor"
                value={form.titulo_eleitor}
                onChange={(v) => setForm({ ...form, titulo_eleitor: v })}
              />
              <FieldText
                label="Título — zona"
                value={form.titulo_zona}
                onChange={(v) => setForm({ ...form, titulo_zona: v })}
              />
              <FieldText
                label="Título — seção"
                value={form.titulo_secao}
                onChange={(v) => setForm({ ...form, titulo_secao: v })}
              />
              <FieldText
                label="Reservista"
                value={form.reservista}
                onChange={(v) => setForm({ ...form, reservista: v })}
              />
              <FieldText
                label="CNH — número"
                value={form.cnh_numero}
                onChange={(v) => setForm({ ...form, cnh_numero: v })}
              />
              <FieldSelect
                label="CNH — categoria"
                value={form.cnh_categoria}
                options={CNH_CAT_OPTS}
                onChange={(v) => setForm({ ...form, cnh_categoria: v })}
              />
              <FieldText
                label="CNH — validade"
                type="date"
                value={form.cnh_validade}
                onChange={(v) => setForm({ ...form, cnh_validade: v })}
              />
            </Grid>
          </Section>

          <Section title="Profissional">
            <Grid>
              <FieldText
                label="Cargo"
                value={form.cargo}
                onChange={(v) => setForm({ ...form, cargo: v })}
              />
              <FieldText
                label="Setor"
                value={form.setor}
                onChange={(v) => setForm({ ...form, setor: v })}
              />
              <FieldText
                label="Operação"
                value={form.operacao}
                onChange={(v) => setForm({ ...form, operacao: v })}
              />
              <FieldText
                label="Data de admissão"
                type="date"
                value={form.data_admissao}
                onChange={(v) => setForm({ ...form, data_admissao: v })}
              />
              <div className="space-y-1.5">
                <Label className="text-[11px] font-bold uppercase text-muted-foreground">
                  Status
                </Label>
                <Select
                  value={form.status}
                  onValueChange={(v) =>
                    setForm({ ...form, status: v as EmployeeStatus })
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(Object.keys(STATUS_LABEL) as EmployeeStatus[]).map(
                      (s) => (
                        <SelectItem key={s} value={s}>
                          {STATUS_LABEL[s]}
                        </SelectItem>
                      ),
                    )}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label className="text-[11px] font-bold uppercase text-muted-foreground">
                  Gestor responsável
                </Label>
                <Select
                  value={form.gestor_id || "none"}
                  onValueChange={(v) =>
                    setForm({ ...form, gestor_id: v === "none" ? "" : v })
                  }
                >
                  <SelectTrigger>
                    <SelectValue placeholder="—" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">Sem gestor</SelectItem>
                    {(gestores ?? [])
                      .filter((g) => g.id !== id)
                      .map((g) => (
                        <SelectItem key={g.id} value={g.id}>
                          {g.full_name || g.email}
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
              </div>
            </Grid>
          </Section>

          <Section title="Dados contratuais">
            <Grid>
              <FieldSelect
                label="Tipo de contrato"
                value={form.tipo_contrato}
                options={TIPO_CONTRATO_OPTS}
                onChange={(v) => setForm({ ...form, tipo_contrato: v })}
              />
              <FieldSelect
                label="Regime de trabalho"
                value={form.regime_trabalho}
                options={REGIME_OPTS}
                onChange={(v) => setForm({ ...form, regime_trabalho: v })}
              />
              <FieldText
                label="CBO (código do cargo)"
                value={form.cbo}
                onChange={(v) => setForm({ ...form, cbo: v })}
              />
              <FieldText
                label="Jornada semanal (horas)"
                type="number"
                value={form.jornada_semanal_horas}
                onChange={(v) => setForm({ ...form, jornada_semanal_horas: v })}
              />
              <FieldText
                label="Data de demissão"
                type="date"
                value={form.data_demissao}
                onChange={(v) => setForm({ ...form, data_demissao: v })}
              />
            </Grid>
          </Section>

          <Section title="Contato">
            <Grid>
              <FieldText
                label="Telefone"
                value={form.telefone}
                onChange={(v) => setForm({ ...form, telefone: v })}
              />
              <FieldText
                label="Celular"
                value={form.celular}
                onChange={(v) => setForm({ ...form, celular: v })}
              />
              <FieldText
                label="E-mail pessoal"
                type="email"
                value={form.email_pessoal}
                onChange={(v) => setForm({ ...form, email_pessoal: v })}
              />
              <FieldText
                label="Contato emergência (nome)"
                value={form.contato_emergencia_nome}
                onChange={(v) =>
                  setForm({ ...form, contato_emergencia_nome: v })
                }
              />
              <FieldText
                label="Contato emergência (telefone)"
                value={form.contato_emergencia_telefone}
                onChange={(v) =>
                  setForm({ ...form, contato_emergencia_telefone: v })
                }
              />
            </Grid>
          </Section>

          <Section title="Endereço">
            <Grid>
              <FieldText
                label="CEP"
                value={form.cep}
                onChange={(v) => setForm({ ...form, cep: v })}
              />
              <FieldText
                label="Logradouro"
                value={form.logradouro}
                onChange={(v) => setForm({ ...form, logradouro: v })}
              />
              <FieldText
                label="Número"
                value={form.numero_endereco}
                onChange={(v) => setForm({ ...form, numero_endereco: v })}
              />
              <FieldText
                label="Complemento"
                value={form.complemento}
                onChange={(v) => setForm({ ...form, complemento: v })}
              />
              <FieldText
                label="Bairro"
                value={form.bairro}
                onChange={(v) => setForm({ ...form, bairro: v })}
              />
              <FieldText
                label="Cidade"
                value={form.cidade}
                onChange={(v) => setForm({ ...form, cidade: v })}
              />
              <FieldSelect
                label="UF"
                value={form.uf}
                options={UF_OPTS}
                onChange={(v) => setForm({ ...form, uf: v })}
              />
              <FieldText
                label="Endereço (linha única / referência)"
                value={form.endereco}
                onChange={(v) => setForm({ ...form, endereco: v })}
              />
            </Grid>
          </Section>

          <Section title="Financeiro · RH">
            <Grid>
              <FieldText
                label="Salário"
                type="number"
                value={form.salario}
                onChange={(v) => setForm({ ...form, salario: v })}
              />
              <FieldText
                label="Valor hora"
                type="number"
                value={form.valor_hora}
                onChange={(v) => setForm({ ...form, valor_hora: v })}
              />
              <FieldText
                label="Centro de custo"
                value={form.centro_custo}
                onChange={(v) => setForm({ ...form, centro_custo: v })}
              />
              <div className="space-y-1.5">
                <Label className="text-[11px] font-bold uppercase text-muted-foreground">
                  Escala
                </Label>
                <Select
                  value={form.schedule_id || "none"}
                  onValueChange={(v) =>
                    setForm({ ...form, schedule_id: v === "none" ? "" : v })
                  }
                >
                  <SelectTrigger>
                    <SelectValue placeholder="—" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">Sem escala</SelectItem>
                    {(schedules ?? []).map((s) => (
                      <SelectItem key={s.id} value={s.id}>
                        {s.nome} · {s.carga_horaria_mensal}h
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label className="text-[11px] font-bold uppercase text-muted-foreground">
                  Tipo de ponto
                </Label>
                <Select
                  value={form.tipo_ponto}
                  onValueChange={(v) =>
                    setForm({
                      ...form,
                      tipo_ponto: v as "2_batidas" | "4_batidas",
                    })
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="2_batidas">2 batidas</SelectItem>
                    <SelectItem value="4_batidas">4 batidas</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </Grid>
          </Section>

          <Section title="Dados bancários">
            <Grid>
              <FieldText
                label="Banco"
                value={form.banco}
                onChange={(v) => setForm({ ...form, banco: v })}
              />
              <FieldText
                label="Agência"
                value={form.agencia}
                onChange={(v) => setForm({ ...form, agencia: v })}
              />
              <FieldText
                label="Conta"
                value={form.conta}
                onChange={(v) => setForm({ ...form, conta: v })}
              />
              <FieldSelect
                label="Tipo de conta"
                value={form.tipo_conta}
                options={TIPO_CONTA_OPTS}
                onChange={(v) => setForm({ ...form, tipo_conta: v })}
              />
              <FieldText
                label="Chave PIX"
                value={form.chave_pix}
                onChange={(v) => setForm({ ...form, chave_pix: v })}
              />
              <FieldSelect
                label="Tipo da chave PIX"
                value={form.tipo_chave_pix}
                options={TIPO_CHAVE_PIX_OPTS}
                onChange={(v) => setForm({ ...form, tipo_chave_pix: v })}
              />
            </Grid>
          </Section>

          <Section title="Benefícios">
            <p className="text-xs text-muted-foreground -mt-2 mb-4">
              O <strong>valor unitário</strong> vem do vale diário e os{" "}
              <strong>dias trabalhados</strong> do ponto do mês. O VA/VR é
              exportado em XLSX; o VT, no CSV da operadora de transporte.
            </p>
            <Grid>
              <div className="space-y-1.5">
                <Label className="text-[11px] font-bold uppercase text-muted-foreground">
                  Opção do colaborador (VA ou VR)
                </Label>
                <Select
                  value={form.beneficio_alimentacao}
                  onValueChange={(v) =>
                    setForm({
                      ...form,
                      beneficio_alimentacao: v as "VA" | "VR",
                    })
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="VA">VA — Vale Alimentação</SelectItem>
                    <SelectItem value="VR">VR — Vale Refeição</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <FieldText
                label="VA/VR — valor por dia (R$)"
                type="number"
                value={form.vale_alimentacao_diario}
                onChange={(v) =>
                  setForm({ ...form, vale_alimentacao_diario: v })
                }
              />
              <FieldText
                label="VA/VR — quantidade diária"
                type="number"
                value={form.va_quantidade_diaria}
                onChange={(v) => setForm({ ...form, va_quantidade_diaria: v })}
              />

              <FieldText
                label="VT — valor por dia (R$)"
                type="number"
                value={form.vale_transporte_diario}
                onChange={(v) =>
                  setForm({ ...form, vale_transporte_diario: v })
                }
              />
              <FieldText
                label="VT — quantidade diária"
                type="number"
                value={form.vt_quantidade_diaria}
                onChange={(v) => setForm({ ...form, vt_quantidade_diaria: v })}
              />
              <FieldToggle
                label="Descontar 6% de VT (CLT)"
                checked={form.desconto_vt_funcionario}
                onChange={(v) =>
                  setForm({ ...form, desconto_vt_funcionario: v })
                }
              />

              <div className="space-y-1.5 md:col-span-2">
                <Label className="text-[11px] font-bold uppercase text-muted-foreground">
                  Unidade (empresa)
                </Label>
                <Select
                  value={form.unidade_id || "none"}
                  onValueChange={(v) =>
                    setForm({ ...form, unidade_id: v === "none" ? "" : v })
                  }
                >
                  <SelectTrigger>
                    <SelectValue placeholder="—" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">Sem unidade</SelectItem>
                    {(unidades ?? []).map((u) => (
                      <SelectItem key={u.id} value={u.id}>
                        {u.nome}
                        {u.uf ? ` · ${u.uf}` : ""}
                        {u.cnpj ? ` · ${u.cnpj}` : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <FieldText
                label="VT — código do benefício"
                value={form.vt_beneficio_codigo}
                onChange={(v) => setForm({ ...form, vt_beneficio_codigo: v })}
              />
              <FieldText
                label="VT — tipo valor (opcional)"
                value={form.vt_tipo_valor}
                onChange={(v) => setForm({ ...form, vt_tipo_valor: v })}
              />
              <FieldText
                label="VT — rede de recarga (opcional)"
                value={form.vt_rede_recarga}
                onChange={(v) => setForm({ ...form, vt_rede_recarga: v })}
              />
            </Grid>
          </Section>

          <Section title="Folha · Adicionais">
            <Grid>
              <FieldText
                label="Insalubridade (% sobre salário mínimo)"
                type="number"
                value={form.insalubridade_pct}
                onChange={(v) => setForm({ ...form, insalubridade_pct: v })}
              />
              <FieldText
                label="Periculosidade (% sobre salário base)"
                type="number"
                value={form.periculosidade_pct}
                onChange={(v) => setForm({ ...form, periculosidade_pct: v })}
              />
              <FieldToggle
                label="Adicional noturno (22h-5h, +20%)"
                checked={form.adicional_noturno}
                onChange={(v) => setForm({ ...form, adicional_noturno: v })}
              />
              <FieldText
                label="Outros proventos (R$)"
                type="number"
                value={form.outros_proventos}
                onChange={(v) => setForm({ ...form, outros_proventos: v })}
              />
            </Grid>
          </Section>

          <Section title="Folha · Descontos e tributação">
            <Grid>
              <FieldText
                label="Plano de saúde (R$)"
                type="number"
                value={form.plano_saude_desconto}
                onChange={(v) => setForm({ ...form, plano_saude_desconto: v })}
              />
              <FieldText
                label="Outros descontos (R$)"
                type="number"
                value={form.outros_descontos}
                onChange={(v) => setForm({ ...form, outros_descontos: v })}
              />
              <FieldText
                label="Dependentes para IR"
                type="number"
                value={form.dependentes_ir}
                onChange={(v) => setForm({ ...form, dependentes_ir: v })}
              />
              <FieldToggle
                label="Descontar INSS"
                checked={form.desconta_inss}
                onChange={(v) => setForm({ ...form, desconta_inss: v })}
              />
              <FieldToggle
                label="Descontar IRRF"
                checked={form.desconta_irrf}
                onChange={(v) => setForm({ ...form, desconta_irrf: v })}
              />
            </Grid>
          </Section>

          <div className="flex justify-end">
            <Button onClick={save} className="font-semibold">
              <Save className="size-4 mr-2" /> Salvar alterações
            </Button>
          </div>
        </TabsContent>

        <TabsContent value="ponto" className="mt-6">
          <PontoPanel userId={id} />
        </TabsContent>

        <TabsContent value="documentos" className="mt-6">
          <DocumentsPanel userId={id} reviewerId={user?.id ?? ""} />
        </TabsContent>

        <TabsContent value="atestados" className="mt-6">
          <AtestadosPanel userId={id} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="bg-card border border-border rounded-2xl p-5 md:p-6 shadow-sm">
      <h3 className="font-bold text-xs uppercase tracking-widest text-muted-foreground mb-4">
        {title}
      </h3>
      {children}
    </div>
  );
}

function Grid({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">{children}</div>
  );
}

function FieldText({
  label,
  value,
  onChange,
  type = "text",
  disabled = false,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  disabled?: boolean;
}) {
  return (
    <div className="space-y-1.5">
      <Label className="text-[11px] font-bold uppercase text-muted-foreground">
        {label}
      </Label>
      <Input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
      />
    </div>
  );
}

function FieldToggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex items-center gap-2 rounded-md border border-border px-3 py-2 cursor-pointer select-none">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="size-4 accent-primary"
      />
      <span className="text-xs font-medium">{label}</span>
    </label>
  );
}

function FieldSelect({
  label,
  value,
  onChange,
  options,
  placeholder = "—",
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: string[];
  placeholder?: string;
}) {
  return (
    <div className="space-y-1.5">
      <Label className="text-[11px] font-bold uppercase text-muted-foreground">
        {label}
      </Label>
      <Select
        value={value || "none"}
        onValueChange={(v) => onChange(v === "none" ? "" : v)}
      >
        <SelectTrigger>
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="none">—</SelectItem>
          {options.map((o) => (
            <SelectItem key={o} value={o}>
              {o}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

const BATIDA_OPTS: { value: string; label: string }[] = [
  { value: "entrada", label: "Entrada" },
  { value: "saida_almoco", label: "Saída p/ intervalo" },
  { value: "volta_almoco", label: "Volta do intervalo" },
  { value: "saida", label: "Saída" },
];
const BATIDA_LABEL: Record<string, string> = Object.fromEntries(
  BATIDA_OPTS.map((o) => [o.value, o.label]),
);

function pad2(n: number) {
  return String(n).padStart(2, "0");
}
/** ISO -> valor de <input type="datetime-local"> em horário local. */
function toLocalInput(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

type PontoEntry = TimeEntry & {
  id: string;
  observacao: string | null;
  origem: string | null;
};
type EntryTipo = "entrada" | "saida_almoco" | "volta_almoco" | "saida";
type EntryEdit = {
  id?: string;
  entry_local: string;
  tipo: string;
  observacao: string;
};

function PontoPanel({ userId }: { userId: string }) {
  const qc = useQueryClient();
  const { activeTenant } = useAuth();
  const registerEntry = useServerFn(registerManualTimeEntry);
  const updateEntry = useServerFn(updateManualTimeEntry);
  const softDeleteEntry = useServerFn(softDeleteTimeEntry);
  const [refMonth, setRefMonth] = useState(() =>
    new Date().toISOString().slice(0, 7),
  );
  const [edit, setEdit] = useState<EntryEdit | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmDel, setConfirmDel] = useState<PontoEntry | null>(null);
  const [delReason, setDelReason] = useState("");

  const monthStart = new Date(refMonth + "-01T00:00:00");
  const monthEnd = new Date(monthStart);
  monthEnd.setMonth(monthEnd.getMonth() + 1);

  const { data: entries } = useQuery({
    queryKey: ["ponto-rh", userId, refMonth],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("time_entries")
        .select("*")
        .eq("user_id", userId)
        .gte("entry_at", monthStart.toISOString())
        .lt("entry_at", monthEnd.toISOString())
        .order("entry_at");
      if (error) throw error;
      return (data ?? []) as PontoEntry[];
    },
  });

  const dias = useMemo(() => {
    const byDay = new Map<string, PontoEntry[]>();
    for (const e of entries ?? []) {
      const d = new Date(e.entry_at);
      const key = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
      if (!byDay.has(key)) byDay.set(key, []);
      byDay.get(key)!.push(e);
    }
    return [...byDay.entries()].sort((a, b) => b[0].localeCompare(a[0]));
  }, [entries]);

  const novo = () => {
    const now = new Date();
    setEdit({
      entry_local: `${refMonth}-${pad2(now.getDate())}T08:00`,
      tipo: "entrada",
      observacao: "",
    });
  };

  const salvar = async () => {
    if (!edit) return;
    if (!edit.entry_local) {
      toast.error("Informe data e hora");
      return;
    }
    const dt = new Date(edit.entry_local);
    if (Number.isNaN(dt.getTime())) {
      toast.error("Data/hora inválida");
      return;
    }
    if (!activeTenant) {
      toast.error("Selecione uma entidade ativa");
      return;
    }
    setBusy(true);
    try {
      if (edit.id) {
        await updateEntry({
          data: {
            tenant_id: activeTenant.id,
            id: edit.id,
            tipo: edit.tipo as EntryTipo,
            entry_at: dt.toISOString(),
            observacao: edit.observacao || null,
          },
        });
      } else {
        await registerEntry({
          data: {
            tenant_id: activeTenant.id,
            user_id: userId,
            tipo: edit.tipo as EntryTipo,
            entry_at: dt.toISOString(),
            observacao: edit.observacao || null,
          },
        });
      }
      toast.success(edit.id ? "Batida atualizada" : "Batida inserida");
      setEdit(null);
      qc.invalidateQueries({ queryKey: ["ponto-rh", userId] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Erro ao salvar");
    } finally {
      setBusy(false);
    }
  };

  const excluir = async () => {
    if (!confirmDel) return;
    if (!activeTenant) {
      toast.error("Selecione uma entidade ativa");
      return;
    }
    if (delReason.trim().length < 5) {
      toast.error("Informe o motivo da exclusão (mín. 5 caracteres)");
      return;
    }
    setBusy(true);
    try {
      await softDeleteEntry({
        data: {
          tenant_id: activeTenant.id,
          id: confirmDel.id,
          reason: delReason.trim(),
        },
      });
      toast.success("Batida excluída");
      setConfirmDel(null);
      setDelReason("");
      qc.invalidateQueries({ queryKey: ["ponto-rh", userId] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Erro ao excluir");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-2">
          <Clock className="size-5 text-primary" />
          <div>
            <h2 className="font-bold text-sm">Ponto do colaborador</h2>
            <p className="text-xs text-muted-foreground">
              Inserção e ajuste manual de batidas (RH/Admin).
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <Label className="text-xs">Mês</Label>
          <Input
            type="month"
            value={refMonth}
            onChange={(e) => setRefMonth(e.target.value)}
            className="w-40"
          />
          <Button size="sm" onClick={novo}>
            <Plus className="size-3.5 mr-1" /> Nova batida
          </Button>
        </div>
      </div>

      {!dias.length && (
        <div className="bg-card border border-border rounded-2xl p-10 text-center text-sm text-muted-foreground">
          Nenhuma batida neste mês.
        </div>
      )}

      <div className="space-y-3">
        {dias.map(([dia, es]) => {
          const worked = workedMinutesForDay(es);
          const [y, m, d] = dia.split("-");
          const label = new Date(
            Number(y),
            Number(m) - 1,
            Number(d),
          ).toLocaleDateString("pt-BR", {
            weekday: "short",
            day: "2-digit",
            month: "2-digit",
          });
          return (
            <div
              key={dia}
              className="bg-card border border-border rounded-2xl overflow-hidden shadow-sm"
            >
              <div className="px-4 py-2.5 border-b border-border bg-muted/30 flex items-center justify-between">
                <span className="font-semibold text-sm capitalize">
                  {label}
                </span>
                <span className="text-xs font-mono text-muted-foreground">
                  {Math.floor(worked / 60)}h{pad2(worked % 60)} trabalhadas
                </span>
              </div>
              <div className="flex flex-wrap gap-3 p-4">
                {es.map((e) => (
                  <div
                    key={e.id}
                    className="flex flex-col gap-1.5 rounded-lg border border-border bg-muted/20 px-3 py-2.5 min-w-[150px] flex-1"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
                        {BATIDA_LABEL[e.tipo] ?? e.tipo}
                      </span>
                      {e.origem === "manual" && (
                        <Badge
                          variant="secondary"
                          className="text-[9px] px-1 py-0"
                        >
                          manual
                        </Badge>
                      )}
                    </div>
                    <span className="font-mono text-xl font-semibold leading-none">
                      {new Date(e.entry_at).toLocaleTimeString("pt-BR", {
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </span>
                    {e.observacao && (
                      <span
                        className="text-[11px] text-muted-foreground truncate"
                        title={e.observacao}
                      >
                        {e.observacao}
                      </span>
                    )}
                    <div className="flex items-center gap-1.5 pt-1">
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 flex-1"
                        onClick={() =>
                          setEdit({
                            id: e.id,
                            entry_local: toLocalInput(e.entry_at),
                            tipo: e.tipo,
                            observacao: e.observacao ?? "",
                          })
                        }
                      >
                        <Pencil className="size-3" />
                      </Button>
                      <Button
                        size="sm"
                        variant="destructive"
                        className="h-7 flex-1"
                        onClick={() => setConfirmDel(e)}
                      >
                        <Trash2 className="size-3" />
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>

      <Dialog open={!!edit} onOpenChange={(o) => !o && setEdit(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {edit?.id ? "Editar batida" : "Nova batida"}
            </DialogTitle>
          </DialogHeader>
          {edit && (
            <div className="space-y-4">
              <div className="space-y-1.5">
                <Label className="text-[11px] font-bold uppercase text-muted-foreground">
                  Data e hora
                </Label>
                <Input
                  type="datetime-local"
                  value={edit.entry_local}
                  onChange={(ev) =>
                    setEdit({ ...edit, entry_local: ev.target.value })
                  }
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-[11px] font-bold uppercase text-muted-foreground">
                  Tipo de batida
                </Label>
                <Select
                  value={edit.tipo}
                  onValueChange={(v) => setEdit({ ...edit, tipo: v })}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {BATIDA_OPTS.map((o) => (
                      <SelectItem key={o.value} value={o.value}>
                        {o.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label className="text-[11px] font-bold uppercase text-muted-foreground">
                  Observação (opcional)
                </Label>
                <Textarea
                  rows={2}
                  maxLength={300}
                  value={edit.observacao}
                  onChange={(ev) =>
                    setEdit({ ...edit, observacao: ev.target.value })
                  }
                  placeholder="Ex.: ajuste manual — esquecimento de batida"
                />
              </div>
              <p className="text-[11px] text-muted-foreground">
                Batidas inseridas/alteradas aqui ficam marcadas como{" "}
                <strong>manual</strong> e registram quem fez o ajuste.
              </p>
            </div>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setEdit(null)}
              disabled={busy}
            >
              Cancelar
            </Button>
            <Button onClick={salvar} disabled={busy}>
              {busy ? "Salvando…" : "Salvar"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={!!confirmDel}
        onOpenChange={(o) => {
          if (!o) {
            setConfirmDel(null);
            setDelReason("");
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Excluir batida</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            Excluir a batida de{" "}
            <strong>{confirmDel && BATIDA_LABEL[confirmDel.tipo]}</strong> às{" "}
            <strong>
              {confirmDel &&
                new Date(confirmDel.entry_at).toLocaleString("pt-BR")}
            </strong>
            ? A batida sai da apuração, mas o registro e o motivo ficam na
            trilha de auditoria.
          </p>
          <div className="space-y-1.5">
            <Label htmlFor="del-reason">Motivo da exclusão</Label>
            <Textarea
              id="del-reason"
              value={delReason}
              onChange={(e) => setDelReason(e.target.value)}
              placeholder="Ex.: batida duplicada por falha de rede"
              rows={2}
            />
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setConfirmDel(null)}
              disabled={busy}
            >
              Cancelar
            </Button>
            <Button variant="destructive" onClick={excluir} disabled={busy}>
              {busy ? "Excluindo…" : "Excluir"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function DocumentsPanel({
  userId,
  reviewerId,
}: {
  userId: string;
  reviewerId: string;
}) {
  const qc = useQueryClient();
  const uploadDoc = useServerFn(rhUploadEmployeeDocument);
  const [reviewing, setReviewing] = useState<{
    id: string;
    tipo: string;
    action: "aprovado" | "rejeitado";
  } | null>(null);
  const [obs, setObs] = useState("");
  const insertFileRef = useRef<HTMLInputElement>(null);
  const [insert, setInsert] = useState<{
    tipo: string;
    categoria: DocumentoCategoria;
    descricao: string;
    file: File | null;
    busy: boolean;
  } | null>(null);

  const submitInsert = async () => {
    if (!insert || !insert.file || !insert.tipo.trim()) {
      toast.error("Informe o tipo e selecione um arquivo");
      return;
    }
    if (insert.file.size > 10 * 1024 * 1024) {
      toast.error("Máximo 10 MB");
      return;
    }
    setInsert({ ...insert, busy: true });
    try {
      const base64 = await fileToBase64(insert.file);
      const ext = insert.file.name.split(".").pop() || "bin";
      await uploadDoc({
        data: {
          user_id: userId,
          categoria: insert.categoria,
          tipo: insert.tipo.trim(),
          descricao: insert.descricao,
          base64,
          mime: insert.file.type,
          ext,
        },
      });
      toast.success("Documento inserido");
      setInsert(null);
      qc.invalidateQueries({ queryKey: ["funcionario-docs", userId] });
      qc.invalidateQueries({ queryKey: ["funcionario-checklist", userId] });
    } catch (e) {
      toast.error(
        e instanceof Error ? e.message : "Falha ao inserir documento",
      );
      setInsert((s) => (s ? { ...s, busy: false } : s));
    }
  };

  const { data: docs } = useQuery({
    queryKey: ["funcionario-docs", userId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("employee_documents")
        .select("*")
        .eq("user_id", userId)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return data;
    },
  });

  const { data: checklist } = useQuery({
    queryKey: ["funcionario-checklist", userId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("document_checklist")
        .select("*")
        .eq("user_id", userId);
      if (error) throw error;
      return data;
    },
  });

  const download = async (path: string) => {
    const { data, error } = await supabase.storage
      .from("documentos-funcionarios")
      .createSignedUrl(path, 60);
    if (error || !data) {
      toast.error("Não foi possível gerar o link");
      return;
    }
    window.open(data.signedUrl, "_blank");
  };

  const review = async () => {
    if (!reviewing) return;
    const { error } = await supabase
      .from("employee_documents")
      .update({
        status: reviewing.action,
        observacao_rh: obs || null,
        reviewed_by: reviewerId,
        reviewed_at: new Date().toISOString(),
      })
      .eq("id", reviewing.id);
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success(`Documento ${reviewing.action}`);
    setReviewing(null);
    setObs("");
    qc.invalidateQueries({ queryKey: ["funcionario-docs", userId] });
  };

  const enviadosTipos = new Set((docs ?? []).map((d) => d.tipo));
  const checklistFaltando = (checklist ?? []).filter(
    (c) => !enviadosTipos.has(c.tipo),
  );

  return (
    <div className="space-y-6">
      {checklistFaltando.length > 0 && (
        <div className="bg-warning/10 border border-warning/30 rounded-2xl p-5">
          <h3 className="font-bold text-xs uppercase tracking-widest text-warning mb-3">
            Documentos pendentes do checklist
          </h3>
          <ul className="text-sm space-y-1">
            {checklistFaltando.map((c) => (
              <li key={c.id} className="flex items-center justify-between">
                <span>
                  {c.tipo}{" "}
                  <span className="text-muted-foreground text-xs">
                    ({CATEGORIA_LABEL[c.categoria]})
                  </span>
                </span>
                {c.obrigatorio && (
                  <Badge variant="outline" className="text-xs">
                    Obrigatório
                  </Badge>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      <input
        ref={insertFileRef}
        type="file"
        accept="image/*,application/pdf"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) setInsert((s) => (s ? { ...s, file: f } : s));
          e.target.value = "";
        }}
      />

      <div className="bg-card border border-border rounded-2xl overflow-hidden shadow-sm">
        <div className="px-5 py-4 border-b border-border bg-muted/30 flex items-center justify-between gap-3">
          <h2 className="font-bold text-xs uppercase tracking-widest">
            Documentos enviados
          </h2>
          <Button
            size="sm"
            onClick={() =>
              setInsert({
                tipo: "",
                categoria: "trabalhista",
                descricao: "",
                file: null,
                busy: false,
              })
            }
          >
            <Upload className="size-3.5 mr-1" /> Inserir documento
          </Button>
        </div>
        {(docs ?? []).length === 0 ? (
          <div className="p-10 text-center text-sm text-muted-foreground">
            <FileText className="size-10 mx-auto opacity-30 mb-3" />
            Nenhum documento enviado.
          </div>
        ) : (
          <div className="divide-y divide-border">
            {docs?.map((d) => (
              <div
                key={d.id}
                className="px-5 py-4 flex flex-col md:flex-row md:items-center gap-3"
              >
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold truncate">{d.tipo}</p>
                  <p className="text-[11px] font-mono text-muted-foreground mt-0.5 truncate">
                    {CATEGORIA_LABEL[d.categoria]} · enviado em{" "}
                    {new Date(d.created_at).toLocaleDateString("pt-BR")}
                    {d.observacao_rh ? ` · "${d.observacao_rh}"` : ""}
                  </p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <StatusBadge status={d.status} />
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => download(d.arquivo_path)}
                  >
                    <Download className="size-3.5" />
                  </Button>
                  {d.status === "pendente" && (
                    <>
                      <Button
                        size="sm"
                        className="bg-success text-success-foreground hover:bg-success/90"
                        onClick={() => {
                          setReviewing({
                            id: d.id,
                            tipo: d.tipo,
                            action: "aprovado",
                          });
                          setObs("");
                        }}
                      >
                        <Check className="size-3.5" />
                      </Button>
                      <Button
                        size="sm"
                        variant="destructive"
                        onClick={() => {
                          setReviewing({
                            id: d.id,
                            tipo: d.tipo,
                            action: "rejeitado",
                          });
                          setObs("");
                        }}
                      >
                        <X className="size-3.5" />
                      </Button>
                    </>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <Dialog open={!!reviewing} onOpenChange={(o) => !o && setReviewing(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {reviewing?.action === "aprovado" ? "Aprovar" : "Rejeitar"}{" "}
              documento
            </DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">{reviewing?.tipo}</p>
          <Textarea
            placeholder="Observação (opcional)"
            value={obs}
            onChange={(e) => setObs(e.target.value)}
            rows={3}
            maxLength={500}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setReviewing(null)}>
              Cancelar
            </Button>
            <Button
              variant={
                reviewing?.action === "rejeitado" ? "destructive" : "default"
              }
              className={
                reviewing?.action === "aprovado"
                  ? "bg-success text-success-foreground hover:bg-success/90"
                  : ""
              }
              onClick={review}
            >
              Confirmar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!insert} onOpenChange={(o) => !o && setInsert(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Inserir documento do colaborador</DialogTitle>
          </DialogHeader>
          {insert && (
            <div className="space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label className="text-[11px] font-bold uppercase text-muted-foreground">
                    Tipo do documento *
                  </Label>
                  <Input
                    value={insert.tipo}
                    onChange={(e) =>
                      setInsert({ ...insert, tipo: e.target.value })
                    }
                    placeholder="Ex.: Contrato, RG, Comprovante..."
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-[11px] font-bold uppercase text-muted-foreground">
                    Categoria
                  </Label>
                  <Select
                    value={insert.categoria}
                    onValueChange={(v) =>
                      setInsert({
                        ...insert,
                        categoria: v as DocumentoCategoria,
                      })
                    }
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {(
                        Object.keys(CATEGORIA_LABEL) as DocumentoCategoria[]
                      ).map((k) => (
                        <SelectItem key={k} value={k}>
                          {CATEGORIA_LABEL[k]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              {!insert.file ? (
                <Button
                  variant="outline"
                  className="w-full py-6"
                  onClick={() => insertFileRef.current?.click()}
                >
                  <Upload className="size-4 mr-2" /> Escolher arquivo
                  (PDF/Imagem, máx. 10 MB)
                </Button>
              ) : (
                <div className="flex items-center justify-between gap-2 text-xs font-mono p-3 bg-muted rounded-lg">
                  <span className="truncate">📎 {insert.file.name}</span>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => insertFileRef.current?.click()}
                  >
                    Trocar
                  </Button>
                </div>
              )}
              <div className="space-y-1.5">
                <Label className="text-[11px] font-bold uppercase text-muted-foreground">
                  Observações
                </Label>
                <Textarea
                  rows={2}
                  value={insert.descricao}
                  onChange={(e) =>
                    setInsert({ ...insert, descricao: e.target.value })
                  }
                  maxLength={1000}
                />
              </div>
              <p className="text-[11px] text-muted-foreground">
                Documentos inseridos pelo RH entram como{" "}
                <strong>aprovados</strong>, registrando quem anexou.
              </p>
            </div>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setInsert(null)}
              disabled={insert?.busy}
            >
              Cancelar
            </Button>
            <Button
              onClick={submitInsert}
              disabled={!insert?.file || !insert?.tipo.trim() || insert?.busy}
            >
              {insert?.busy ? (
                <Loader2 className="size-4 animate-spin mr-2" />
              ) : (
                <Upload className="size-4 mr-2" />
              )}
              Inserir
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve((r.result as string).split(",")[1]);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

function AtestadosPanel({ userId }: { userId: string }) {
  const { data } = useQuery({
    queryKey: ["funcionario-atestados", userId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("atestados")
        .select("*")
        .eq("user_id", userId)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return data;
    },
  });
  return (
    <div className="bg-card border border-border rounded-2xl overflow-hidden shadow-sm">
      {(data ?? []).length === 0 ? (
        <div className="p-10 text-center text-sm text-muted-foreground">
          <Loader2 className="hidden" />
          Nenhum atestado.
        </div>
      ) : (
        <div className="divide-y divide-border">
          {data?.map((a) => (
            <div
              key={a.id}
              className="px-5 py-4 flex items-center justify-between gap-3"
            >
              <div className="min-w-0">
                <p className="text-sm font-semibold">
                  {a.cid ? `CID ${a.cid}` : "(Sem CID)"} ·{" "}
                  {a.dias_afastamento ?? "—"} dias
                </p>
                <p className="text-[11px] font-mono text-muted-foreground mt-0.5 truncate">
                  {a.data_inicio || "?"} → {a.data_fim || "?"} · Dr(a){" "}
                  {a.medico_nome || "—"}
                </p>
              </div>
              <StatusBadge status={a.status} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
