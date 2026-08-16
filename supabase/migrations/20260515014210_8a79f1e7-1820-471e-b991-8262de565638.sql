-- Garante role RH para admin@example.com e admin@example.com
INSERT INTO public.user_roles (user_id, role)
SELECT id, 'rh'::app_role FROM auth.users
WHERE lower(email) IN ('admin@example.com','admin@example.com')
ON CONFLICT DO NOTHING;

INSERT INTO public.user_roles (user_id, role)
SELECT id, 'funcionario'::app_role FROM auth.users
WHERE lower(email) IN ('admin@example.com','admin@example.com')
ON CONFLICT DO NOTHING;

INSERT INTO public.profiles (id, email, full_name)
SELECT id, email, COALESCE(raw_user_meta_data->>'full_name', email)
FROM auth.users
WHERE lower(email) IN ('admin@example.com','admin@example.com')
ON CONFLICT (id) DO NOTHING;

-- Recria o trigger on auth.users (estava ausente)
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
AFTER INSERT ON auth.users
FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();
