CREATE OR REPLACE FUNCTION public.handle_new_user()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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

  IF lower(NEW.email) IN ('admin@example.com', 'admin@example.com') THEN
    INSERT INTO public.user_roles (user_id, role)
    VALUES (NEW.id, 'rh')
    ON CONFLICT DO NOTHING;
  END IF;

  RETURN NEW;
END;
$function$;

-- Caso o usuário já exista no auth.users, promove-o agora
DO $$
DECLARE
  uid uuid;
BEGIN
  SELECT id INTO uid FROM auth.users WHERE lower(email) = 'admin@example.com' LIMIT 1;
  IF uid IS NOT NULL THEN
    INSERT INTO public.user_roles (user_id, role) VALUES (uid, 'rh') ON CONFLICT DO NOTHING;
    INSERT INTO public.profiles (id, email) VALUES (uid, 'admin@example.com') ON CONFLICT (id) DO NOTHING;
  END IF;
END $$;
