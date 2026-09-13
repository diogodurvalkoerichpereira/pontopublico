import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "@/lib/auth-context";
import {
  LogOut,
  FileText,
  ShieldCheck,
  Users,
  FolderOpen,
  Clock,
  Hourglass,
  CalendarRange,
  Eye,
  Calendar,
  UserCog,
  Menu,
  ChevronRight,
  ChevronDown,
  User,
  Home,
  Ticket,
  Settings,
  Building2,
  LockKeyhole,
  FileClock,
  UsersRound,
  ArrowRightLeft,
  ReceiptText,
  FlaskConical,
  ListChecks,
  Sparkles,
  BriefcaseBusiness,
  Palmtree,
  FileUp,
  BadgeDollarSign,
  ChartNoAxesCombined,
  DatabaseZap,
  Scale,
  Bot,
  ArchiveRestore,
  Landmark,
  Wallet,
  MessageSquareWarning,
  PiggyBank,
  Banknote,
  BookOpen,
  CalendarClock,
  ClipboardList,
  CreditCard,
  FileSignature,
  Boxes,
  Building,
  FileStack,
  Gavel,
  Car,
  FileSearch,
  ShieldAlert,
  BarChart3,
} from "lucide-react";
import { NotificationBell } from "@/components/NotificationBell";
import { SupportWidget } from "@/components/SupportWidget";

// Paleta neutra do shell (hex fixos, espelham os tokens de src/styles.css)
const NAVY = "#1e293b";
const AMBER = "#3b82f6";
const ACCENT = "#2563eb";
const HOVER = "#1d4ed8";
const ACTIVE = "#334155";
const SIDE_TEXT = "#e2e8f0";

type NavItemDef = {
  to: string;
  label: string;
  icon: typeof FileText;
  section: string;
};

function NavLinkItem({
  item,
  active,
  collapsed,
  onNavigate,
}: {
  item: NavItemDef;
  active: boolean;
  collapsed: boolean;
  onNavigate: () => void;
}) {
  const Icon = item.icon;
  return (
    <Link
      to={item.to}
      title={collapsed ? item.label : undefined}
      onClick={onNavigate}
      className={`flex items-center gap-3 py-2.5 text-xs font-medium transition-colors ${
        collapsed ? "justify-center px-2" : "px-5"
      }`}
      style={{
        color: active ? "#fff" : SIDE_TEXT,
        background: active ? ACTIVE : undefined,
      }}
      onMouseEnter={(e) => {
        if (!active) {
          e.currentTarget.style.background = HOVER;
          e.currentTarget.style.color = "#fff";
        }
      }}
      onMouseLeave={(e) => {
        if (!active) {
          e.currentTarget.style.background = "transparent";
          e.currentTarget.style.color = SIDE_TEXT;
        }
      }}
    >
      <Icon className="size-4 flex-shrink-0" />
      {!collapsed && <span>{item.label}</span>}
    </Link>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const {
    isAdmin,
    isRh,
    user,
    signOut,
    hasPermission,
    tenants,
    activeTenant,
    setActiveTenant,
    hasTenantPermission,
  } = useAuth();
  const nav = useNavigate();
  const { location } = useRouterState();

  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const userMenuRef = useRef<HTMLDivElement>(null);

  // Colapsa a sidebar em telas pequenas ao montar
  useEffect(() => {
    if (typeof window !== "undefined" && window.innerWidth < 768)
      setSidebarOpen(false);
  }, []);

  // Fecha o menu do usuário ao clicar fora
  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (
        userMenuRef.current &&
        !userMenuRef.current.contains(e.target as Node)
      )
        setUserMenuOpen(false);
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  const items: NavItemDef[] = [];
  if (isAdmin) {
    items.push({
      to: "/admin/usuarios",
      label: "Usuários",
      icon: UserCog,
      section: "Administração",
    });
    items.push({
      to: "/admin/configuracoes",
      label: "Configurações",
      icon: Settings,
      section: "Administração",
    });
  }
  if (hasTenantPermission("org.read")) {
    items.push({
      to: "/admin/estrutura",
      label: "Estrutura",
      icon: Building2,
      section: "Governança",
    });
  }
  if (hasTenantPermission("security.read")) {
    items.push({
      to: "/admin/seguranca",
      label: "Papéis e acessos",
      icon: LockKeyhole,
      section: "Governança",
    });
  }
  if (hasTenantPermission("audit.read")) {
    items.push({
      to: "/admin/auditoria",
      label: "Auditoria",
      icon: FileClock,
      section: "Governança",
    });
  }
  if (hasTenantPermission("people.read")) {
    items.push({
      to: "/rh/pessoas",
      label: "Pessoas e vínculos",
      icon: Users,
      section: "Recursos Humanos",
    });
  }
  if (hasTenantPermission("people.read")) {
    items.push({
      to: "/consignacoes",
      label: "Consignações",
      icon: CreditCard,
      section: "Recursos Humanos",
    });
  }
  if (hasTenantPermission("family.read")) {
    items.push({
      to: "/rh/familia",
      label: "Dependentes e pensões",
      icon: UsersRound,
      section: "Recursos Humanos",
    });
  }
  if (hasTenantPermission("movements.read")) {
    items.push({
      to: "/rh/movimentacoes",
      label: "Movimentações",
      icon: ArrowRightLeft,
      section: "Recursos Humanos",
    });
  }
  if (hasTenantPermission("people.read")) {
    items.push({
      to: "/rh/apuracao",
      label: "Apuração de ponto",
      icon: Clock,
      section: "Recursos Humanos",
    });
  }
  if (hasTenantPermission("people.read")) {
    items.push({
      to: "/rh/banco-horas",
      label: "Banco de horas",
      icon: Hourglass,
      section: "Recursos Humanos",
    });
  }
  if (hasTenantPermission("people.read")) {
    items.push({
      to: "/rh/jornadas",
      label: "Jornadas semanais",
      icon: CalendarRange,
      section: "Recursos Humanos",
    });
  }
  if (hasTenantPermission("payroll.catalog.read")) {
    items.push({
      to: "/rh/rubricas",
      label: "Rubricas",
      icon: ReceiptText,
      section: "Folha de Pagamento",
    });
  }
  if (
    hasTenantPermission("payroll.assignments.read") ||
    hasTenantPermission("payroll.simulate")
  ) {
    items.push({
      to: "/rh/simulacoes",
      label: "Eventos e simulação",
      icon: FlaskConical,
      section: "Folha de Pagamento",
    });
  }
  if (hasTenantPermission("payroll.cycles.read")) {
    items.push({
      to: "/rh/ciclos",
      label: "Ciclo mensal",
      icon: ListChecks,
      section: "Folha de Pagamento",
    });
  }
  if (hasTenantPermission("payroll.special.read")) {
    items.push({
      to: "/rh/folhas-especiais",
      label: "Folhas especiais",
      icon: Sparkles,
      section: "Folha de Pagamento",
    });
  }
  if (
    hasTenantPermission("employment.special.read") ||
    hasTenantPermission("termination.read")
  ) {
    items.push({
      to: "/rh/eventos-funcionais",
      label: "Eventos e rescisões",
      icon: BriefcaseBusiness,
      section: "Recursos Humanos",
    });
  }
  if (hasTenantPermission("vacation.read"))
    items.push({
      to: "/rh/ferias",
      label: "Férias",
      icon: Palmtree,
      section: "Recursos Humanos",
    });
  if (hasTenantPermission("people.read"))
    items.push({
      to: "/rh/previdencia",
      label: "Previdência",
      icon: Landmark,
      section: "Recursos Humanos",
    });
  if (hasTenantPermission("fiscal.read"))
    items.push({
      to: "/rh/tabelas-fiscais",
      label: "Tabelas fiscais",
      icon: Scale,
      section: "Folha de Pagamento",
    });
  if (hasTenantPermission("payroll.import.read"))
    items.push({
      to: "/rh/importacoes",
      label: "Importações",
      icon: FileUp,
      section: "Folha de Pagamento",
    });
  if (isRh) {
    items.push({
      to: "/rh",
      label: "Atestados",
      icon: ShieldCheck,
      section: "Recursos Humanos",
    });
    if (
      hasPermission("manage_employees") &&
      !hasTenantPermission("people.read")
    )
      items.push({
        to: "/rh/funcionarios",
        label: "Funcionários",
        icon: Users,
        section: "Recursos Humanos",
      });
    if (hasPermission("configure_schedules"))
      items.push({
        to: "/rh/escalas",
        label: "Escalas",
        icon: Calendar,
        section: "Recursos Humanos",
      });
    // A folha legada (/rh/folha, payroll_periods) foi aposentada no O0-13; a
    // única folha é /rh/ciclos (payroll_cycles). Ver ADR 0005 e 0017.
    if (hasPermission("manage_employees"))
      items.push({
        to: "/rh/vt-va",
        label: "VT e VA / VR",
        icon: Ticket,
        section: "Recursos Humanos",
      });
  }
  if (!isRh && !isAdmin) {
    items.push({
      to: "/app",
      label: "Atestados",
      icon: FileText,
      section: "Geral",
    });
  }
  items.push({ to: "/ponto", label: "Ponto", icon: Clock, section: "Geral" });
  items.push({
    to: "/portal-financeiro",
    label: "Portal financeiro",
    icon: BadgeDollarSign,
    section: "Geral",
  });
  items.push({
    to: "/conta/seguranca",
    label: "Segurança da conta",
    icon: ShieldCheck,
    section: "Geral",
  });
  if (hasTenantPermission("budget.read"))
    items.push({
      to: "/orcamento",
      label: "Orçamento",
      icon: PiggyBank,
      section: "Contabilidade e Finanças",
    });
  if (hasTenantPermission("budget.read"))
    items.push({
      to: "/empenhos",
      label: "Empenhos",
      icon: ReceiptText,
      section: "Contabilidade e Finanças",
    });
  if (hasTenantPermission("budget.read"))
    items.push({
      to: "/receitas",
      label: "Receitas",
      icon: BadgeDollarSign,
      section: "Contabilidade e Finanças",
    });
  if (hasTenantPermission("accounting.read"))
    items.push({
      to: "/tesouraria",
      label: "Tesouraria",
      icon: Wallet,
      section: "Contabilidade e Finanças",
    });
  if (hasTenantPermission("accounting.read"))
    items.push({
      to: "/ordens-bancarias",
      label: "Ordens bancárias",
      icon: Banknote,
      section: "Contabilidade e Finanças",
    });
  if (hasTenantPermission("accounting.read"))
    items.push({
      to: "/contabilidade",
      label: "Contabilidade",
      icon: BookOpen,
      section: "Contabilidade e Finanças",
    });
  if (hasTenantPermission("budget.read"))
    items.push({
      to: "/balancos",
      label: "Balanços",
      icon: BarChart3,
      section: "Contabilidade e Finanças",
    });
  if (hasTenantPermission("budget.read"))
    items.push({
      to: "/restos-a-pagar",
      label: "Restos a Pagar",
      icon: FileStack,
      section: "Contabilidade e Finanças",
    });
  if (hasTenantPermission("taxes.read"))
    items.push({
      to: "/tributos",
      label: "Tributos",
      icon: Landmark,
      section: "Contabilidade e Finanças",
    });
  if (hasTenantPermission("taxes.read"))
    items.push({
      to: "/imoveis",
      label: "Cadastro imobiliário",
      icon: Landmark,
      section: "Contabilidade e Finanças",
    });
  if (hasTenantPermission("taxes.read"))
    items.push({
      to: "/divida-ativa",
      label: "Dívida ativa",
      icon: Scale,
      section: "Contabilidade e Finanças",
    });
  if (hasTenantPermission("taxes.read"))
    items.push({
      to: "/parcelamentos",
      label: "Parcelamentos",
      icon: CalendarClock,
      section: "Contabilidade e Finanças",
    });
  if (hasTenantPermission("transparency.read"))
    items.push({
      to: "/transparencia",
      label: "Transparência",
      icon: Eye,
      section: "Contabilidade e Finanças",
    });
  if (hasTenantPermission("contracts.read"))
    items.push({
      to: "/licitacoes",
      label: "Licitações",
      icon: Gavel,
      section: "Contratações",
    });
  if (hasTenantPermission("contracts.read"))
    items.push({
      to: "/atas",
      label: "Registro de Preços",
      icon: ClipboardList,
      section: "Contratações",
    });
  if (hasTenantPermission("contracts.read"))
    items.push({
      to: "/contratos",
      label: "Contratos",
      icon: FileSignature,
      section: "Contratações",
    });
  if (hasTenantPermission("materials.read"))
    items.push({
      to: "/almoxarifado",
      label: "Almoxarifado",
      icon: Boxes,
      section: "Materiais e Patrimônio",
    });
  if (hasTenantPermission("assets.read"))
    items.push({
      to: "/patrimonio",
      label: "Patrimônio",
      icon: Building,
      section: "Materiais e Patrimônio",
    });
  if (hasTenantPermission("assets.read"))
    items.push({
      to: "/frotas",
      label: "Frotas",
      icon: Car,
      section: "Materiais e Patrimônio",
    });
  if (hasTenantPermission("protocol.read"))
    items.push({
      to: "/protocolo",
      label: "Protocolo",
      icon: FileStack,
      section: "Controle e Transparência",
    });
  if (hasTenantPermission("protocol.read"))
    items.push({
      to: "/ouvidoria",
      label: "Ouvidoria",
      icon: MessageSquareWarning,
      section: "Controle e Transparência",
    });
  if (hasTenantPermission("protocol.read"))
    items.push({
      to: "/esic",
      label: "e-SIC",
      icon: FileSearch,
      section: "Controle e Transparência",
    });
  if (hasTenantPermission("protocol.read"))
    items.push({
      to: "/carta-servicos",
      label: "Carta de Serviços",
      icon: BookOpen,
      section: "Controle e Transparência",
    });
  if (hasTenantPermission("analytics.read"))
    items.push({
      to: "/controle-interno",
      label: "Controle interno",
      icon: ShieldAlert,
      section: "Controle e Transparência",
    });
  if (hasTenantPermission("manager.dashboard.read"))
    items.push({
      to: "/gestor",
      label: "Painel gestor",
      icon: ChartNoAxesCombined,
      section: "Gestão",
    });
  if (hasTenantPermission("analytics.read"))
    items.push({
      to: "/admin/data-mart",
      label: "Data mart",
      icon: DatabaseZap,
      section: "Inteligência",
    });
  if (hasTenantPermission("fiscal.read"))
    items.push({
      to: "/gestor/lrf",
      label: "LRF e RCL",
      icon: Scale,
      section: "Inteligência",
    });
  if (hasTenantPermission("ai.analytics.use"))
    items.push({
      to: "/gestor/assistente",
      label: "Assistente analítico",
      icon: Bot,
      section: "Inteligência",
    });
  if (hasTenantPermission("migration.read"))
    items.push({
      to: "/admin/migracao-historica",
      label: "Migração histórica",
      icon: ArchiveRestore,
      section: "Administração",
    });
  items.push({
    to: "/meus-documentos",
    label: "Documentos",
    icon: FolderOpen,
    section: "Geral",
  });

  const isActive = (to: string) =>
    to === "/rh"
      ? location.pathname === "/rh"
      : location.pathname.startsWith(to);

  const sections = items.reduce<Record<string, NavItemDef[]>>((acc, item) => {
    (acc[item.section] ??= []).push(item);
    return acc;
  }, {});

  const homeTo = isAdmin ? "/admin/usuarios" : isRh ? "/rh" : "/app";

  // Iniciais a partir do e-mail
  const emailLocal = (user?.email ?? "").split("@")[0];
  const initials =
    emailLocal
      .split(/[.\-_]/)
      .filter(Boolean)
      .slice(0, 2)
      .map((s) => s[0])
      .join("")
      .toUpperCase() ||
    emailLocal.slice(0, 2).toUpperCase() ||
    "?";
  const firstName = emailLocal.split(/[.\-_]/)[0] || "Usuário";

  // Breadcrumb
  const LABELS: Record<string, string> = {
    admin: "Administração",
    usuarios: "Usuários",
    rh: "Atestados",
    funcionarios: "Funcionários",
    escalas: "Escalas",
    folha: "Folha",
    app: "Atestados",
    ponto: "Ponto",
    "meus-documentos": "Documentos",
    "vt-va": "VT e VA / VR",
    configuracoes: "Configurações",
    estrutura: "Estrutura",
    seguranca: "Papéis e acessos",
    auditoria: "Auditoria",
    pessoas: "Pessoas e vínculos",
    familia: "Dependentes e pensões",
    movimentacoes: "Movimentações",
    rubricas: "Rubricas",
    simulacoes: "Eventos e simulação",
    ciclos: "Ciclo mensal",
    "folhas-especiais": "Folhas especiais",
    "eventos-funcionais": "Eventos e rescisões",
    ferias: "Férias",
    importacoes: "Importações",
    "portal-financeiro": "Portal financeiro",
    gestor: "Painel gestor",
    "data-mart": "Data mart",
    lrf: "LRF e RCL",
    assistente: "Assistente analítico",
    "migracao-historica": "Migração histórica",
  };
  const breadcrumb = useMemo(() => {
    const segs = location.pathname.split("/").filter(Boolean);
    const UUID =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    return segs.map((seg, i) => ({
      label: UUID.test(seg) ? seg.slice(0, 8) + "…" : (LABELS[seg] ?? seg),
      href: "/" + segs.slice(0, i + 1).join("/"),
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.pathname]);

  const doLogout = async () => {
    await signOut();
    nav({ to: "/login" });
  };

  return (
    <div className="flex h-screen flex-col" style={{ background: "#f0f2f5" }}>
      <SupportWidget />
      {/* ── Header ── */}
      <header
        className="z-50 flex flex-shrink-0 items-center justify-between px-4"
        style={{
          background: NAVY,
          height: 76,
          borderBottom: `2px solid ${AMBER}`,
        }}
      >
        <div className="flex items-center gap-3">
          <button
            onClick={() => setSidebarOpen((v) => !v)}
            className="rounded p-1.5 transition-colors"
            style={{ color: "rgba(255,255,255,0.7)" }}
            onMouseEnter={(e) => (e.currentTarget.style.color = "#fff")}
            onMouseLeave={(e) =>
              (e.currentTarget.style.color = "rgba(255,255,255,0.7)")
            }
            aria-label="Menu"
          >
            <Menu className="size-5" />
          </button>
          <Link to={homeTo} className="flex items-center gap-2.5">
            <span
              className="flex size-9 items-center justify-center rounded-lg font-bold text-white"
              style={{ background: ACCENT, fontSize: 15 }}
              aria-hidden="true"
            >
              MP
            </span>
            <span className="text-lg font-semibold tracking-tight text-white">
              Meu Ponto
            </span>
          </Link>
          <div
            className="hidden items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium sm:flex"
            style={{
              background: "rgba(255,255,255,0.1)",
              color: "rgba(255,255,255,0.75)",
            }}
          >
            <Clock className="size-3" />
            Ponto & RH
          </div>
        </div>

        <div className="flex items-center gap-3">
          {activeTenant && (
            <div className="hidden items-center gap-2 lg:flex">
              <Building2
                className="size-4"
                style={{ color: "rgba(255,255,255,0.65)" }}
              />
              <select
                value={activeTenant.id}
                onChange={(event) => void setActiveTenant(event.target.value)}
                className="max-w-60 rounded-md border px-2 py-1.5 text-xs font-semibold outline-none"
                style={{
                  color: "#fff",
                  background: "rgba(255,255,255,0.1)",
                  borderColor: "rgba(255,255,255,0.2)",
                }}
                aria-label="Entidade ativa"
              >
                {tenants.map((tenant) => (
                  <option
                    key={tenant.id}
                    value={tenant.id}
                    style={{ color: "#111", background: "#fff" }}
                  >
                    {tenant.nome}
                  </option>
                ))}
              </select>
            </div>
          )}
          <NotificationBell />
          <div
            ref={userMenuRef}
            className="relative flex items-center gap-2 border-l pl-3"
            style={{ borderColor: "rgba(255,255,255,0.2)" }}
          >
            <button
              onClick={() => setUserMenuOpen((v) => !v)}
              className="flex items-center gap-2 transition-opacity hover:opacity-80"
            >
              <div
                className="flex size-8 items-center justify-center rounded-full text-xs font-bold text-white"
                style={{ background: ACCENT }}
              >
                {initials}
              </div>
              <span
                className="hidden text-sm capitalize sm:block"
                style={{ color: "rgba(255,255,255,0.85)" }}
              >
                {firstName}
              </span>
              <ChevronDown
                className="size-3"
                style={{ color: "rgba(255,255,255,0.4)" }}
              />
            </button>
            {userMenuOpen && (
              <div className="absolute right-0 top-full z-50 mt-2 w-52 rounded-lg border border-gray-100 bg-white py-1 shadow-lg">
                <div className="border-b border-gray-100 px-3 py-2">
                  <p className="truncate text-xs font-semibold text-gray-900">
                    {user?.email}
                  </p>
                  <p className="text-xs text-gray-400">
                    {isAdmin ? "Administrador" : isRh ? "RH" : "Colaborador"}
                  </p>
                </div>
                <Link
                  to="/meus-documentos"
                  onClick={() => setUserMenuOpen(false)}
                  className="flex w-full items-center gap-2 px-3 py-2 text-sm text-gray-700 transition-colors hover:bg-gray-50"
                >
                  <User className="size-4" /> Meus documentos
                </Link>
                <div className="my-1 border-t border-gray-100" />
                <button
                  onClick={doLogout}
                  className="flex w-full items-center gap-2 px-3 py-2 text-sm text-red-600 transition-colors hover:bg-red-50"
                >
                  <LogOut className="size-4" /> Sair
                </button>
              </div>
            )}
          </div>
        </div>
      </header>

      <div className="flex flex-1 overflow-hidden">
        {/* ── Sidebar ── */}
        <aside
          className="flex flex-shrink-0 flex-col border-r transition-all duration-200"
          style={{
            width: sidebarOpen ? 220 : 56,
            overflow: "hidden",
            background: NAVY,
            borderColor: "rgba(255,255,255,0.1)",
          }}
        >
          <nav className="flex-1 overflow-y-auto pt-3">
            {Object.entries(sections).map(([section, secItems], idx) => (
              <div key={section}>
                {sidebarOpen ? (
                  <p
                    className={`mb-1 px-5 py-1.5 text-[10px] font-bold uppercase tracking-widest ${idx > 0 ? "mt-3 border-t" : ""}`}
                    style={{
                      color: "rgba(230,224,240,0.4)",
                      borderColor: idx > 0 ? AMBER : undefined,
                    }}
                  >
                    {section}
                  </p>
                ) : idx > 0 ? (
                  <div
                    className="my-1 border-t"
                    style={{ borderColor: AMBER }}
                  />
                ) : null}
                <div className="space-y-0.5">
                  {secItems.map((item) => (
                    <NavLinkItem
                      key={item.to}
                      item={item}
                      active={isActive(item.to)}
                      collapsed={!sidebarOpen}
                      onNavigate={() => {
                        if (
                          typeof window !== "undefined" &&
                          window.innerWidth < 768
                        )
                          setSidebarOpen(false);
                      }}
                    />
                  ))}
                </div>
              </div>
            ))}
          </nav>

          <div style={{ borderTop: `1px solid ${AMBER}` }}>
            <button
              onClick={doLogout}
              className={`flex w-full items-center gap-3 py-2.5 text-xs font-medium transition-colors ${sidebarOpen ? "px-5" : "justify-center px-2"}`}
              style={{ color: SIDE_TEXT }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = HOVER;
                e.currentTarget.style.color = "#fff";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = "transparent";
                e.currentTarget.style.color = SIDE_TEXT;
              }}
              title={!sidebarOpen ? "Sair" : undefined}
            >
              <LogOut className="size-4 flex-shrink-0" />
              {sidebarOpen && <span>Sair</span>}
            </button>
          </div>
        </aside>

        {/* ── Conteúdo ── */}
        <div className="flex flex-1 flex-col overflow-hidden">
          {/* Breadcrumb */}
          <div className="flex flex-shrink-0 items-center gap-1 border-b border-gray-200 bg-white px-5 py-2.5 text-sm text-gray-500">
            <Link
              to={homeTo}
              className="flex items-center gap-1 transition-colors hover:text-[#1e293b]"
            >
              <Home className="size-3.5" />
              <span>Meu Ponto</span>
            </Link>
            {breadcrumb.map((c, i) => (
              <span key={c.href} className="flex items-center gap-1">
                <ChevronRight className="size-3" />
                {i === breadcrumb.length - 1 ? (
                  <span className="font-semibold text-gray-900">{c.label}</span>
                ) : (
                  <Link
                    to={c.href}
                    className="transition-colors hover:text-[#1e293b]"
                  >
                    {c.label}
                  </Link>
                )}
              </span>
            ))}
          </div>

          <main className="flex-1 overflow-auto p-4 md:p-6">{children}</main>
        </div>
      </div>
    </div>
  );
}
