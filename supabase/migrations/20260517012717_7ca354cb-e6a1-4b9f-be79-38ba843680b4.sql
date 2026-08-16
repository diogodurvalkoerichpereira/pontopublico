
-- Profiles: rubricas de folha
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS vale_alimentacao_diario numeric DEFAULT 0,
  ADD COLUMN IF NOT EXISTS vale_transporte_diario numeric DEFAULT 0,
  ADD COLUMN IF NOT EXISTS desconto_vt_funcionario boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS insalubridade_pct numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS periculosidade_pct numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS adicional_noturno boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS plano_saude_desconto numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS outros_descontos numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS outros_proventos numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS dependentes_ir integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS desconta_inss boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS desconta_irrf boolean NOT NULL DEFAULT true;

-- Payroll periods: colunas calculadas extras
ALTER TABLE public.payroll_periods
  ADD COLUMN IF NOT EXISTS dias_trabalhados integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS vale_alimentacao_total numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS vale_transporte_total numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS desconto_vt numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS adicional_insalubridade numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS adicional_periculosidade numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS adicional_noturno_valor numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS inss numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS irrf numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS fgts numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS plano_saude numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS outros_proventos numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS outros_descontos numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total_proventos numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total_descontos numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS salario_minimo_ref numeric NOT NULL DEFAULT 1518;

-- Tabela de configurações da folha (singleton)
CREATE TABLE IF NOT EXISTS public.payroll_config (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  salario_minimo numeric NOT NULL DEFAULT 1518,
  teto_inss numeric NOT NULL DEFAULT 8157.41,
  inss_faixas jsonb NOT NULL DEFAULT '[
    {"ate": 1518.00, "aliquota": 0.075},
    {"ate": 2793.88, "aliquota": 0.09},
    {"ate": 4190.83, "aliquota": 0.12},
    {"ate": 8157.41, "aliquota": 0.14}
  ]'::jsonb,
  irrf_faixas jsonb NOT NULL DEFAULT '[
    {"ate": 2428.80, "aliquota": 0, "deduzir": 0},
    {"ate": 2826.65, "aliquota": 0.075, "deduzir": 182.16},
    {"ate": 3751.05, "aliquota": 0.15, "deduzir": 394.16},
    {"ate": 4664.68, "aliquota": 0.225, "deduzir": 675.49},
    {"ate": 999999999, "aliquota": 0.275, "deduzir": 908.73}
  ]'::jsonb,
  deducao_dependente numeric NOT NULL DEFAULT 189.59,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid
);

INSERT INTO public.payroll_config (id) SELECT gen_random_uuid()
WHERE NOT EXISTS (SELECT 1 FROM public.payroll_config);

ALTER TABLE public.payroll_config ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS pc_select ON public.payroll_config;
CREATE POLICY pc_select ON public.payroll_config FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS pc_write ON public.payroll_config;
CREATE POLICY pc_write ON public.payroll_config FOR ALL TO authenticated
  USING (has_permission(auth.uid(), 'close_payroll'::rh_permission))
  WITH CHECK (has_permission(auth.uid(), 'close_payroll'::rh_permission));

CREATE TRIGGER payroll_config_updated_at
BEFORE UPDATE ON public.payroll_config
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
