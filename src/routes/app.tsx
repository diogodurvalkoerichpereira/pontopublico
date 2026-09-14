import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Camera, Upload, FileText, Loader2, Check, X } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth-context";
import { AppShell } from "@/components/AppShell";
import { StatusBadge } from "@/components/StatusBadge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { extractAtestadoOCR } from "@/lib/ocr.functions";

export const Route = createFileRoute("/app")({
  component: AppPage,
});

interface OcrFields {
  paciente_nome?: string;
  cpf?: string;
  matricula?: string;
  data_emissao?: string;
  data_inicio?: string;
  data_fim?: string;
  dias_afastamento?: number;
  medico_nome?: string;
  medico_crm?: string;
  cid?: string;
  observacoes?: string;
  confianca?: number;
}

function AppPage() {
  const { session, loading } = useAuth();
  const nav = useNavigate();
  useEffect(() => {
    if (!loading && !session) nav({ to: "/login" });
  }, [session, loading, nav]);

  if (!session) return null;
  return (
    <AppShell>
      <FuncionarioContent />
    </AppShell>
  );
}

function FuncionarioContent() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const ocr = useServerFn(extractAtestadoOCR);

  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [busy, setBusy] = useState<"idle" | "ocr" | "saving">("idle");
  const [fields, setFields] = useState<OcrFields | null>(null);
  const [confianca, setConfianca] = useState<number | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const cameraRef = useRef<HTMLInputElement>(null);

  const { data: historico } = useQuery({
    queryKey: ["historico", user?.id],
    enabled: !!user,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("atestados")
        .select("*")
        .order("created_at", { ascending: false });
      if (error) throw error;
      return data;
    },
  });

  const handleFile = async (f: File) => {
    if (f.size > 10 * 1024 * 1024) {
      toast.error("Arquivo muito grande (máx 10 MB)");
      return;
    }
    setFile(f);
    if (f.type.startsWith("image/")) {
      const url = URL.createObjectURL(f);
      setPreview(url);
    } else {
      setPreview(null);
    }
    setBusy("ocr");
    setFields(null);
    try {
      const base64 = await fileToBase64(f);
      const result = await ocr({ data: { base64, mimeType: f.type } });
      if (!result.ok) {
        toast.error(result.error);
        setFields({});
      } else {
        setFields(result.fields);
        setConfianca(result.fields.confianca ?? null);
        toast.success("Campos preenchidos a partir do documento");
      }
    } catch (e) {
      console.error(e);
      toast.error("Falha ao processar o documento");
      setFields({});
    } finally {
      setBusy("idle");
    }
  };

  const reset = () => {
    setFile(null);
    setPreview(null);
    setFields(null);
    setConfianca(null);
    if (fileRef.current) fileRef.current.value = "";
    if (cameraRef.current) cameraRef.current.value = "";
  };

  const submit = async () => {
    if (!file || !user || !fields) return;
    setBusy("saving");
    try {
      const ext = file.name.split(".").pop() || "bin";
      const path = `${user.id}/${Date.now()}.${ext}`;
      const { error: upErr } = await supabase.storage
        .from("atestados")
        .upload(path, file, { contentType: file.type, upsert: false });
      if (upErr) throw upErr;

      const dias = fields.dias_afastamento
        ? Number(fields.dias_afastamento)
        : fields.data_inicio && fields.data_fim
          ? Math.max(
              1,
              Math.round(
                (new Date(fields.data_fim).getTime() -
                  new Date(fields.data_inicio).getTime()) /
                  86400000,
              ) + 1,
            )
          : null;

      const { data: inserted, error: insErr } = await supabase
        .from("atestados")
        .insert({
          user_id: user.id,
          paciente_nome: fields.paciente_nome || null,
          cpf: fields.cpf || null,
          matricula: fields.matricula || null,
          data_emissao: fields.data_emissao || null,
          data_inicio: fields.data_inicio || null,
          data_fim: fields.data_fim || null,
          dias_afastamento: dias,
          medico_nome: fields.medico_nome || null,
          medico_crm: fields.medico_crm || null,
          cid: fields.cid || null,
          observacoes: fields.observacoes || null,
          arquivo_path: path,
          arquivo_mime: file.type,
          ocr_confianca: confianca,
          ocr_raw: fields as never,
        })
        .select()
        .single();
      if (insErr) throw insErr;

      await supabase.from("audit_logs").insert({
        actor_id: user.id,
        atestado_id: inserted.id,
        action: "envio",
        metadata: { confianca },
      });

      toast.success("Atestado enviado para o RH");
      reset();
      qc.invalidateQueries({ queryKey: ["historico", user.id] });
    } catch (e: unknown) {
      console.error(e);
      toast.error(e instanceof Error ? e.message : "Falha ao enviar");
    } finally {
      setBusy("idle");
    }
  };

  return (
    <div className="grid grid-cols-1 md:grid-cols-12 gap-6 md:gap-10">
      <section className="md:col-span-5 space-y-6 animate-in-up">
        <div>
          <h1 className="text-3xl md:text-4xl font-extrabold tracking-tight leading-[1.1] text-balance">
            Enviar Atestado
          </h1>
          <p className="text-muted-foreground mt-2 text-pretty text-sm">
            Tire uma foto ou anexe um PDF do atestado.
          </p>
        </div>

        {!file ? (
          <div className="space-y-3">
            <button
              type="button"
              onClick={() => cameraRef.current?.click()}
              className="w-full bg-primary text-primary-foreground font-semibold py-4 rounded-xl flex items-center justify-center gap-2 hover:opacity-95 transition-all shadow-lg shadow-primary/20 active:scale-[0.98]"
            >
              <Camera className="size-5" /> Tirar Foto
            </button>
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              className="w-full border-2 border-dashed border-border bg-card font-medium py-4 rounded-xl flex items-center justify-center gap-2 hover:border-primary/50 transition-colors"
            >
              <Upload className="size-4" /> Anexar arquivo (PDF/Imagem)
            </button>
            <input
              ref={cameraRef}
              type="file"
              accept="image/*"
              capture="environment"
              hidden
              onChange={(e) =>
                e.target.files?.[0] && handleFile(e.target.files[0])
              }
            />
            <input
              ref={fileRef}
              type="file"
              accept="image/*,application/pdf"
              hidden
              onChange={(e) =>
                e.target.files?.[0] && handleFile(e.target.files[0])
              }
            />
          </div>
        ) : (
          <div className="border-2 border-border rounded-2xl p-3 bg-card">
            {preview ? (
              <img
                src={preview}
                alt="Pré-visualização do atestado"
                className="w-full aspect-[3/4] object-cover rounded-xl bg-muted"
              />
            ) : (
              <div className="w-full aspect-[3/4] rounded-xl bg-muted grid place-items-center">
                <div className="text-center">
                  <FileText className="size-10 mx-auto text-muted-foreground" />
                  <p className="text-xs text-muted-foreground mt-2 font-mono">
                    {file.name}
                  </p>
                </div>
              </div>
            )}
            <Button variant="outline" className="w-full mt-3" onClick={reset}>
              <X className="size-4 mr-1" /> Trocar arquivo
            </Button>
          </div>
        )}
      </section>

      <section className="md:col-span-7 space-y-6 animate-in-up">
        {busy === "ocr" && (
          <div className="bg-card border border-border rounded-2xl p-8 text-center">
            <Loader2 className="size-8 mx-auto animate-spin text-primary" />
            <p className="mt-3 font-semibold">Processando documento...</p>
            <p className="text-xs text-muted-foreground mt-1 font-mono uppercase tracking-wider">
              Aguarde um instante
            </p>
          </div>
        )}

        {fields && (
          <div className="bg-card border border-border rounded-2xl p-5 md:p-6 space-y-5 shadow-sm">
            <div className="flex items-center justify-between">
              <h3 className="font-bold text-xs uppercase tracking-widest text-muted-foreground">
                Dados do atestado · revise
              </h3>
              {confianca !== null && (
                <span className="text-[10px] font-mono bg-success/10 text-success px-2 py-0.5 rounded-full">
                  {Math.round(confianca * 100)}% confiança
                </span>
              )}
            </div>
            <div className="grid gap-4">
              <Field
                label="Nome do paciente"
                value={fields.paciente_nome}
                onChange={(v) => setFields({ ...fields, paciente_nome: v })}
              />
              <div className="grid grid-cols-2 gap-4">
                <Field
                  label="CPF"
                  value={fields.cpf}
                  onChange={(v) => setFields({ ...fields, cpf: v })}
                />
                <Field
                  label="Matrícula"
                  value={fields.matricula}
                  onChange={(v) => setFields({ ...fields, matricula: v })}
                />
              </div>
              <div className="grid grid-cols-3 gap-4">
                <Field
                  label="Emissão"
                  type="date"
                  value={fields.data_emissao}
                  onChange={(v) => setFields({ ...fields, data_emissao: v })}
                />
                <Field
                  label="Início"
                  type="date"
                  value={fields.data_inicio}
                  onChange={(v) => setFields({ ...fields, data_inicio: v })}
                />
                <Field
                  label="Fim"
                  type="date"
                  value={fields.data_fim}
                  onChange={(v) => setFields({ ...fields, data_fim: v })}
                />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <Field
                  label="Médico"
                  value={fields.medico_nome}
                  onChange={(v) => setFields({ ...fields, medico_nome: v })}
                />
                <Field
                  label="CRM"
                  value={fields.medico_crm}
                  onChange={(v) => setFields({ ...fields, medico_crm: v })}
                />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <Field
                  label="CID"
                  mono
                  value={fields.cid}
                  onChange={(v) => setFields({ ...fields, cid: v })}
                />
                <div className="space-y-1.5">
                  <Label className="text-[11px] font-bold uppercase text-muted-foreground">
                    Dias de afastamento
                  </Label>
                  <Input
                    type="number"
                    value={fields.dias_afastamento ?? ""}
                    onChange={(e) =>
                      setFields({
                        ...fields,
                        dias_afastamento: e.target.value
                          ? Number(e.target.value)
                          : undefined,
                      })
                    }
                  />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label className="text-[11px] font-bold uppercase text-muted-foreground">
                  Observações
                </Label>
                <Textarea
                  rows={2}
                  value={fields.observacoes ?? ""}
                  onChange={(e) =>
                    setFields({ ...fields, observacoes: e.target.value })
                  }
                />
              </div>
            </div>
            <Button
              onClick={submit}
              disabled={busy === "saving"}
              className="w-full font-semibold py-6"
            >
              {busy === "saving" ? (
                <Loader2 className="size-4 mr-2 animate-spin" />
              ) : (
                <Check className="size-4 mr-2" />
              )}
              Confirmar e Enviar para RH
            </Button>
          </div>
        )}

        <div className="bg-card border border-border rounded-2xl overflow-hidden shadow-sm">
          <div className="px-5 md:px-6 py-4 border-b border-border bg-muted/30">
            <h2 className="font-bold text-xs uppercase tracking-widest">
              Histórico
            </h2>
          </div>
          <div className="divide-y divide-border">
            {(historico ?? []).length === 0 && (
              <p className="p-6 text-sm text-muted-foreground text-center">
                Nenhum atestado enviado ainda.
              </p>
            )}
            {historico?.map((a) => (
              <div
                key={a.id}
                className="px-5 md:px-6 py-4 flex items-center justify-between gap-3"
              >
                <div className="min-w-0">
                  <p className="text-sm font-semibold truncate">
                    {a.paciente_nome || "(Sem nome)"}
                  </p>
                  <p className="text-[11px] font-mono text-muted-foreground mt-0.5">
                    {a.cid ? `CID: ${a.cid} · ` : ""}
                    {a.dias_afastamento ?? "—"} dias ·{" "}
                    {new Date(a.created_at).toLocaleDateString("pt-BR")}
                  </p>
                </div>
                <StatusBadge status={a.status} />
              </div>
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  type = "text",
  mono = false,
}: {
  label: string;
  value?: string;
  onChange: (v: string) => void;
  type?: string;
  mono?: boolean;
}) {
  return (
    <div className="space-y-1.5">
      <Label className="text-[11px] font-bold uppercase text-muted-foreground">
        {label}
      </Label>
      <Input
        type={type}
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value)}
        className={mono ? "font-mono" : ""}
      />
    </div>
  );
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      const result = r.result as string;
      resolve(result.split(",")[1]);
    };
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}
