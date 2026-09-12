import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Bot } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useAuth } from "@/lib/auth-context";
import {
  getIntegrationSettings,
  saveIntegrationSettings,
  getAlertSettings,
  saveAlertSettings,
} from "@/lib/integrations.functions";

export const Route = createFileRoute("/integracoes")({ component: Page });

function Page() {
  const { session, loading, hasTenantPermission } = useAuth();
  const nav = useNavigate();
  useEffect(() => {
    if (loading) return;
    if (!session) nav({ to: "/login" });
    else if (!hasTenantPermission("org.read")) nav({ to: "/app" });
  }, [session, loading, hasTenantPermission, nav]);
  if (!session) return null;
  return <Content />;
}

const PROVIDER_LABEL: Record<string, string> = {
  menuia: "Chatbot Menuia (chatbot.menuia.com)",
  bealys: "Bealys",
};
const EVENTOS = [
  { key: "reposicao_estoque", label: "Reposição de estoque" },
  { key: "ferias_vencendo", label: "Férias a vencer" },
  { key: "contrato_vencendo", label: "Contratos a vencer" },
  { key: "esic_prazo", label: "Prazo de e-SIC/ouvidoria" },
];

type Provider = {
  provider: string;
  enabled: boolean;
  base_url: string | null;
  has_credential: boolean;
};
type Canal = {
  canal: string;
  enabled: boolean;
  destinatarios: string[];
  eventos: string[];
};

function Content() {
  const { activeTenant } = useAuth();
  const loadIntegrations = useServerFn(getIntegrationSettings);
  const saveIntegration = useServerFn(saveIntegrationSettings);
  const loadAlerts = useServerFn(getAlertSettings);
  const saveAlert = useServerFn(saveAlertSettings);
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);

  const { data: integrations } = useQuery({
    queryKey: ["integrations", activeTenant?.id],
    enabled: Boolean(activeTenant),
    queryFn: () => loadIntegrations({ data: { tenant_id: activeTenant!.id } }),
  });
  const { data: alerts } = useQuery({
    queryKey: ["alert-settings", activeTenant?.id],
    enabled: Boolean(activeTenant),
    queryFn: () => loadAlerts({ data: { tenant_id: activeTenant!.id } }),
  });

  const canManage = integrations?.canManage ?? false;
  const providers = (integrations?.providers ?? []) as Provider[];
  const canais = (alerts?.canais ?? []) as Canal[];

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["integrations", activeTenant?.id] });
    qc.invalidateQueries({ queryKey: ["alert-settings", activeTenant?.id] });
  };

  return (
    <section className="space-y-6">
      <div className="flex items-center gap-3">
        <Bot className="size-6 text-primary" />
        <div>
          <h1 className="text-2xl font-extrabold tracking-tight">
            Integrações e alertas
          </h1>
          <p className="text-sm text-muted-foreground">
            Ligue/desligue e configure cada integração e os canais de alerta
            (WhatsApp e e-mail). O envio efetivo depende de credenciais válidas
            da plataforma.
          </p>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        {providers.map((p) => (
          <ProviderCard
            key={p.provider}
            provider={p}
            canManage={canManage}
            busy={busy}
            onSave={async (payload) => {
              if (!activeTenant) return;
              setBusy(true);
              try {
                await saveIntegration({
                  data: { tenant_id: activeTenant.id, ...payload },
                });
                toast.success("Integração salva");
                refresh();
              } catch (error) {
                toast.error(
                  error instanceof Error ? error.message : "Falha ao salvar",
                );
              } finally {
                setBusy(false);
              }
            }}
          />
        ))}
      </div>

      <h2 className="pt-2 text-lg font-bold">Canais de alerta</h2>
      <div className="grid gap-4 lg:grid-cols-2">
        {canais.map((c) => (
          <CanalCard
            key={c.canal}
            canal={c}
            canManage={canManage}
            busy={busy}
            onSave={async (payload) => {
              if (!activeTenant) return;
              setBusy(true);
              try {
                await saveAlert({
                  data: { tenant_id: activeTenant.id, ...payload },
                });
                toast.success("Canal salvo");
                refresh();
              } catch (error) {
                toast.error(
                  error instanceof Error ? error.message : "Falha ao salvar",
                );
              } finally {
                setBusy(false);
              }
            }}
          />
        ))}
      </div>
    </section>
  );
}

function ProviderCard({
  provider,
  canManage,
  busy,
  onSave,
}: {
  provider: Provider;
  canManage: boolean;
  busy: boolean;
  onSave: (p: {
    provider: string;
    enabled: boolean;
    base_url: string | null;
    credential?: string | null;
  }) => Promise<void>;
}) {
  const [enabled, setEnabled] = useState(provider.enabled);
  const [baseUrl, setBaseUrl] = useState(provider.base_url ?? "");
  const [credential, setCredential] = useState("");

  return (
    <div className="rounded-2xl border bg-card p-5 space-y-3">
      <div className="flex items-center justify-between gap-3">
        <h3 className="font-bold">{PROVIDER_LABEL[provider.provider]}</h3>
        <Switch
          checked={enabled}
          onCheckedChange={setEnabled}
          disabled={!canManage}
        />
      </div>
      <div>
        <Label>URL da API</Label>
        <Input
          value={baseUrl}
          placeholder="https://chatbot.menuia.com/api"
          onChange={(e) => setBaseUrl(e.target.value)}
          disabled={!canManage}
        />
      </div>
      <div>
        <Label>
          Credencial / token{" "}
          {provider.has_credential && (
            <span className="text-xs text-muted-foreground">
              (já cadastrada — deixe em branco para manter)
            </span>
          )}
        </Label>
        <Input
          type="password"
          value={credential}
          placeholder="••••••••"
          onChange={(e) => setCredential(e.target.value)}
          disabled={!canManage}
        />
      </div>
      {canManage && (
        <Button
          variant="outline"
          disabled={busy}
          onClick={() =>
            onSave({
              provider: provider.provider,
              enabled,
              base_url: baseUrl.trim() || null,
              credential: credential === "" ? undefined : credential,
            })
          }
        >
          Salvar
        </Button>
      )}
    </div>
  );
}

function CanalCard({
  canal,
  canManage,
  busy,
  onSave,
}: {
  canal: Canal;
  canManage: boolean;
  busy: boolean;
  onSave: (p: {
    canal: string;
    enabled: boolean;
    destinatarios: string[];
    eventos: string[];
  }) => Promise<void>;
}) {
  const [enabled, setEnabled] = useState(canal.enabled);
  const [destinatarios, setDestinatarios] = useState(
    canal.destinatarios.join(", "),
  );
  const [eventos, setEventos] = useState<string[]>(canal.eventos);
  const toggleEvento = (key: string) =>
    setEventos((cur) =>
      cur.includes(key) ? cur.filter((k) => k !== key) : [...cur, key],
    );

  return (
    <div className="rounded-2xl border bg-card p-5 space-y-3">
      <div className="flex items-center justify-between gap-3">
        <h3 className="font-bold">
          {canal.canal === "whatsapp" ? "WhatsApp" : "E-mail"}
        </h3>
        <Switch
          checked={enabled}
          onCheckedChange={setEnabled}
          disabled={!canManage}
        />
      </div>
      <div>
        <Label>
          Destinatários{" "}
          <span className="text-xs text-muted-foreground">
            (separe por vírgula —{" "}
            {canal.canal === "whatsapp" ? "números" : "e-mails"})
          </span>
        </Label>
        <Input
          value={destinatarios}
          onChange={(e) => setDestinatarios(e.target.value)}
          disabled={!canManage}
        />
      </div>
      <div>
        <Label>Eventos</Label>
        <div className="mt-1 flex flex-wrap gap-2">
          {EVENTOS.map((ev) => (
            <button
              key={ev.key}
              type="button"
              disabled={!canManage}
              onClick={() => toggleEvento(ev.key)}
              className={`rounded-full border px-3 py-1 text-sm ${
                eventos.includes(ev.key)
                  ? "border-primary bg-primary/10 text-primary"
                  : "text-muted-foreground"
              }`}
            >
              {ev.label}
            </button>
          ))}
        </div>
      </div>
      {canManage && (
        <Button
          variant="outline"
          disabled={busy}
          onClick={() =>
            onSave({
              canal: canal.canal,
              enabled,
              destinatarios: destinatarios
                .split(",")
                .map((d) => d.trim())
                .filter(Boolean),
              eventos,
            })
          }
        >
          Salvar
        </Button>
      )}
    </div>
  );
}
