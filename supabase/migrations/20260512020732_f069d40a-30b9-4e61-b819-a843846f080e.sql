
-- Roles enum + table
CREATE TYPE public.app_role AS ENUM ('funcionario', 'rh');

CREATE TABLE public.profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  full_name TEXT,
  cpf TEXT,
  matricula TEXT,
  setor TEXT,
  email TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

CREATE TABLE public.user_roles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role public.app_role NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, role)
);
ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;

-- has_role function
CREATE OR REPLACE FUNCTION public.has_role(_user_id UUID, _role public.app_role)
RETURNS BOOLEAN
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = _user_id AND role = _role
  );
$$;

-- Atestados
CREATE TYPE public.atestado_status AS ENUM ('pendente', 'aprovado', 'rejeitado');

CREATE TABLE public.atestados (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  paciente_nome TEXT,
  cpf TEXT,
  matricula TEXT,
  data_emissao DATE,
  data_inicio DATE,
  data_fim DATE,
  dias_afastamento INTEGER,
  medico_nome TEXT,
  medico_crm TEXT,
  cid TEXT,
  observacoes TEXT,
  arquivo_path TEXT NOT NULL,
  arquivo_mime TEXT,
  ocr_confianca NUMERIC,
  ocr_raw JSONB,
  status public.atestado_status NOT NULL DEFAULT 'pendente',
  rh_observacao TEXT,
  reviewed_by UUID REFERENCES auth.users(id),
  reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.atestados ENABLE ROW LEVEL SECURITY;
CREATE INDEX atestados_user_id_idx ON public.atestados(user_id);
CREATE INDEX atestados_status_idx ON public.atestados(status);

-- Audit logs
CREATE TABLE public.audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id UUID REFERENCES auth.users(id),
  atestado_id UUID REFERENCES public.atestados(id) ON DELETE CASCADE,
  action TEXT NOT NULL,
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.audit_logs ENABLE ROW LEVEL SECURITY;

-- Updated_at trigger
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER profiles_set_updated_at BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER atestados_set_updated_at BEFORE UPDATE ON public.atestados
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Auto create profile + default role on signup
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.profiles (id, full_name, email, cpf, matricula, setor)
  VALUES (
    NEW.id,
    COALESCE(NEW.raw_user_meta_data->>'full_name', ''),
    NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'cpf', ''),
    COALESCE(NEW.raw_user_meta_data->>'matricula', ''),
    COALESCE(NEW.raw_user_meta_data->>'setor', '')
  );
  INSERT INTO public.user_roles (user_id, role)
  VALUES (NEW.id, 'funcionario')
  ON CONFLICT DO NOTHING;
  RETURN NEW;
END;
$$;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- RLS Policies: profiles
CREATE POLICY "Users read own profile" ON public.profiles
  FOR SELECT TO authenticated
  USING (auth.uid() = id OR public.has_role(auth.uid(), 'rh'));
CREATE POLICY "Users update own profile" ON public.profiles
  FOR UPDATE TO authenticated USING (auth.uid() = id);

-- RLS: user_roles (read only; never client-writable)
CREATE POLICY "Users read own roles" ON public.user_roles
  FOR SELECT TO authenticated
  USING (auth.uid() = user_id OR public.has_role(auth.uid(), 'rh'));

-- RLS: atestados
CREATE POLICY "Funcionario insere proprio atestado" ON public.atestados
  FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Le proprios atestados ou RH le todos" ON public.atestados
  FOR SELECT TO authenticated
  USING (auth.uid() = user_id OR public.has_role(auth.uid(), 'rh'));
CREATE POLICY "Funcionario edita pendente proprio" ON public.atestados
  FOR UPDATE TO authenticated
  USING (auth.uid() = user_id AND status = 'pendente');
CREATE POLICY "RH atualiza qualquer atestado" ON public.atestados
  FOR UPDATE TO authenticated
  USING (public.has_role(auth.uid(), 'rh'));

-- RLS: audit_logs (RH only)
CREATE POLICY "RH le auditoria" ON public.audit_logs
  FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'rh'));
CREATE POLICY "Insert audit autenticado" ON public.audit_logs
  FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = actor_id);

-- Storage bucket (private)
INSERT INTO storage.buckets (id, name, public)
VALUES ('atestados', 'atestados', false)
ON CONFLICT DO NOTHING;

-- Storage policies: each user's files in folder named user_id
CREATE POLICY "Funcionario envia para sua pasta" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'atestados'
    AND auth.uid()::text = (storage.foldername(name))[1]
  );
CREATE POLICY "Funcionario le seus arquivos" ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'atestados'
    AND (auth.uid()::text = (storage.foldername(name))[1] OR public.has_role(auth.uid(), 'rh'))
  );
CREATE POLICY "Funcionario remove proprios arquivos" ON storage.objects
  FOR DELETE TO authenticated
  USING (
    bucket_id = 'atestados'
    AND auth.uid()::text = (storage.foldername(name))[1]
  );
