import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Car, Plus, Fuel, Gauge } from "lucide-react";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useAuth } from "@/lib/auth-context";
import {
  getFleetVehicles,
  saveFleetVehicle,
  recordFleetEvent,
  getFleetConsumption,
} from "@/lib/fleet.functions";

export const Route = createFileRoute("/frotas")({ component: Page });

function Page() {
  const { session, loading, hasTenantPermission } = useAuth();
  const nav = useNavigate();
  useEffect(() => {
    if (loading) return;
    if (!session) nav({ to: "/login" });
    else if (!hasTenantPermission("assets.read")) nav({ to: "/app" });
  }, [session, loading, hasTenantPermission, nav]);
  if (!session) return null;
  return <Content />;
}

type Vehicle = {
  id: string;
  placa: string;
  modelo: string;
  ano: number;
  odometro_atual: string;
  status: string;
};

const brl = (v: number | string) =>
  Number(v).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const hoje = () => new Date().toISOString().slice(0, 10);
const statusVariant: Record<
  string,
  "default" | "secondary" | "destructive" | "outline"
> = {
  ativo: "default",
  manutencao: "outline",
  baixado: "secondary",
};

function Content() {
  const { activeTenant } = useAuth();
  const load = useServerFn(getFleetVehicles);
  const saveVehicle = useServerFn(saveFleetVehicle);
  const recordEvent = useServerFn(recordFleetEvent);
  const loadConsumption = useServerFn(getFleetConsumption);
  const qc = useQueryClient();

  const [consumptionVehicle, setConsumptionVehicle] = useState<Vehicle | null>(
    null,
  );

  const [vehicleOpen, setVehicleOpen] = useState(false);
  const [eventOpen, setEventOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const [placa, setPlaca] = useState("");
  const [modelo, setModelo] = useState("");
  const [ano, setAno] = useState(String(new Date().getFullYear()));

  const [eventVehicleId, setEventVehicleId] = useState("");
  const [tipo, setTipo] = useState<"abastecimento" | "manutencao">(
    "abastecimento",
  );
  const [odometro, setOdometro] = useState("");
  const [litros, setLitros] = useState("");
  const [valor, setValor] = useState("");
  const [historico, setHistorico] = useState("");

  const { data } = useQuery({
    queryKey: ["fleet", activeTenant?.id],
    enabled: Boolean(activeTenant),
    queryFn: () => load({ data: { tenant_id: activeTenant!.id } }),
  });
  const vehicles = (data?.vehicles ?? []) as Vehicle[];
  const canManage = data?.canManage ?? false;

  const { data: consumption } = useQuery({
    queryKey: ["fleet-consumption", activeTenant?.id, consumptionVehicle?.id],
    enabled: Boolean(activeTenant) && Boolean(consumptionVehicle),
    queryFn: () =>
      loadConsumption({
        data: {
          tenant_id: activeTenant!.id,
          vehicle_id: consumptionVehicle!.id,
        },
      }),
  });

  const refresh = () =>
    qc.invalidateQueries({ queryKey: ["fleet", activeTenant?.id] });

  const submitVehicle = async () => {
    if (!activeTenant) return;
    setBusy(true);
    try {
      await saveVehicle({
        data: {
          tenant_id: activeTenant.id,
          placa: placa.trim(),
          modelo: modelo.trim(),
          ano: Number(ano),
          status: "ativo",
        },
      });
      toast.success("Veículo cadastrado");
      setVehicleOpen(false);
      setPlaca("");
      setModelo("");
      refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Falha ao salvar");
    } finally {
      setBusy(false);
    }
  };

  const submitEvent = async () => {
    if (!activeTenant || !eventVehicleId) return;
    setBusy(true);
    try {
      await recordEvent({
        data: {
          tenant_id: activeTenant.id,
          vehicle_id: eventVehicleId,
          tipo,
          data_evento: hoje(),
          odometro: Number(odometro),
          litros: tipo === "abastecimento" ? Number(litros || 0) : null,
          valor: Number(valor || 0),
          historico: historico.trim(),
        },
      });
      toast.success("Evento registrado");
      setEventOpen(false);
      setOdometro("");
      setLitros("");
      setValor("");
      setHistorico("");
      refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Falha no evento");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="space-y-6">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3">
          <Car className="size-6 text-primary" />
          <div>
            <h1 className="text-2xl font-extrabold tracking-tight">Frotas</h1>
            <p className="text-sm text-muted-foreground">
              Veículos e eventos (abastecimento/manutenção); o hodômetro não
              retrocede
            </p>
          </div>
        </div>
        {canManage && (
          <div className="flex gap-2 flex-wrap">
            <Button variant="outline" onClick={() => setVehicleOpen(true)}>
              <Plus className="size-4" /> Novo veículo
            </Button>
            <Button
              variant="outline"
              onClick={() => {
                setEventVehicleId(vehicles[0]?.id ?? "");
                setEventOpen(true);
              }}
              disabled={vehicles.length === 0}
            >
              <Fuel className="size-4" /> Evento
            </Button>
          </div>
        )}
      </div>

      <div className="rounded-xl border bg-card overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="border-b bg-muted/40 text-left">
            <tr>
              <th className="p-3 font-semibold">Placa</th>
              <th className="p-3 font-semibold">Modelo</th>
              <th className="p-3 font-semibold">Ano</th>
              <th className="p-3 font-semibold text-right">Hodômetro</th>
              <th className="p-3 font-semibold">Situação</th>
              <th className="p-3 font-semibold">Consumo</th>
            </tr>
          </thead>
          <tbody>
            {vehicles.map((v) => (
              <tr key={v.id} className="border-b last:border-0">
                <td className="p-3 font-medium">{v.placa}</td>
                <td className="p-3">{v.modelo}</td>
                <td className="p-3">{v.ano}</td>
                <td className="p-3 text-right tabular-nums">
                  {v.odometro_atual} km
                </td>
                <td className="p-3">
                  <Badge variant={statusVariant[v.status] ?? "secondary"}>
                    {v.status}
                  </Badge>
                </td>
                <td className="p-3">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setConsumptionVehicle(v)}
                  >
                    <Gauge className="size-4" /> Consumo
                  </Button>
                </td>
              </tr>
            ))}
            {vehicles.length === 0 && (
              <tr>
                <td
                  colSpan={6}
                  className="p-6 text-center text-muted-foreground"
                >
                  Nenhum veículo cadastrado.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Novo veículo */}
      <Dialog open={vehicleOpen} onOpenChange={setVehicleOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Novo veículo</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>Placa</Label>
              <Input value={placa} onChange={(e) => setPlaca(e.target.value)} />
            </div>
            <div>
              <Label>Modelo</Label>
              <Input
                value={modelo}
                onChange={(e) => setModelo(e.target.value)}
              />
            </div>
            <div>
              <Label>Ano</Label>
              <Input
                type="number"
                value={ano}
                onChange={(e) => setAno(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button onClick={submitVehicle} disabled={busy}>
              Salvar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Evento */}
      <Dialog open={eventOpen} onOpenChange={setEventOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Registrar evento</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>Veículo</Label>
              <Select value={eventVehicleId} onValueChange={setEventVehicleId}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {vehicles.map((v) => (
                    <SelectItem key={v.id} value={v.id}>
                      {v.placa} — {v.modelo}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Tipo</Label>
              <Select
                value={tipo}
                onValueChange={(v) =>
                  setTipo(v as "abastecimento" | "manutencao")
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="abastecimento">Abastecimento</SelectItem>
                  <SelectItem value="manutencao">Manutenção</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <Label>Hodômetro (km)</Label>
                <Input
                  type="number"
                  value={odometro}
                  onChange={(e) => setOdometro(e.target.value)}
                />
              </div>
              <div>
                <Label>Litros</Label>
                <Input
                  type="number"
                  step="0.01"
                  value={litros}
                  onChange={(e) => setLitros(e.target.value)}
                  disabled={tipo !== "abastecimento"}
                />
              </div>
            </div>
            <div>
              <Label>Valor</Label>
              <Input
                type="number"
                step="0.01"
                value={valor}
                onChange={(e) => setValor(e.target.value)}
              />
            </div>
            <div>
              <Label>Histórico</Label>
              <Input
                value={historico}
                onChange={(e) => setHistorico(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button onClick={submitEvent} disabled={busy}>
              Registrar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Consumo / custo */}
      <Dialog
        open={Boolean(consumptionVehicle)}
        onOpenChange={(o) => !o && setConsumptionVehicle(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              Consumo — {consumptionVehicle?.placa} (
              {consumptionVehicle?.modelo})
            </DialogTitle>
          </DialogHeader>
          {consumption ? (
            <div className="grid grid-cols-2 gap-3 text-sm">
              <Metric
                label="Abastecimentos"
                value={consumption.abastecimentos}
              />
              <Metric
                label="Litros abastecidos"
                value={`${consumption.litrosAbastecidos} L`}
              />
              <Metric
                label="Gasto combustível"
                value={brl(consumption.gastoCombustivel)}
              />
              <Metric
                label="Gasto manutenção"
                value={brl(consumption.gastoManutencao)}
              />
              <Metric
                label="Km percorridos"
                value={
                  consumption.kmPercorridos == null
                    ? "—"
                    : `${consumption.kmPercorridos} km`
                }
              />
              <Metric
                label="Consumo médio"
                value={
                  consumption.consumoMedio == null
                    ? "—"
                    : `${consumption.consumoMedio} km/L`
                }
              />
              <Metric
                label="Custo por km"
                value={
                  consumption.custoPorKm == null
                    ? "—"
                    : brl(consumption.custoPorKm)
                }
              />
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">Calculando…</p>
          )}
          {consumption && consumption.abastecimentos < 2 && (
            <p className="text-xs text-muted-foreground">
              O consumo médio precisa de ao menos dois abastecimentos (método de
              tanque a tanque).
            </p>
          )}
        </DialogContent>
      </Dialog>
    </section>
  );
}

function Metric({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-lg border bg-card p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-lg font-bold tabular-nums">{value}</div>
    </div>
  );
}
