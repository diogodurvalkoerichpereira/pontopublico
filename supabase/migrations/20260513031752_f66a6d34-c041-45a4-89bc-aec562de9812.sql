-- Tabela de notificações internas
CREATE TABLE public.notifications (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  tipo TEXT NOT NULL,
  titulo TEXT NOT NULL,
  mensagem TEXT NOT NULL,
  atestado_id UUID,
  lida BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_notifications_user_lida ON public.notifications(user_id, lida, created_at DESC);

ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Usuario le suas notificacoes"
  ON public.notifications FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "Usuario atualiza suas notificacoes"
  ON public.notifications FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id);

-- Realtime
ALTER TABLE public.notifications REPLICA IDENTITY FULL;
ALTER PUBLICATION supabase_realtime ADD TABLE public.notifications;

-- Função: notificar RH quando novo atestado é criado
CREATE OR REPLACE FUNCTION public.notify_rh_novo_atestado()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  rh_user RECORD;
  emp_nome TEXT;
BEGIN
  SELECT COALESCE(full_name, email, 'Funcionário') INTO emp_nome
  FROM public.profiles WHERE id = NEW.user_id;

  FOR rh_user IN
    SELECT user_id FROM public.user_roles WHERE role = 'rh'
  LOOP
    INSERT INTO public.notifications (user_id, tipo, titulo, mensagem, atestado_id)
    VALUES (
      rh_user.user_id,
      'novo_atestado',
      'Novo atestado recebido',
      emp_nome || ' enviou um atestado para análise.',
      NEW.id
    );
  END LOOP;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_notify_rh_novo_atestado
AFTER INSERT ON public.atestados
FOR EACH ROW EXECUTE FUNCTION public.notify_rh_novo_atestado();

-- Função: notificar funcionário quando status muda
CREATE OR REPLACE FUNCTION public.notify_funcionario_status()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  titulo_msg TEXT;
  corpo_msg TEXT;
BEGIN
  IF NEW.status = OLD.status THEN
    RETURN NEW;
  END IF;

  IF NEW.status = 'aprovado' THEN
    titulo_msg := 'Atestado aprovado';
    corpo_msg := 'Seu atestado foi aprovado pelo RH.';
  ELSIF NEW.status = 'rejeitado' THEN
    titulo_msg := 'Atestado rejeitado';
    corpo_msg := COALESCE('Seu atestado foi rejeitado. Motivo: ' || NEW.rh_observacao, 'Seu atestado foi rejeitado pelo RH.');
  ELSE
    RETURN NEW;
  END IF;

  INSERT INTO public.notifications (user_id, tipo, titulo, mensagem, atestado_id)
  VALUES (NEW.user_id, 'status_atestado', titulo_msg, corpo_msg, NEW.id);

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_notify_funcionario_status
AFTER UPDATE ON public.atestados
FOR EACH ROW EXECUTE FUNCTION public.notify_funcionario_status();
