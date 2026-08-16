
-- Profiles: permitir RH com manage_employees + admin editar qualquer perfil
DROP POLICY IF EXISTS "Users update own profile" ON public.profiles;
CREATE POLICY "profiles_update_own_or_rh" ON public.profiles
  FOR UPDATE TO authenticated
  USING (auth.uid() = id OR public.has_permission(auth.uid(), 'manage_employees') OR public.has_role(auth.uid(), 'admin'))
  WITH CHECK (auth.uid() = id OR public.has_permission(auth.uid(), 'manage_employees') OR public.has_role(auth.uid(), 'admin'));

-- Profiles: admin pode inserir e deletar
CREATE POLICY "profiles_admin_insert" ON public.profiles
  FOR INSERT TO authenticated
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "profiles_admin_delete" ON public.profiles
  FOR DELETE TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

-- Profiles: admin pode ler todos (já coberto via has_role rh, mas garantir)
DROP POLICY IF EXISTS "Users read own profile" ON public.profiles;
CREATE POLICY "profiles_select" ON public.profiles
  FOR SELECT TO authenticated
  USING (auth.uid() = id OR public.has_role(auth.uid(), 'rh') OR public.has_role(auth.uid(), 'admin'));

-- user_roles: admin pode INSERT/DELETE/UPDATE
CREATE POLICY "user_roles_admin_insert" ON public.user_roles
  FOR INSERT TO authenticated
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "user_roles_admin_delete" ON public.user_roles
  FOR DELETE TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

-- user_roles: admin também pode ler todos
DROP POLICY IF EXISTS "Users read own roles" ON public.user_roles;
CREATE POLICY "user_roles_select" ON public.user_roles
  FOR SELECT TO authenticated
  USING (auth.uid() = user_id OR public.has_role(auth.uid(), 'rh') OR public.has_role(auth.uid(), 'admin'));
