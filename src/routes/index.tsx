import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { useAuth } from "@/lib/auth-context";

export const Route = createFileRoute("/")({
  component: Index,
});

function Index() {
  const { session, isAdmin, isRh, loading } = useAuth();
  const nav = useNavigate();
  useEffect(() => {
    if (loading) return;
    if (!session) nav({ to: "/login" });
    else if (isAdmin) nav({ to: "/admin/usuarios" });
    else if (isRh) nav({ to: "/rh" });
    else nav({ to: "/app" });
  }, [session, isAdmin, isRh, loading, nav]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-background">
      <div className="flex items-center gap-3 text-muted-foreground text-sm">
        <div className="size-2 rounded-full bg-primary animate-pulse" />
        Carregando...
      </div>
    </div>
  );
}
