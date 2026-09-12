-- O2-04 (Onda 2 — núcleo SIAFIC) — Folha → orçamento. A requisição de empenho da
-- folha (O1-08) passa a poder virar empenho real contra dotação (O2-02). Novo
-- estágio 'empenhada' no ciclo da requisição.
--
-- Aditiva. Legível, uma instrução por linha.

begin;

alter table public.payroll_empenho_requests
  drop constraint if exists payroll_empenho_status_check;

alter table public.payroll_empenho_requests
  add constraint payroll_empenho_status_check
  check (status in ('rascunho', 'emitida', 'empenhada', 'cancelada'));

commit;
