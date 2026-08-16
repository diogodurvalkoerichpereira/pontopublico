
CREATE TYPE public.employee_status AS ENUM ('ativo', 'ferias', 'afastado', 'desligado');
CREATE TYPE public.documento_status AS ENUM ('pendente', 'aprovado', 'rejeitado');
CREATE TYPE public.documento_categoria AS ENUM ('identificacao_pessoal', 'trabalhista', 'comprovante', 'livre');

ALTER TABLE public.profiles
  ADD COLUMN cargo TEXT,
  ADD COLUMN data_admissao DATE,
  ADD COLUMN status public.employee_status NOT NULL DEFAULT 'ativo',
  ADD COLUMN operacao TEXT,
  ADD COLUMN telefone TEXT,
  ADD COLUMN endereco TEXT,
  ADD COLUMN contato_emergencia_nome TEXT,
  ADD COLUMN contato_emergencia_telefone TEXT,
  ADD COLUMN salario NUMERIC(12,2),
  ADD COLUMN centro_custo TEXT,
  ADD COLUMN gestor_id UUID REFERENCES public.profiles(id) ON DELETE SET NULL;

CREATE TABLE public.employee_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  categoria public.documento_categoria NOT NULL,
  tipo TEXT NOT NULL,
  descricao TEXT,
  arquivo_path TEXT NOT NULL,
  arquivo_mime TEXT,
  ocr_raw JSONB,
  ocr_dados JSONB,
  status public.documento_status NOT NULL DEFAULT 'pendente',
  observacao_rh TEXT,
  reviewed_by UUID,
  reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.employee_documents ENABLE ROW LEVEL SECURITY;

CREATE POLICY "emp_docs_select" ON public.employee_documents FOR SELECT TO authenticated
  USING (auth.uid() = user_id OR public.has_role(auth.uid(), 'rh'));
CREATE POLICY "emp_docs_insert_owner" ON public.employee_documents FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = user_id);
CREATE POLICY "emp_docs_update_owner" ON public.employee_documents FOR UPDATE TO authenticated
  USING (auth.uid() = user_id AND status = 'pendente');
CREATE POLICY "emp_docs_update_rh" ON public.employee_documents FOR UPDATE TO authenticated
  USING (public.has_role(auth.uid(), 'rh'));
CREATE POLICY "emp_docs_delete_owner" ON public.employee_documents FOR DELETE TO authenticated
  USING (auth.uid() = user_id AND status = 'pendente');
CREATE POLICY "emp_docs_delete_rh" ON public.employee_documents FOR DELETE TO authenticated
  USING (public.has_role(auth.uid(), 'rh'));

CREATE TRIGGER employee_documents_updated_at BEFORE UPDATE ON public.employee_documents
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE INDEX idx_employee_documents_user ON public.employee_documents(user_id);
CREATE INDEX idx_employee_documents_status ON public.employee_documents(status);

CREATE TABLE public.document_checklist (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  categoria public.documento_categoria NOT NULL,
  tipo TEXT NOT NULL,
  obrigatorio BOOLEAN NOT NULL DEFAULT true,
  document_id UUID REFERENCES public.employee_documents(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id, tipo)
);
ALTER TABLE public.document_checklist ENABLE ROW LEVEL SECURITY;

CREATE POLICY "checklist_select" ON public.document_checklist FOR SELECT TO authenticated
  USING (auth.uid() = user_id OR public.has_role(auth.uid(), 'rh'));
CREATE POLICY "checklist_rh_all" ON public.document_checklist FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'rh')) WITH CHECK (public.has_role(auth.uid(), 'rh'));
CREATE POLICY "checklist_owner_update" ON public.document_checklist FOR UPDATE TO authenticated
  USING (auth.uid() = user_id);

CREATE INDEX idx_document_checklist_user ON public.document_checklist(user_id);

CREATE OR REPLACE FUNCTION public.seed_document_checklist()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO public.document_checklist (user_id, categoria, tipo, obrigatorio) VALUES
    (NEW.id, 'identificacao_pessoal', 'RG', true),
    (NEW.id, 'identificacao_pessoal', 'CPF', true),
    (NEW.id, 'trabalhista', 'CTPS', true),
    (NEW.id, 'trabalhista', 'Contrato de trabalho', true),
    (NEW.id, 'trabalhista', 'ASO admissional', true),
    (NEW.id, 'comprovante', 'Comprovante de residência', true),
    (NEW.id, 'comprovante', 'Dados bancários', false)
  ON CONFLICT (user_id, tipo) DO NOTHING;
  RETURN NEW;
END;
$$;

CREATE TRIGGER seed_checklist_after_profile AFTER INSERT ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.seed_document_checklist();

INSERT INTO public.document_checklist (user_id, categoria, tipo, obrigatorio)
SELECT p.id, x.categoria::public.documento_categoria, x.tipo, x.obrigatorio
FROM public.profiles p
CROSS JOIN (VALUES
  ('identificacao_pessoal','RG',true),
  ('identificacao_pessoal','CPF',true),
  ('trabalhista','CTPS',true),
  ('trabalhista','Contrato de trabalho',true),
  ('trabalhista','ASO admissional',true),
  ('comprovante','Comprovante de residência',true),
  ('comprovante','Dados bancários',false)
) AS x(categoria, tipo, obrigatorio)
ON CONFLICT (user_id, tipo) DO NOTHING;

CREATE OR REPLACE FUNCTION public.notify_documento_status()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  titulo_msg TEXT; corpo_msg TEXT;
BEGIN
  IF NEW.status = OLD.status THEN RETURN NEW; END IF;
  IF NEW.status = 'aprovado' THEN
    titulo_msg := 'Documento aprovado';
    corpo_msg := 'Seu documento "' || NEW.tipo || '" foi aprovado pelo RH.';
  ELSIF NEW.status = 'rejeitado' THEN
    titulo_msg := 'Documento rejeitado';
    corpo_msg := COALESCE('Documento "' || NEW.tipo || '" rejeitado. Motivo: ' || NEW.observacao_rh,
                          'Documento "' || NEW.tipo || '" foi rejeitado.');
  ELSE RETURN NEW; END IF;
  INSERT INTO public.notifications (user_id, tipo, titulo, mensagem)
  VALUES (NEW.user_id, 'status_documento', titulo_msg, corpo_msg);
  RETURN NEW;
END;
$$;

CREATE TRIGGER notify_documento_status_trg AFTER UPDATE ON public.employee_documents
  FOR EACH ROW EXECUTE FUNCTION public.notify_documento_status();

INSERT INTO storage.buckets (id, name, public)
VALUES ('documentos-funcionarios', 'documentos-funcionarios', false)
ON CONFLICT (id) DO NOTHING;

CREATE POLICY "docfunc_select" ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'documentos-funcionarios'
         AND (auth.uid()::text = (storage.foldername(name))[1]
              OR public.has_role(auth.uid(), 'rh')));
CREATE POLICY "docfunc_insert" ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'documentos-funcionarios'
              AND auth.uid()::text = (storage.foldername(name))[1]);
CREATE POLICY "docfunc_delete" ON storage.objects FOR DELETE TO authenticated
  USING (bucket_id = 'documentos-funcionarios'
         AND (auth.uid()::text = (storage.foldername(name))[1]
              OR public.has_role(auth.uid(), 'rh')));
