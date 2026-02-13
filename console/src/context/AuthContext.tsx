import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { apiRawFetch, getSessionToken, setSessionToken, clearSessionToken } from "../api/client";
import { isDemoSessionToken } from "../demo/sessions";

export interface AuthUser {
  id: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
  provider: string;
  isAdmin: boolean;
}

interface AuthContextValue {
  user: AuthUser | null;
  isLoading: boolean;
  isAuthenticated: boolean;
  refreshUser: () => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

interface AuthProviderProps {
  children: ReactNode;
}

function parseAuthUser(payload: unknown): AuthUser | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }

  const value = payload as Record<string, unknown>;
  const id = typeof value["id"] === "string" ? value["id"] : "";
  const email = typeof value["email"] === "string" ? value["email"] : "";
  const provider = typeof value["provider"] === "string" ? value["provider"] : "";
  if (!id || !email || !provider) {
    return null;
  }

  return {
    id,
    email,
    name: typeof value["name"] === "string" ? value["name"] : null,
    avatarUrl: typeof value["avatarUrl"] === "string" ? value["avatarUrl"] : null,
    provider,
    isAdmin: value["isAdmin"] === true,
  };
}

export function AuthProvider({ children }: AuthProviderProps) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const refreshUser = useCallback(async () => {
    const response = await apiRawFetch<unknown>("/auth/me", { method: "GET" });

    if (response.ok) {
      const parsed = parseAuthUser(response.data);
      setUser(parsed);
      return;
    }

    if (response.status === 401) {
      setUser(null);
      return;
    }

    throw new Error(response.statusText || "Unable to validate session");
  }, []);

  // Capture session token from URL query params (set by OAuth callback redirect)
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const token = params.get("session_token");
    if (token) {
      setSessionToken(token);
      // Clean the URL without triggering a navigation
      const url = new URL(window.location.href);
      url.searchParams.delete("session_token");
      window.history.replaceState({}, "", url.pathname + url.search + url.hash);
    }
  }, []);

  useEffect(() => {
    let isDisposed = false;

    void (async () => {
      try {
        const response = await apiRawFetch<unknown>("/auth/me", { method: "GET" });
        if (isDisposed) {
          return;
        }

        if (response.ok) {
          setUser(parseAuthUser(response.data));
          return;
        }

        if (response.status === 401) {
          setUser(null);
          return;
        }

        setUser(null);
      } catch {
        if (!isDisposed) {
          setUser(null);
        }
      } finally {
        if (!isDisposed) {
          setIsLoading(false);
        }
      }
    })();

    return () => {
      isDisposed = true;
    };
  }, []);

  const logout = useCallback(async () => {
    try {
      if (!isDemoSessionToken(getSessionToken())) { await apiRawFetch("/auth/logout", { method: "POST" }); }
    } finally {
      clearSessionToken();
      setUser(null);
    }
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      isLoading,
      isAuthenticated: Boolean(user),
      refreshUser,
      logout,
    }),
    [isLoading, logout, refreshUser, user],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth must be used within an AuthProvider");
  }

  return context;
}
