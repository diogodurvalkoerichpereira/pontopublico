import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  Outlet,
  Link,
  createRootRouteWithContext,
  useRouter,
  HeadContent,
  Scripts,
} from "@tanstack/react-router";
import { Toaster } from "@/components/ui/sonner";
import { AuthProvider } from "@/lib/auth-context";
import { PwaRuntime } from "@/components/PwaRuntime";
import appCss from "../styles.css?url";

function NotFoundComponent() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="text-7xl font-bold text-foreground">404</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Página não encontrada.
        </p>
        <Link
          to="/"
          className="mt-6 inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
        >
          Ir para o início
        </Link>
      </div>
    </div>
  );
}

function ErrorComponent({ error, reset }: { error: Error; reset: () => void }) {
  console.error(error);
  const router = useRouter();
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="text-xl font-semibold">Algo deu errado</h1>
        <p className="mt-2 text-sm text-muted-foreground">{error.message}</p>
        <button
          onClick={() => {
            router.invalidate();
            reset();
          }}
          className="mt-6 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
        >
          Tentar novamente
        </button>
      </div>
    </div>
  );
}

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()(
  {
    head: () => ({
      meta: [
        { charSet: "utf-8" },
        { name: "viewport", content: "width=device-width, initial-scale=1" },
        { title: "Meu Ponto — Atestados médicos digitais e gestão de RH." },
        {
          name: "description",
          content:
            "Envio de atestados médicos com fluxo de aprovação para o RH. Conformidade LGPD. Além de toda gestão completa e integração de colaboradores.",
        },
        {
          property: "og:title",
          content: "Meu Ponto — Atestados médicos digitais e gestão de RH.",
        },
        {
          property: "og:description",
          content:
            "Envio de atestados médicos com fluxo de aprovação para o RH. Conformidade LGPD. Além de toda gestão completa e integração de colaboradores.",
        },
        { property: "og:type", content: "website" },
        { name: "twitter:card", content: "summary" },
        {
          name: "twitter:title",
          content: "Meu Ponto — Atestados médicos digitais e gestão de RH.",
        },
        {
          name: "twitter:description",
          content:
            "Envio de atestados médicos com fluxo de aprovação para o RH. Conformidade LGPD. Além de toda gestão completa e integração de colaboradores.",
        },
        {
          property: "og:image",
          content:
            "https://storage.googleapis.com/gpt-engineer-file-uploads/attachments/og-images/ae5b4896-54e6-47ba-82e2-82cc0a613b77",
        },
        {
          name: "twitter:image",
          content:
            "https://storage.googleapis.com/gpt-engineer-file-uploads/attachments/og-images/ae5b4896-54e6-47ba-82e2-82cc0a613b77",
        },
      ],
      links: [
        { rel: "stylesheet", href: appCss },
        { rel: "icon", href: "/favicon.jpg", type: "image/jpeg" },
        { rel: "manifest", href: "/manifest.webmanifest" },
      ],
    }),
    shellComponent: RootShell,
    component: RootComponent,
    notFoundComponent: NotFoundComponent,
    errorComponent: ErrorComponent,
  },
);

function RootShell({ children }: { children: React.ReactNode }) {
  return (
    <html lang="pt-BR">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}

function RootComponent() {
  const { queryClient } = Route.useRouteContext();
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <PwaRuntime />
        <Outlet />
        <Toaster richColors position="top-center" />
      </AuthProvider>
    </QueryClientProvider>
  );
}
