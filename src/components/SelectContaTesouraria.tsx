import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useAuth } from "@/lib/auth-context";
import { getTreasuryAccounts } from "@/lib/treasury.functions";

/**
 * Escolha da conta de tesouraria que recebe o dinheiro.
 *
 * Os três caminhos de arrecadação (receita, tributo avulso e parcela de
 * parcelamento) precisam da mesma pergunta — "entrou em qual conta?" —, e antes
 * do O4-18 nenhum deles a fazia: o dinheiro era registrado como arrecadado e não
 * entrava em conta nenhuma. Ficar num componente só evita que um dos três volte
 * a divergir dos outros.
 */
export function SelectContaTesouraria({
  value,
  onChange,
  label = "Conta que recebeu",
}: {
  value: string;
  onChange: (id: string) => void;
  label?: string;
}) {
  const { activeTenant } = useAuth();
  const carregar = useServerFn(getTreasuryAccounts);
  const { data } = useQuery({
    queryKey: ["treasury-accounts", activeTenant?.id],
    enabled: Boolean(activeTenant),
    queryFn: () => carregar({ data: { tenant_id: activeTenant!.id } }),
  });
  const contas = (data?.accounts ?? []).filter((a) => a.status === "ativa");

  return (
    <div>
      <Label>{label}</Label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger>
          <SelectValue placeholder="Selecione a conta" />
        </SelectTrigger>
        <SelectContent>
          {contas.map((a) => (
            <SelectItem key={a.id} value={a.id}>
              {a.nome}
              {a.banco ? ` — ${a.banco}` : ""}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {contas.length === 0 && (
        <p className="mt-1 text-xs text-destructive">
          Nenhuma conta de tesouraria ativa. Cadastre uma em Tesouraria antes de
          arrecadar — é nela que o dinheiro entra.
        </p>
      )}
    </div>
  );
}
