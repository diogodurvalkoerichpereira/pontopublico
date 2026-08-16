-- Configuração de notificações por e-mail (SMTP). Linha única. Aditivo/idempotente.
CREATE TABLE IF NOT EXISTS public.email_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  enabled boolean NOT NULL DEFAULT false,
  smtp_host text,
  smtp_port integer DEFAULT 587,
  smtp_secure boolean NOT NULL DEFAULT false,
  smtp_user text,
  smtp_password text,
  from_email text,
  from_name text,
  notify_on_release boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Semente da linha única (remetente meuponto@empresa.com.br), se ainda não existir.
INSERT INTO public.email_settings (from_email, from_name, smtp_user)
SELECT 'meuponto@empresa.com.br', 'Meu Ponto', 'meuponto@empresa.com.br'
WHERE NOT EXISTS (SELECT 1 FROM public.email_settings);
