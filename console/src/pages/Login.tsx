import { useEffect } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { setSessionToken } from "../api/client";
import { useAuth } from "../context/AuthContext";
import { DEMO_PERSONAS } from "../demo/sessions";

const API_BASE_URL = (import.meta.env.VITE_API_URL || "https://api.agenr.ai").replace(/\/$/, "");
const DEMO_MODE_ENABLED = import.meta.env.VITE_DEMO_MODE === "true";

function GoogleIcon() {
  return (
    <svg className="h-4 w-4" viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="#EA4335"
        d="M12 10.2v3.9h5.5c-.2 1.3-1.5 3.9-5.5 3.9-3.3 0-6-2.8-6-6.2s2.7-6.2 6-6.2c1.9 0 3.2.8 3.9 1.5l2.7-2.6C16.8 2.8 14.6 2 12 2 6.8 2 2.5 6.5 2.5 12s4.3 10 9.5 10c5.5 0 9.1-3.9 9.1-9.3 0-.6-.1-1.1-.2-1.5z"
      />
      <path fill="#34A853" d="M2.5 12c0 1.8.7 3.4 1.9 4.7l3.1-2.4C7 13.7 6.8 12.9 6.8 12s.2-1.7.7-2.3L4.4 7.3A9.8 9.8 0 0 0 2.5 12z" />
      <path fill="#4A90E2" d="M12 22c2.6 0 4.8-.9 6.4-2.5l-3-2.3c-.8.6-2 1.1-3.4 1.1-2.5 0-4.7-1.7-5.5-4l-3.2 2.4C5.1 19.8 8.3 22 12 22z" />
      <path fill="#FBBC05" d="M6.5 14.3A6.4 6.4 0 0 1 5.9 12c0-.8.2-1.7.6-2.3L3.3 7.3A10 10 0 0 0 2 12c0 1.7.4 3.3 1.3 4.7z" />
    </svg>
  );
}

function GitHubIcon() {
  return (
    <svg className="h-4 w-4" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 .5a12 12 0 0 0-3.8 23.4c.6.1.8-.2.8-.6v-2.3c-3.3.8-4-1.6-4-1.6-.5-1.4-1.3-1.8-1.3-1.8-1.1-.8.1-.8.1-.8 1.2.1 1.9 1.3 1.9 1.3 1.1 1.9 2.8 1.3 3.5 1 .1-.8.4-1.3.7-1.6-2.7-.3-5.6-1.4-5.6-6.2 0-1.4.5-2.6 1.3-3.5-.1-.3-.6-1.6.1-3.4 0 0 1.1-.4 3.6 1.3 1-.3 2.1-.4 3.2-.4s2.2.1 3.2.4c2.5-1.7 3.6-1.3 3.6-1.3.7 1.8.2 3.1.1 3.4.8.9 1.3 2.1 1.3 3.5 0 4.8-2.9 5.9-5.7 6.2.5.4.8 1.1.8 2.2v3.2c0 .4.2.7.8.6A12 12 0 0 0 12 .5z" />
    </svg>
  );
}

function toAuthErrorMessage(reason: string | null): string | null {
  if (!reason) {
    return null;
  }

  if (reason.includes("missing_oauth_parameters") || reason.includes("invalid_state")) {
    return "Sign-in session expired. Try again.";
  }

  if (reason.includes("google") || reason.includes("github")) {
    return "Social sign-in failed. Try again.";
  }

  return "Unable to sign in. Try again.";
}

export default function Login() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { isAuthenticated, isLoading, refreshUser } = useAuth();

  useEffect(() => {
    if (!isLoading && isAuthenticated) {
      navigate("/", { replace: true });
    }
  }, [isAuthenticated, isLoading, navigate]);

  const errorMessage = toAuthErrorMessage(searchParams.get("error"));

  async function handleDemoLogin(sessionToken: string) {
    setSessionToken(sessionToken);
    try {
      await refreshUser();
    } catch {
      // The route guard will handle unauthenticated state if refresh fails.
    }
    navigate("/", { replace: true });
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-app-bg px-4 text-app-text">
      <div className="w-full max-w-md rounded-2xl border border-app-border bg-app-surface p-8 shadow-2xl shadow-black/40">
        <div className="flex items-center gap-3">
          <img src="/logo-192.png" alt="AGENR" className="h-10 w-10" />
          <h1 className="text-3xl font-semibold text-app-text">AGENR</h1>
        </div>
        <p className="mt-2 text-sm text-app-text-subtle">Sign in to the AGENR Developer Console.</p>

        <div className="mt-6 space-y-3">
          <a
            href={`${API_BASE_URL}/auth/google`}
            className="flex w-full items-center justify-center gap-3 rounded-lg border border-app-border bg-app-input-bg px-4 py-3 text-sm font-medium text-app-text transition hover:border-app-border-strong hover:bg-app-surface-alt"
          >
            <GoogleIcon />
            Sign in with Google
          </a>
          <a
            href={`${API_BASE_URL}/auth/github`}
            className="flex w-full items-center justify-center gap-3 rounded-lg border border-app-border bg-app-input-bg px-4 py-3 text-sm font-medium text-app-text transition hover:border-app-border-strong hover:bg-app-surface-alt"
          >
            <GitHubIcon />
            Sign in with GitHub
          </a>
        </div>

        {DEMO_MODE_ENABLED ? (
          <div className="mt-6">
            <div className="flex items-center gap-3">
              <div className="h-px flex-1 bg-app-muted-fill" />
              <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-app-text-subtle">or sign in as a demo user</p>
              <div className="h-px flex-1 bg-app-muted-fill" />
            </div>
            <div className="mt-3 space-y-2.5">
              {DEMO_PERSONAS.map((persona) => (
                <button
                  key={persona.sessionToken}
                  type="button"
                  onClick={() => void handleDemoLogin(persona.sessionToken)}
                  className="w-full rounded-lg border border-dashed border-sky-300 dark:border-sky-400/50 bg-sky-50 dark:bg-sky-500/10 px-4 py-3 text-left transition hover:border-sky-400 dark:hover:border-sky-300/70 hover:bg-sky-100 dark:hover:bg-sky-500/15"
                >
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-sm font-medium text-sky-700 dark:text-sky-100">{persona.name}</p>
                    <span className="rounded-full border border-sky-300 dark:border-sky-300/60 bg-sky-50 dark:bg-sky-200/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-sky-700 dark:text-sky-100">
                      (Demo)
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-sky-700/90 dark:text-sky-200/90">{persona.role}</p>
                  <p className="mt-1 text-[11px] text-sky-600/80 dark:text-sky-300/80">Session: {persona.sessionToken}</p>
                </button>
              ))}
            </div>
          </div>
        ) : null}

        {errorMessage ? <p className="mt-4 text-sm text-red-700 dark:text-red-300">{errorMessage}</p> : null}
      </div>
    </div>
  );
}
