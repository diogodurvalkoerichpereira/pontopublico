-- Exportação VT/VA: cadastro de unidades (dados da empresa) + configuração de
-- benefício por funcionário. Tudo ADITIVO, idempotente e não destrutivo.

-- ── Unidades (bloco "empresa" do layout da operadora) ──
CREATE TABLE IF NOT EXISTS public.unidades (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nome text NOT NULL,
  cnpj text,
  cep text,
  logradouro text,
  numero text,
  complemento text,
  ponto_referencia text,
  uf text,
  estado text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.unidades ENABLE ROW LEVEL SECURITY;

DROP TRIGGER IF EXISTS trg_unidades_updated ON public.unidades;
CREATE TRIGGER trg_unidades_updated BEFORE UPDATE ON public.unidades
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ── Vínculo do funcionário à unidade + config de benefício (VT/VA) ──
-- Valor unitário reaproveita vale_transporte_diario / vale_alimentacao_diario.
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS unidade_id uuid REFERENCES public.unidades(id);
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS tipo_chave_pix text;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS vt_beneficio_codigo text;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS vt_quantidade_diaria numeric;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS vt_tipo_valor text;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS vt_rede_recarga text;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS va_beneficio_codigo text;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS va_quantidade_diaria numeric;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS va_tipo_valor text;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS va_rede_recarga text;
