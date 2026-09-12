-- O0-09 — Segundo fator (TOTP) para operacoes de alto risco.
--
-- Permissoes irreversiveis (fechar/reabrir folha, administrar papeis de
-- seguranca e entidades) passam a exigir um segundo fator alem da senha. A
-- verificacao e uma vez por sessao: quem confere o TOTP carimba a sessao como
-- MFA-backed pelo resto da vida dela (24h). Ver src/lib/mfa.server.ts e
-- src/lib/mfa.functions.ts.
--
-- Aditiva. O segredo TOTP nunca sai do schema private e e cifrado em repouso
-- com AES-256-GCM sob a chave dedicada MFA_ENC_KEY (fora do banco).

-- Carimbo do segundo fator na sessao atual. Nulo = sessao ainda nao verificou.
alter table private.auth_sessions add column if not exists mfa_verified_at timestamptz;

-- Fator TOTP por usuario. secret_enc guarda o ciphertext AES-256-GCM no formato
-- iv:tag:dados (hex). confirmed_at nulo = inscricao pendente (segredo gerado mas
-- ainda nao confirmado por um codigo). backup_codes_hash sao hashes scrypt no
-- mesmo formato de auth.server.ts (scrypt$salt$derivado), consumidos ao usar.
create table if not exists private.auth_mfa_factors (
  user_id uuid primary key references public.app_users(id) on delete cascade,
  secret_enc text not null,
  confirmed_at timestamptz,
  backup_codes_hash text[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- O schema private ja e negado ao public (Sprint 4); reforca para a tabela nova.
revoke all on private.auth_mfa_factors from public;
