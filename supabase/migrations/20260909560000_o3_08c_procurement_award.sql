-- O3-08c (Onda 3 — Contratações) — Adjudicação do vencedor (Lei 14.133 art. 71). Depois
-- de homologada, a licitação registra a proposta vencedora (a de menor valor entre as
-- classificadas) e o valor homologado, fixando o resultado que autoriza a contratação.
-- Aditivo sobre procurement_processes; reusa contracts.*.
--
-- Aditiva. Legível, uma instrução por linha.

begin;

alter table public.procurement_processes add column if not exists vencedor_proposal_id uuid references public.procurement_proposals(id) on delete set null;

alter table public.procurement_processes add column if not exists valor_homologado numeric(16,2);

alter table public.procurement_processes drop constraint if exists proc_valor_homologado_pos;

alter table public.procurement_processes add constraint proc_valor_homologado_pos check (valor_homologado is null or valor_homologado > 0);

commit;
