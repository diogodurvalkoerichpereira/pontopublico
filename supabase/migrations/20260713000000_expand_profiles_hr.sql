-- Expansão cadastral/funcional de profiles para uso de RH profissional.
-- Todas as colunas são ADITIVAS, nullable e não destrutivas (seguras/reversíveis).

-- ── Dados pessoais ──
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS data_nascimento date;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS sexo text;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS estado_civil text;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS nacionalidade text;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS naturalidade text;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS nome_mae text;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS nome_pai text;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS escolaridade text;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS raca_cor text;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS pcd boolean DEFAULT false;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS tipo_deficiencia text;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS email_pessoal text;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS celular text;

-- ── Documentos ──
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS rg text;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS rg_orgao_emissor text;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS rg_uf text;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS rg_data_emissao date;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS pis_pasep text;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS ctps_numero text;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS ctps_serie text;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS ctps_uf text;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS titulo_eleitor text;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS titulo_zona text;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS titulo_secao text;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS reservista text;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS cnh_numero text;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS cnh_categoria text;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS cnh_validade date;

-- ── Endereço estruturado ──
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS cep text;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS logradouro text;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS numero_endereco text;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS complemento text;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS bairro text;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS cidade text;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS uf text;

-- ── Dados contratuais/funcionais ──
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS tipo_contrato text;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS regime_trabalho text;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS data_demissao date;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS cbo text;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS jornada_semanal_horas numeric;

-- ── Dados bancários (pagamento) ──
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS banco text;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS agencia text;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS conta text;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS tipo_conta text;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS chave_pix text;
