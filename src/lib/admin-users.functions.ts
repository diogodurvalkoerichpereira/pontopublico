// Reexporta as server functions de administração (agora implementadas sobre
// PostgreSQL próprio em data.functions.ts). Mantido para não alterar os imports
// existentes em admin.usuarios.tsx.
export {
  adminCreateUser,
  adminDeleteUser,
  adminResetPassword,
  adminUpdateUserEmail,
} from "@/lib/data.functions";
