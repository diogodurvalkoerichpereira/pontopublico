import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import {
  Upload,
  Check,
  Loader2,
  FileText,
  AlertCircle,
  Plus,
} from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth-context";
import { AppShell } from "@/components/AppShell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
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
import { extractDocumentoOCR } from "@/lib/document-ocr.functions";
import { CATEGORIA_LABEL, type DocumentoCategoria } from "@/lib/employee-types";

export const Route = createFileRoute("/meus-documentos")({
  component: Page,
});

function Page() {
  const { session, loading } = useAuth();
  const nav = useNavigate();
  useEffect(() => {
    if (!loading && !session) nav({ to: "/login" });
  }, [session, loading, nav]);
  if (!session) return null;
  return (
    <AppShell>
      <Content />
    </AppShell>
  );
}

type UploadState = {
  tipo: string;
  categoria: DocumentoCategoria;
  file: File | null;
  descricao: string;
  ocrDados: Record<string, unknown> | null;
  busy: boolean;
};

// Registro de campos (chaves alinhadas às do OCR quando aplicável, p/ pré-preenchimento).
type CampoDef = { key: string; label: string; type?: string };
const F: Record<string, CampoDef> = {
  nome_completo: { key: "nome_completo", label: "Nome completo" },
  cpf: { key: "cpf", label: "CPF" },
  rg: { key: "rg", label: "RG (número)" },
  orgao_emissor: { key: "orgao_emissor", label: "Órgão emissor" },
  uf_emissor: { key: "uf_emissor", label: "UF emissor" },
  numero_documento: { key: "numero_documento", label: "Número do documento" },
  serie: { key: "serie", label: "Série" },
  zona: { key: "zona", label: "Zona" },
  secao: { key: "secao", label: "Seção" },
  categoria_cnh: { key: "categoria_cnh", label: "Categoria (CNH)" },
  data_nascimento: {
    key: "data_nascimento",
    label: "Data de nascimento",
    type: "date",
  },
  data_emissao: { key: "data_emissao", label: "Data de emissão", type: "date" },
  data_validade: {
    key: "data_validade",
    label: "Data de validade",
    type: "date",
  },
  endereco: { key: "endereco", label: "Endereço" },
  cep: { key: "cep", label: "CEP" },
  cidade: { key: "cidade", label: "Cidade" },
  uf: { key: "uf", label: "UF" },
  banco: { key: "banco", label: "Banco" },
  agencia: { key: "agencia", label: "Agência" },
  conta: { key: "conta", label: "Conta" },
  tipo_conta: { key: "tipo_conta", label: "Tipo de conta" },
  chave_pix: { key: "chave_pix", label: "Chave PIX" },
  data_inicio: { key: "data_inicio", label: "Data de início", type: "date" },
  data_fim: { key: "data_fim", label: "Data de término", type: "date" },
  dias_afastamento: {
    key: "dias_afastamento",
    label: "Dias de afastamento",
    type: "number",
  },
  cid: { key: "cid", label: "CID" },
  medico_nome: { key: "medico_nome", label: "Médico(a)" },
  medico_crm: { key: "medico_crm", label: "CRM" },
  instituicao: { key: "instituicao", label: "Instituição" },
  curso: { key: "curso", label: "Curso / formação" },
  data_conclusao: {
    key: "data_conclusao",
    label: "Data de conclusão",
    type: "date",
  },
};

function normalizar(s: string): string {
  return s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
}

// Campos compatíveis com o documento enviado (por tipo; fallback por categoria).
function camposParaDocumento(
  tipo: string,
  categoria: DocumentoCategoria,
): CampoDef[] {
  const t = normalizar(tipo);
  const has = (...ks: string[]) => ks.some((k) => t.includes(k));
  if (has("atestado", "aso", "afastamento", "medic"))
    return [
      F.data_inicio,
      F.data_fim,
      F.dias_afastamento,
      F.cid,
      F.medico_nome,
      F.medico_crm,
    ];
  if (has("residencia", "comprovante de end", "endereco"))
    return [F.cep, F.endereco, F.cidade, F.uf, F.data_emissao];
  if (has("cnh", "habilitacao"))
    return [
      F.nome_completo,
      F.cpf,
      F.numero_documento,
      F.categoria_cnh,
      F.data_validade,
      F.orgao_emissor,
    ];
  if (has("ctps", "carteira de trabalho", "carteira profissional"))
    return [F.nome_completo, F.numero_documento, F.serie, F.uf, F.data_emissao];
  if (has("titulo", "eleitor"))
    return [F.nome_completo, F.numero_documento, F.zona, F.secao];
  if (has("pis", "pasep", "nit")) return [F.nome_completo, F.numero_documento];
  if (has("cpf")) return [F.nome_completo, F.cpf];
  if (has("reservista", "militar", "alistamento"))
    return [F.nome_completo, F.numero_documento];
  if (has("rg", "identidade", "identificacao", "registro geral"))
    return [
      F.nome_completo,
      F.rg,
      F.orgao_emissor,
      F.uf_emissor,
      F.data_emissao,
      F.data_nascimento,
    ];
  if (has("banc", "conta", "pix", "salario"))
    return [F.banco, F.agencia, F.conta, F.tipo_conta, F.chave_pix];
  if (
    has("diploma", "escolar", "certificado", "curso", "formacao", "historico")
  )
    return [F.nome_completo, F.instituicao, F.curso, F.data_conclusao];
  if (has("certidao", "nascimento", "casamento"))
    return [F.nome_completo, F.numero_documento, F.data_nascimento];
  if (has("foto", "3x4", "2x2")) return [];
  // fallback por categoria
  if (categoria === "comprovante")
    return [F.numero_documento, F.data_emissao, F.endereco];
  if (categoria === "identificacao_pessoal")
    return [
      F.nome_completo,
      F.cpf,
      F.rg,
      F.orgao_emissor,
      F.data_emissao,
      F.data_nascimento,
    ];
  if (categoria === "trabalhista")
    return [F.nome_completo, F.numero_documento, F.data_emissao];
  return [F.nome_completo, F.numero_documento, F.data_emissao]; // genérico
}

function Content() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const ocr = useServerFn(extractDocumentoOCR);
  const fileRef = useRef<HTMLInputElement>(null);

  const [upload, setUpload] = useState<UploadState | null>(null);

  const { data: checklist } = useQuery({
    queryKey: ["meu-checklist", user?.id],
    enabled: !!user,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("document_checklist")
        .select("*")
        .eq("user_id", user!.id);
      if (error) throw error;
      return data;
    },
  });

  const { data: docs } = useQuery({
    queryKey: ["meus-docs", user?.id],
    enabled: !!user,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("employee_documents")
        .select("*")
        .eq("user_id", user!.id)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return data;
    },
  });

  const enviadosTipos = new Set((docs ?? []).map((d) => d.tipo));

  const startUpload = (tipo: string, categoria: DocumentoCategoria) => {
    setUpload({
      tipo,
      categoria,
      file: null,
      descricao: "",
      ocrDados: null,
      busy: false,
    });
    setTimeout(() => fileRef.current?.click(), 50);
  };

  const handleFile = async (f: File) => {
    if (!upload) return;
    if (f.size > 10 * 1024 * 1024) {
      toast.error("Máximo 10 MB");
      return;
    }
    setUpload({ ...upload, file: f, busy: true });
    try {
      const base64 = await fileToBase64(f);
      const result = await ocr({
        data: { base64, mimeType: f.type, tipo: upload.tipo },
      });
      if (result.ok) {
        toast.success("Dados lidos do documento");
        const fields = result.fields as Record<string, unknown>;
        setUpload((u) =>
          u
            ? {
                ...u,
                file: f,
                busy: false,
                ocrDados: fields,
                descricao: (fields.observacoes as string) ?? "",
              }
            : u,
        );
      } else {
        toast.message("Preencha os campos manualmente");
        setUpload((u) => (u ? { ...u, file: f, busy: false } : u));
      }
    } catch {
      setUpload((u) => (u ? { ...u, file: f, busy: false } : u));
    }
  };

  const setCampo = (key: string, value: string) => {
    setUpload((u) =>
      u ? { ...u, ocrDados: { ...(u.ocrDados ?? {}), [key]: value } } : u,
    );
  };

  const submit = async () => {
    if (!upload || !upload.file || !user) return;
    setUpload({ ...upload, busy: true });
    try {
      // Mantém apenas os campos com valor preenchido (OCR ou manual).
      const dadosLimpos = upload.ocrDados
        ? Object.fromEntries(
            Object.entries(upload.ocrDados).filter(
              ([, v]) => v !== "" && v != null,
            ),
          )
        : null;
      const ext = upload.file.name.split(".").pop() || "bin";
      const path = `${user.id}/${Date.now()}-${upload.tipo.replace(/\s+/g, "_")}.${ext}`;
      const { error: upErr } = await supabase.storage
        .from("documentos-funcionarios")
        .upload(path, upload.file, {
          contentType: upload.file.type,
          upsert: false,
        });
      if (upErr) throw upErr;
      const { data: inserted, error: insErr } = await supabase
        .from("employee_documents")
        .insert({
          user_id: user.id,
          categoria: upload.categoria,
          tipo: upload.tipo,
          descricao: upload.descricao || null,
          arquivo_path: path,
          arquivo_mime: upload.file.type,
          ocr_dados: (dadosLimpos && Object.keys(dadosLimpos).length
            ? dadosLimpos
            : null) as never,
        })
        .select()
        .single();
      if (insErr) throw insErr;
      // Vincula ao checklist se existir
      await supabase
        .from("document_checklist")
        .update({ document_id: inserted.id })
        .eq("user_id", user.id)
        .eq("tipo", upload.tipo);
      toast.success("Documento enviado para análise do RH");
      setUpload(null);
      qc.invalidateQueries({ queryKey: ["meu-checklist", user.id] });
      qc.invalidateQueries({ queryKey: ["meus-docs", user.id] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Falha ao enviar");
      setUpload((u) => (u ? { ...u, busy: false } : u));
    }
  };

  return (
    <div className="space-y-8 animate-in-up">
      <div>
        <h1 className="text-3xl md:text-4xl font-extrabold tracking-tight leading-[1.1]">
          Meus Documentos
        </h1>
        <p className="text-muted-foreground mt-2 text-sm">
          Envie seus documentos para validação do RH.
        </p>
      </div>

      <input
        ref={fileRef}
        type="file"
        accept="image/*,application/pdf"
        hidden
        onChange={(e) => e.target.files?.[0] && handleFile(e.target.files[0])}
      />

      <div className="bg-card border border-border rounded-2xl overflow-hidden shadow-sm">
        <div className="px-5 py-4 border-b border-border bg-muted/30 flex items-center justify-between">
          <h2 className="font-bold text-xs uppercase tracking-widest">
            Checklist
          </h2>
          <Button
            size="sm"
            variant="outline"
            onClick={() => startUpload("Outro documento", "livre")}
          >
            <Plus className="size-3.5 mr-1" /> Outro
          </Button>
        </div>
        <div className="divide-y divide-border">
          {(checklist ?? []).map((c) => {
            const enviado = enviadosTipos.has(c.tipo);
            const doc = docs?.find((d) => d.tipo === c.tipo);
            return (
              <div key={c.id} className="px-5 py-4 flex items-center gap-3">
                <div
                  className={`size-9 rounded-lg flex items-center justify-center shrink-0 ${enviado ? "bg-success/10 text-success" : "bg-muted text-muted-foreground"}`}
                >
                  {enviado ? (
                    <Check className="size-4" />
                  ) : (
                    <FileText className="size-4" />
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold">{c.tipo}</p>
                  <p className="text-[11px] font-mono text-muted-foreground mt-0.5">
                    {CATEGORIA_LABEL[c.categoria as DocumentoCategoria]}
                    {c.obrigatorio ? " · obrigatório" : " · opcional"}
                    {doc?.observacao_rh && doc.status === "rejeitado"
                      ? ` · "${doc.observacao_rh}"`
                      : ""}
                  </p>
                </div>
                {doc ? (
                  <div className="flex items-center gap-2 shrink-0">
                    <StatusBadge status={doc.status} />
                    {doc.status === "rejeitado" && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() =>
                          startUpload(c.tipo, c.categoria as DocumentoCategoria)
                        }
                      >
                        Reenviar
                      </Button>
                    )}
                  </div>
                ) : (
                  <Button
                    size="sm"
                    onClick={() =>
                      startUpload(c.tipo, c.categoria as DocumentoCategoria)
                    }
                  >
                    <Upload className="size-3.5 mr-1" /> Enviar
                  </Button>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {(docs ?? []).filter((d) => !checklist?.some((c) => c.tipo === d.tipo))
        .length > 0 && (
        <div className="bg-card border border-border rounded-2xl overflow-hidden shadow-sm">
          <div className="px-5 py-4 border-b border-border bg-muted/30">
            <h2 className="font-bold text-xs uppercase tracking-widest">
              Outros enviados
            </h2>
          </div>
          <div className="divide-y divide-border">
            {docs
              ?.filter((d) => !checklist?.some((c) => c.tipo === d.tipo))
              .map((d) => (
                <div
                  key={d.id}
                  className="px-5 py-4 flex items-center justify-between gap-3"
                >
                  <div className="min-w-0">
                    <p className="text-sm font-semibold truncate">{d.tipo}</p>
                    <p className="text-[11px] font-mono text-muted-foreground mt-0.5">
                      {CATEGORIA_LABEL[d.categoria]} ·{" "}
                      {new Date(d.created_at).toLocaleDateString("pt-BR")}
                    </p>
                  </div>
                  <StatusBadge status={d.status} />
                </div>
              ))}
          </div>
        </div>
      )}

      <Dialog open={!!upload} onOpenChange={(o) => !o && setUpload(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Enviar: {upload?.tipo}</DialogTitle>
          </DialogHeader>
          {upload && (
            <div className="space-y-4">
              {upload.categoria === "livre" && (
                <div className="space-y-1.5">
                  <Label className="text-[11px] font-bold uppercase text-muted-foreground">
                    Tipo do documento
                  </Label>
                  <Input
                    value={upload.tipo}
                    onChange={(e) =>
                      setUpload({ ...upload, tipo: e.target.value })
                    }
                  />
                </div>
              )}
              {!upload.file ? (
                <Button
                  onClick={() => fileRef.current?.click()}
                  className="w-full py-6"
                >
                  <Upload className="size-4 mr-2" /> Escolher arquivo
                  (PDF/Imagem)
                </Button>
              ) : (
                <div className="text-xs text-muted-foreground font-mono p-3 bg-muted rounded-lg">
                  📎 {upload.file.name}
                </div>
              )}
              {upload.busy && (
                <div className="text-center text-sm text-muted-foreground flex items-center justify-center gap-2">
                  <Loader2 className="size-4 animate-spin" /> Processando
                  documento...
                </div>
              )}
              {upload.file &&
                !upload.busy &&
                (() => {
                  const campos = camposParaDocumento(
                    upload.tipo,
                    upload.categoria,
                  );
                  if (campos.length === 0) return null;
                  return (
                    <div className="space-y-3">
                      <div className="flex items-center justify-between">
                        <Label className="text-[11px] font-bold uppercase text-muted-foreground flex items-center gap-1">
                          <FileText className="size-3" /> Dados do documento
                        </Label>
                        {upload.ocrDados ? (
                          <Badge
                            variant="secondary"
                            className="text-[10px] gap-1"
                          >
                            <Check className="size-3" /> Lido do arquivo
                          </Badge>
                        ) : (
                          <Badge variant="outline" className="text-[10px]">
                            Preenchimento manual
                          </Badge>
                        )}
                      </div>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        {campos.map((campo) => (
                          <div key={campo.key} className="space-y-1">
                            <Label
                              htmlFor={campo.key}
                              className="text-[11px] text-muted-foreground"
                            >
                              {campo.label}
                            </Label>
                            <Input
                              id={campo.key}
                              type={campo.type ?? "text"}
                              value={String(upload.ocrDados?.[campo.key] ?? "")}
                              onChange={(e) =>
                                setCampo(campo.key, e.target.value)
                              }
                            />
                          </div>
                        ))}
                      </div>
                      <p className="text-xs text-muted-foreground flex items-start gap-1">
                        <AlertCircle className="size-3 mt-0.5 shrink-0" />
                        {upload.ocrDados
                          ? "Confira os dados lidos e corrija ou complete o que for necessário. O RH fará a validação."
                          : "Preencha os campos aplicáveis ao documento. O RH fará a validação."}
                      </p>
                    </div>
                  );
                })()}
              <div className="space-y-1.5">
                <Label className="text-[11px] font-bold uppercase text-muted-foreground">
                  Observações
                </Label>
                <Textarea
                  rows={2}
                  value={upload.descricao}
                  onChange={(e) =>
                    setUpload({ ...upload, descricao: e.target.value })
                  }
                />
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setUpload(null)}>
              Cancelar
            </Button>
            <Button onClick={submit} disabled={!upload?.file || upload?.busy}>
              {upload?.busy ? (
                <Loader2 className="size-4 animate-spin mr-2" />
              ) : (
                <Check className="size-4 mr-2" />
              )}
              Enviar para o RH
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
