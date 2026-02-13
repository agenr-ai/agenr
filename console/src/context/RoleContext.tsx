import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { getSessionToken } from "../api/client";
import { getDemoPersona, type DemoPersona } from "../demo/sessions";
import { useAuth } from "./AuthContext";

export type ActiveRole = "admin" | "business" | "developer" | "consumer";

interface RoleContextValue {
  activeRole: ActiveRole;
  setActiveRole: (role: ActiveRole) => void;
  isImpersonating: boolean;
}

const RoleContext = createContext<RoleContextValue | null>(null);

interface RoleProviderProps {
  children: ReactNode;
}

function demoPersonaToRole(persona: DemoPersona | null): ActiveRole | null {
  if (!persona) {
    return null;
  }

  const loweredRole = persona.role.toLowerCase();
  if (
    loweredRole.includes("business") ||
    loweredRole.includes("restaurant") ||
    loweredRole.includes("owner")
  ) {
    return "business";
  }

  if (loweredRole.includes("consumer")) {
    return "consumer";
  }
  if (loweredRole.includes("developer")) {
    return "developer";
  }

  return "developer";
}

export function RoleProvider({ children }: RoleProviderProps) {
  const { user } = useAuth();
  const [adminRole, setAdminRole] = useState<ActiveRole>(() => {
    try {
      const stored = sessionStorage.getItem("agenr_admin_role");
      if (stored === "admin" || stored === "business" || stored === "developer" || stored === "consumer") {
        return stored;
      }
    } catch { /* sessionStorage unavailable */ }
    return "admin";
  });
  const isAdmin = user?.isAdmin === true;
  const persona = getDemoPersona(getSessionToken());
  const demoRole = demoPersonaToRole(persona);

  const previousUserIdRef = useMemo(() => ({ current: user?.id }), []);
  useEffect(() => {
    if (previousUserIdRef.current !== user?.id) {
      previousUserIdRef.current = user?.id;
      if (isAdmin) {
        setAdminRole("admin");
        try { sessionStorage.removeItem("agenr_admin_role"); } catch { /* ignore */ }
      }
    }
  }, [isAdmin, user?.id, previousUserIdRef]);

  const setActiveRole = useCallback(
    (role: ActiveRole) => {
      if (!isAdmin) {
        return;
      }
      setAdminRole(role);
      try { sessionStorage.setItem("agenr_admin_role", role); } catch { /* ignore */ }
    },
    [isAdmin],
  );

  const activeRole = isAdmin ? adminRole : demoRole ?? "developer";
  const value = useMemo<RoleContextValue>(
    () => ({
      activeRole,
      setActiveRole,
      isImpersonating: isAdmin && activeRole !== "admin",
    }),
    [activeRole, isAdmin, setActiveRole],
  );

  return <RoleContext.Provider value={value}>{children}</RoleContext.Provider>;
}

export function useRole(): RoleContextValue {
  const context = useContext(RoleContext);
  if (!context) {
    throw new Error("useRole must be used within a RoleProvider");
  }

  return context;
}
