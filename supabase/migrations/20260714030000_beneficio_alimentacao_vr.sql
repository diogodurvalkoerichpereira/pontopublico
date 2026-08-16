-- Opção do colaborador entre Vale Alimentação (VA) e Vale Refeição (VR).
-- O valor diário continua em vale_alimentacao_diario; este campo define apenas
-- qual dos dois benefícios (e qual contrato) se aplica na exportação.
-- Aditivo e idempotente.

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS beneficio_alimentacao text NOT NULL DEFAULT 'VA';

ALTER TABLE public.profiles
  DROP CONSTRAINT IF EXISTS profiles_beneficio_alimentacao_check;

ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_beneficio_alimentacao_check
  CHECK (beneficio_alimentacao IN ('VA', 'VR'));
