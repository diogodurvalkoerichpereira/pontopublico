-- O3-09 (Onda 3 — Contratações) — Vínculo do contrato à licitação de origem (Lei
-- 14.133). Todo contrato decorre de um processo (licitação homologada, ou
-- dispensa/inexigibilidade formalizada). Aqui o contrato passa a referenciar o
-- processo licitatório (`procurement_processes`, O3-06) que o originou. A regra
-- (só um processo homologado origina contrato, com modalidade coerente) é
-- aplicacional. Reusa contracts.*.
--
-- Aditiva. Legível, uma instrução por linha.

begin;

alter table public.procurement_contracts
  add column if not exists procurement_process_id uuid
  references public.procurement_processes(id) on delete restrict;

create index if not exists procurement_contracts_process_idx
  on public.procurement_contracts (procurement_process_id);

commit;
