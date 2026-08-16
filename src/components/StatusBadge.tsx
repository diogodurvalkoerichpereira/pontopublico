type Status = "pendente" | "aprovado" | "rejeitado";

const map: Record<Status, { label: string; cls: string; dot: string }> = {
  pendente: { label: "Pendente", cls: "bg-warning/10 text-warning border-warning/30", dot: "bg-warning" },
  aprovado: { label: "Aprovado", cls: "bg-success/10 text-success border-success/30", dot: "bg-success" },
  rejeitado: { label: "Rejeitado", cls: "bg-destructive/10 text-destructive border-destructive/30", dot: "bg-destructive" },
};

export function StatusBadge({ status }: { status: Status }) {
  const m = map[status];
  return (
    <span className={`inline-flex items-center gap-1.5 py-0.5 px-2 rounded-full text-[10px] font-bold uppercase tracking-wider border ${m.cls}`}>
      <span className={`size-1.5 rounded-full ${m.dot}`} />
      {m.label}
    </span>
  );
}
