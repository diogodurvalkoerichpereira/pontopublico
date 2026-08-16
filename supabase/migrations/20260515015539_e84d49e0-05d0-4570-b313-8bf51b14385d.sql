-- ============ PERMISSÕES GRANULARES DO RH ============
CREATE TYPE public.rh_permission AS ENUM (
  'manage_employees','approve_documents','configure_schedules','close_payroll'
);

CREATE TABLE public.rh_permissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  permission rh_permission NOT NULL,
  granted_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_id, permission)
);
ALTER TABLE public.rh_permissions ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.has_permission(_user_id uuid, _perm rh_permission)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT
    public.has_role(_user_id, 'admin'::app_role)
    OR EXISTS (
      SELECT 1 FROM public.rh_permissions
      WHERE user_id = _user_id AND permission = _perm
    );
$$;

CREATE POLICY "perms_select" ON public.rh_permissions FOR SELECT TO authenticated
  USING (auth.uid() = user_id OR public.has_role(auth.uid(),'admin'::app_role));
CREATE POLICY "perms_admin_all" ON public.rh_permissions FOR ALL TO authenticated
  USING (public.has_role(auth.uid(),'admin'::app_role))
  WITH CHECK (public.has_role(auth.uid(),'admin'::app_role));

-- Promove admins existentes
INSERT INTO public.user_roles (user_id, role)
SELECT u.id, 'admin'::app_role FROM auth.users u
WHERE lower(u.email) IN ('admin@example.com','admin@example.com')
ON CONFLICT DO NOTHING;

-- Trigger handle_new_user
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  INSERT INTO public.profiles (id, full_name, email, cpf, matricula, setor)
  VALUES (
    NEW.id,
    COALESCE(NEW.raw_user_meta_data->>'full_name',''),
    NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'cpf',''),
    COALESCE(NEW.raw_user_meta_data->>'matricula',''),
    COALESCE(NEW.raw_user_meta_data->>'setor','')
  );
  INSERT INTO public.user_roles (user_id, role) VALUES (NEW.id, 'funcionario') ON CONFLICT DO NOTHING;
  IF lower(NEW.email) IN ('admin@example.com','admin@example.com') THEN
    INSERT INTO public.user_roles (user_id, role) VALUES (NEW.id, 'rh') ON CONFLICT DO NOTHING;
    INSERT INTO public.user_roles (user_id, role) VALUES (NEW.id, 'admin') ON CONFLICT DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;

-- ============ ESCALAS ============
CREATE TYPE public.schedule_type AS ENUM ('fixed_weekly','rotative');
CREATE TYPE public.ponto_tipo AS ENUM ('2_batidas','4_batidas');

CREATE TABLE public.work_schedules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nome text NOT NULL,
  tipo schedule_type NOT NULL,
  config jsonb NOT NULL,
  carga_horaria_mensal numeric NOT NULL DEFAULT 220,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.work_schedules ENABLE ROW LEVEL SECURITY;
CREATE TRIGGER trg_ws_updated BEFORE UPDATE ON public.work_schedules
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE POLICY "ws_select" ON public.work_schedules FOR SELECT TO authenticated USING (true);
CREATE POLICY "ws_write" ON public.work_schedules FOR ALL TO authenticated
  USING (public.has_permission(auth.uid(),'configure_schedules'))
  WITH CHECK (public.has_permission(auth.uid(),'configure_schedules'));

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS schedule_id uuid REFERENCES public.work_schedules(id),
  ADD COLUMN IF NOT EXISTS tipo_ponto ponto_tipo NOT NULL DEFAULT '4_batidas',
  ADD COLUMN IF NOT EXISTS valor_hora numeric;

-- ============ PONTO ============
CREATE TYPE public.ponto_batida AS ENUM ('entrada','saida_almoco','volta_almoco','saida');

CREATE TABLE public.time_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  entry_at timestamptz NOT NULL DEFAULT now(),
  tipo ponto_batida NOT NULL,
  origem text NOT NULL DEFAULT 'app',
  observacao text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.time_entries ENABLE ROW LEVEL SECURITY;
CREATE INDEX idx_time_entries_user_date ON public.time_entries(user_id, entry_at DESC);

CREATE POLICY "te_select" ON public.time_entries FOR SELECT TO authenticated
  USING (auth.uid() = user_id OR public.has_role(auth.uid(),'rh') OR public.has_role(auth.uid(),'admin'::app_role));
CREATE POLICY "te_insert_own" ON public.time_entries FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = user_id OR public.has_permission(auth.uid(),'manage_employees'));
CREATE POLICY "te_rh_update" ON public.time_entries FOR UPDATE TO authenticated
  USING (public.has_permission(auth.uid(),'manage_employees'));
CREATE POLICY "te_rh_delete" ON public.time_entries FOR DELETE TO authenticated
  USING (public.has_permission(auth.uid(),'manage_employees'));

-- ============ FOLHA ============
CREATE TYPE public.payroll_status AS ENUM ('aberto','fechado');

CREATE TABLE public.payroll_periods (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  ref_month date NOT NULL,
  horas_previstas numeric NOT NULL DEFAULT 0,
  horas_trabalhadas numeric NOT NULL DEFAULT 0,
  horas_extras_50 numeric NOT NULL DEFAULT 0,
  horas_extras_100 numeric NOT NULL DEFAULT 0,
  horas_faltantes numeric NOT NULL DEFAULT 0,
  salario_base numeric NOT NULL DEFAULT 0,
  valor_extras numeric NOT NULL DEFAULT 0,
  desconto_faltas numeric NOT NULL DEFAULT 0,
  salario_final numeric NOT NULL DEFAULT 0,
  status payroll_status NOT NULL DEFAULT 'aberto',
  calculated_at timestamptz,
  closed_by uuid,
  closed_at timestamptz,
  observacao text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_id, ref_month)
);
ALTER TABLE public.payroll_periods ENABLE ROW LEVEL SECURITY;
CREATE TRIGGER trg_pp_updated BEFORE UPDATE ON public.payroll_periods
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE POLICY "pp_select" ON public.payroll_periods FOR SELECT TO authenticated
  USING (auth.uid() = user_id OR public.has_role(auth.uid(),'rh') OR public.has_role(auth.uid(),'admin'::app_role));
CREATE POLICY "pp_write" ON public.payroll_periods FOR ALL TO authenticated
  USING (public.has_permission(auth.uid(),'close_payroll'))
  WITH CHECK (public.has_permission(auth.uid(),'close_payroll'));

-- ============ AJUSTES DE POLÍTICAS EXISTENTES ============
DROP POLICY IF EXISTS "emp_docs_update_rh" ON public.employee_documents;
CREATE POLICY "emp_docs_update_rh" ON public.employee_documents FOR UPDATE TO authenticated
  USING (public.has_permission(auth.uid(),'approve_documents'));

DROP POLICY IF EXISTS "RH atualiza qualquer atestado" ON public.atestados;
CREATE POLICY "Aprovador atualiza atestado" ON public.atestados FOR UPDATE TO authenticated
  USING (public.has_permission(auth.uid(),'approve_documents'));

-- Concede todas as permissões aos admins existentes (idempotente — admin já passa via has_permission, mas explicitar ajuda relatórios)
-- Não inserimos linhas porque has_permission já cobre admin via has_role.
