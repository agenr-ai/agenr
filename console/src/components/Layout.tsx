import { useEffect, useState } from "react";
import { NavLink, Outlet, useNavigate } from "react-router";
import { getSessionToken } from "../api/client";
import { useAuth } from "../context/AuthContext";
import { type ActiveRole, useRole } from "../context/RoleContext";
import { getDemoPersona } from "../demo/sessions";

type NavItem = {
  to: string;
  label: string;
};

type Theme = "dark" | "light";

const THEME_STORAGE_KEY = "agenr-theme";

const LEGACY_NON_ADMIN_NAV: NavItem[] = [
  { to: "/", label: "Dashboard" },
  { to: "/businesses", label: "My Businesses" },
  { to: "/adapters", label: "Adapters" },
  { to: "/connections", label: "Connections" },
  { to: "/playground", label: "Playground" },
];

const ROLE_NAV: Record<ActiveRole, NavItem[]> = {
  admin: [
    { to: "/", label: "Dashboard" },
    { to: "/businesses", label: "Registered Businesses" },
    { to: "/adapters", label: "Adapters" },
    { to: "/connections", label: "Connections" },
    { to: "/app-credentials", label: "App Credentials" },
    { to: "/playground", label: "Playground" },
  ],
  business: [
    { to: "/", label: "Dashboard" },
    { to: "/businesses", label: "My Businesses" },
    { to: "/connections", label: "Connections" },
  ],
  developer: [
    { to: "/", label: "Dashboard" },
    { to: "/adapters", label: "Adapters" },
    { to: "/playground", label: "Playground" },
  ],
  consumer: [
    { to: "/", label: "Dashboard" },
    { to: "/adapters", label: "Adapters" },
    { to: "/playground", label: "Playground" },
  ],
};

const ROLE_TITLE: Record<ActiveRole, string> = {
  admin: "Admin Console",
  business: "Business Console",
  developer: "Developer Console",
  consumer: "Console",
};

const ROLE_SUBTITLE: Record<ActiveRole, string> = {
  admin: "Manage the AGENR platform.",
  business: "Manage your business on AGENR.",
  developer: "Build and manage your AGENR integrations.",
  consumer: "Discover businesses on AGENR.",
};

const ROLE_LABEL: Record<ActiveRole, string> = {
  admin: "Admin",
  business: "Business Owner",
  developer: "Developer",
  consumer: "Consumer",
};

function initials(userName: string | null, email: string): string {
  const source = userName?.trim() || email;
  return source[0]?.toUpperCase() ?? "U";
}

function resolveInitialTheme(): Theme {
  if (typeof window === "undefined") {
    return "light";
  }

  try {
    const storedTheme = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (storedTheme === "dark" || storedTheme === "light") {
      return storedTheme;
    }
  } catch {
    return "light";
  }

  return "light";
}

function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  root.classList.remove("dark", "light");
  root.classList.add(theme);
}

export default function Layout() {
  const navigate = useNavigate();
  const { user, logout } = useAuth();
  const { activeRole, setActiveRole, isImpersonating } = useRole();
  const [theme, setTheme] = useState<Theme>(() => resolveInitialTheme());
  const persona = getDemoPersona(getSessionToken());
  const isAdmin = user?.isAdmin === true;
  const isDemoSession = persona !== null;
  const visibleNavItems = isAdmin
    ? ROLE_NAV[activeRole]
    : persona
      ? LEGACY_NON_ADMIN_NAV.filter((item) => persona.visibleRoutes.includes(item.to))
      : LEGACY_NON_ADMIN_NAV;
  const PERSONA_ROLE_TITLE: Record<string, string> = {
    Developer: "Developer Console",
    Consumer: "Consumer Console",
    "Restaurant Owner": "Business Console",
  };
  const sidebarTitle = isAdmin
    ? ROLE_TITLE[activeRole]
    : persona
      ? PERSONA_ROLE_TITLE[persona.role] ?? "Console"
      : "Developer Console";
  const headerSubtitle = isAdmin
    ? ROLE_SUBTITLE[activeRole]
    : persona?.headerSubtitle ?? "Build and manage your AGENR integrations.";

  useEffect(() => {
    applyTheme(theme);
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, theme);
    } catch {
      // Ignore localStorage write failures and keep in-memory theme state.
    }
  }, [theme]);

  async function handleLogout() {
    await logout();
    navigate("/login", { replace: true });
  }

  function toggleTheme(): void {
    setTheme((currentTheme) => (currentTheme === "dark" ? "light" : "dark"));
  }

  return (
    <div className="flex h-screen overflow-hidden bg-app-bg text-app-text">
      <aside className="fixed inset-y-0 left-0 flex h-screen w-60 flex-col border-r border-app-border bg-app-sidebar p-6">
        <div>
          <div className="flex items-center justify-between gap-2.5">
            <div className="flex items-center gap-2.5">
              <img src="/logo-192.png" alt="AGENR" className="h-7 w-7" />
              <p className="text-xs font-medium uppercase tracking-[0.2em] text-blue-700/80 dark:text-blue-300/80">AGENR</p>
            </div>
            <button
              type="button"
              onClick={toggleTheme}
              className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-app-border-strong bg-app-surface-soft text-app-text-subtle transition hover:text-app-text"
              aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
              title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
            >
              {theme === "dark" ? (
                <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
                  <circle cx="12" cy="12" r="4" />
                  <path d="M12 2v2.5M12 19.5V22M4.93 4.93l1.77 1.77M17.3 17.3l1.77 1.77M2 12h2.5M19.5 12H22M4.93 19.07l1.77-1.77M17.3 6.7l1.77-1.77" />
                </svg>
              ) : (
                <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
                  <path d="M21 12.8A9 9 0 1 1 11.2 3c-.1.4-.2.9-.2 1.3a7.5 7.5 0 0 0 9.9 7.2Z" />
                </svg>
              )}
            </button>
          </div>
          <h1 className="mt-2 text-xl font-semibold text-app-text">{sidebarTitle}</h1>
        </div>

        {isAdmin ? (
          <div className="mt-6 space-y-2">
            <label htmlFor="role-switcher" className="text-[11px] font-semibold uppercase tracking-[0.1em] text-app-text-subtle">
              View As
            </label>
            <select
              id="role-switcher"
              value={activeRole}
              onChange={(event) => setActiveRole(event.target.value as ActiveRole)}
              className="w-full rounded-md border border-app-input-border bg-app-input-bg px-3 py-2 text-sm text-app-text outline-none transition focus:border-blue-400"
            >
              <option value="admin">Admin</option>
              <option value="business">Business Owner</option>
              <option value="developer">Developer</option>
              <option value="consumer">Consumer</option>
            </select>
            {isImpersonating ? (
              <span className="inline-flex rounded-full border border-amber-300 dark:border-amber-300/60 bg-amber-50 dark:bg-amber-500/15 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-amber-800 dark:text-amber-100">
                Viewing as {ROLE_LABEL[activeRole]}
              </span>
            ) : null}
          </div>
        ) : null}

        <nav className="mt-8 flex flex-1 flex-col gap-2 overflow-y-auto">
          {visibleNavItems.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) =>
                [
                  "rounded-lg px-3 py-2 text-sm font-medium transition-colors",
                  isActive
                    ? "bg-blue-50 dark:bg-blue-500/20 text-blue-700 dark:text-blue-200"
                    : "text-app-text-muted hover:bg-app-surface-soft hover:text-app-text",
                ].join(" ")
              }
              end={item.to === "/"}
            >
              {item.label}
            </NavLink>
          ))}
        </nav>

        {user ? (
          <div className="mt-auto border-t border-app-border pt-4">
            <div className="flex items-center gap-3">
              {user.avatarUrl ? (
                <img src={user.avatarUrl} alt="" className="h-8 w-8 rounded-full" />
              ) : (
                <div className="flex h-8 w-8 items-center justify-center rounded-full bg-app-muted-fill text-sm font-medium text-app-text">
                  {initials(user.name, user.email)}
                </div>
              )}
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-app-text">{user.name ?? user.email}</p>
                <p className="truncate text-xs text-app-text-subtle">{user.email}</p>
              </div>
              <button
                type="button"
                onClick={() => void handleLogout()}
                className="text-xs font-medium text-app-text-subtle transition hover:text-app-text"
              >
                Logout
              </button>
            </div>
          </div>
        ) : null}
      </aside>

      <div className="ml-60 flex h-screen flex-1 flex-col overflow-hidden">
        <header className="sticky top-0 z-10 flex h-16 items-center justify-between border-b border-app-border bg-app-bg px-8">
          <p className="text-sm text-app-text-subtle">{headerSubtitle}</p>
          {isDemoSession ? (
            <span className="rounded-full border border-sky-300 dark:border-sky-300/60 bg-sky-50 dark:bg-sky-500/15 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-sky-700 dark:text-sky-100">
              Demo Mode
            </span>
          ) : null}
        </header>
        <main className="flex-1 overflow-y-auto px-8 py-10">
          <div className="mx-auto w-full max-w-7xl">
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  );
}
