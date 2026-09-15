import { useEffect, useState } from "react";
import { SelectClassificacao } from "@/components/SelectClassificacao";
import { Label } from "@/components/ui/label";

/**
 * Compõe a natureza da despesa pelas suas quatro partes.
 *
 * A natureza é um código estruturado (Portaria 163/2001): categoria econômica,
 * grupo, modalidade de aplicação e elemento. Digitá-la inteira de cabeça produz
 * dois erros que só aparecem no relatório: parte inválida (um grupo 7, que não
 * existe) e grafia divergente do mesmo código — "3.1.90.11" e "319011" viram
 * linhas diferentes no agrupamento.
 *
 * Aqui cada parte vem do catálogo e o código sai sempre no mesmo formato
 * `c.g.mm.ee`. O que já estava gravado é lido de volta para as partes, para que
 * editar uma dotação antiga não exija redigitar tudo.
 */
export function ComporNaturezaDespesa({
  value,
  onChange,
}: {
  value: string;
  onChange: (codigo: string) => void;
}) {
  const partesDoValor = (v: string) => {
    const digitos = v.replace(/\D/g, "");
    return {
      categoria: digitos.slice(0, 1),
      grupo: digitos.slice(1, 2),
      modalidade: digitos.slice(2, 4),
      elemento: digitos.slice(4, 6),
    };
  };

  const [partes, setPartes] = useState(() => partesDoValor(value));

  // A dotação em edição chega com o código já formado: desmonta nas partes.
  useEffect(() => {
    setPartes(partesDoValor(value));
  }, [value]);

  const atualizar = (campo: keyof typeof partes, codigo: string) => {
    const proximo = { ...partes, [campo]: codigo };
    setPartes(proximo);
    const { categoria, grupo, modalidade, elemento } = proximo;
    // Só devolve o código quando as quatro partes estão escolhidas: metade de
    // uma natureza não é uma classificação, é um campo pela metade.
    onChange(
      categoria && grupo && modalidade && elemento
        ? `${categoria}.${grupo}.${modalidade}.${elemento}`
        : "",
    );
  };

  return (
    <div className="rounded-lg border p-3">
      <Label className="mb-2 block">Natureza da despesa</Label>
      <div className="grid gap-3 sm:grid-cols-2">
        <SelectClassificacao
          tipo="natureza_categoria"
          label="Categoria econômica"
          value={partes.categoria}
          onChange={(c) => atualizar("categoria", c)}
        />
        <SelectClassificacao
          tipo="natureza_grupo"
          label="Grupo"
          value={partes.grupo}
          onChange={(c) => atualizar("grupo", c)}
        />
        <SelectClassificacao
          tipo="natureza_modalidade"
          label="Modalidade de aplicação"
          value={partes.modalidade}
          onChange={(c) => atualizar("modalidade", c)}
        />
        <SelectClassificacao
          tipo="natureza_elemento"
          label="Elemento de despesa"
          value={partes.elemento}
          onChange={(c) => atualizar("elemento", c)}
        />
      </div>
      <p className="mt-2 text-xs text-muted-foreground">
        Código resultante:{" "}
        <span className="font-mono font-semibold">
          {value || "escolha as quatro partes"}
        </span>
      </p>
    </div>
  );
}
