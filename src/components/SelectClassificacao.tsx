import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Check, ChevronsUpDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Label } from "@/components/ui/label";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { useAuth } from "@/lib/auth-context";
import { getBudgetCatalog } from "@/lib/budget-catalog.functions";

export type TipoClassificacao =
  | "funcao"
  | "subfuncao"
  | "natureza_categoria"
  | "natureza_grupo"
  | "natureza_modalidade"
  | "natureza_elemento"
  | "fonte_recurso";

/**
 * Escolha de um código de classificação orçamentária, com busca.
 *
 * Aceita **escolher da lista ou digitar**. O catálogo que acompanha o sistema é
 * de referência (Portaria MOG 42/1999, Portaria 163/2001 e Portaria Conjunta
 * STN/SOF 20/2021), e o Tribunal de Contas do ente pode exigir detalhamento
 * próprio — sobretudo na fonte de recurso. Um seletor fechado bloquearia esse
 * ente; por isso o que o usuário digitar vale, e o catálogo só ajuda a acertar.
 */
export function SelectClassificacao({
  tipo,
  value,
  onChange,
  label,
  placeholder = "Busque pelo código ou pelo nome",
}: {
  tipo: TipoClassificacao;
  value: string;
  onChange: (codigo: string) => void;
  label: string;
  placeholder?: string;
}) {
  const { activeTenant } = useAuth();
  const carregar = useServerFn(getBudgetCatalog);
  const [aberto, setAberto] = useState(false);
  const [busca, setBusca] = useState("");

  const { data } = useQuery({
    queryKey: ["budget-catalog", activeTenant?.id, tipo],
    enabled: Boolean(activeTenant),
    queryFn: () => carregar({ data: { tenant_id: activeTenant!.id, tipo } }),
  });

  // O código do ente prevalece sobre o do catálogo padrão quando coincidem: é o
  // nome que aquele ente usa.
  const codigos = (data?.codigos ?? []).filter(
    (c, i, todos) =>
      c.proprio || !todos.some((o) => o.codigo === c.codigo && o.proprio),
  );
  const escolhido = codigos.find((c) => c.codigo === value);

  const selecionar = (codigo: string) => {
    onChange(codigo);
    setAberto(false);
    setBusca("");
  };

  return (
    <div>
      <Label>{label}</Label>
      <Popover open={aberto} onOpenChange={setAberto}>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            role="combobox"
            aria-expanded={aberto}
            className="w-full justify-between font-normal"
          >
            <span className="truncate">
              {value ? (
                <>
                  <span className="font-mono">{value}</span>
                  {escolhido ? ` — ${escolhido.nome}` : ""}
                </>
              ) : (
                <span className="text-muted-foreground">Selecione</span>
              )}
            </span>
            <ChevronsUpDown className="ml-2 size-4 shrink-0 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-[--radix-popover-trigger-width] p-0">
          <Command shouldFilter={false}>
            <CommandInput
              placeholder={placeholder}
              value={busca}
              onValueChange={setBusca}
            />
            <CommandList>
              <CommandEmpty>
                Nenhum código do catálogo corresponde.
              </CommandEmpty>
              <CommandGroup>
                {/* O que foi digitado e não está no catálogo continua válido:
                    é o caminho do ente cujo TCE exige código próprio. */}
                {busca.trim() &&
                  !codigos.some((c) => c.codigo === busca.trim()) && (
                    <CommandItem
                      value={busca}
                      onSelect={() => selecionar(busca.trim())}
                    >
                      Usar{" "}
                      <span className="mx-1 font-mono">{busca.trim()}</span>
                      (fora do catálogo)
                    </CommandItem>
                  )}
                {codigos
                  .filter((c) => {
                    const t = busca.trim().toLowerCase();
                    if (!t) return true;
                    return (
                      c.codigo.toLowerCase().includes(t) ||
                      c.nome.toLowerCase().includes(t)
                    );
                  })
                  .slice(0, 80)
                  .map((c) => (
                    <CommandItem
                      key={`${c.tipo}-${c.codigo}`}
                      value={`${c.codigo} ${c.nome}`}
                      onSelect={() => selecionar(c.codigo)}
                    >
                      <Check
                        className={`mr-2 size-4 ${c.codigo === value ? "opacity-100" : "opacity-0"}`}
                      />
                      <span className="mr-2 font-mono">{c.codigo}</span>
                      <span className="truncate">{c.nome}</span>
                      {c.proprio && (
                        <span className="ml-auto text-[10px] uppercase text-muted-foreground">
                          do ente
                        </span>
                      )}
                    </CommandItem>
                  ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    </div>
  );
}
