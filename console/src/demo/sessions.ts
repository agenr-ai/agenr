export type DemoPersona = {
  name: string;
  role: string;
  sessionToken: string;
  visibleRoutes: string[];
  headerSubtitle?: string;
};

export const DEMO_PERSONAS: DemoPersona[] = [
  {
    name: "Joe Napoli",
    role: "Restaurant Owner",
    sessionToken: "joe-session-001",
    visibleRoutes: ["/", "/businesses", "/connections"],
    headerSubtitle: "Manage your business on AGENR.",
  },
  {
    name: "Sarah Chen",
    role: "Developer",
    sessionToken: "sarah-session-001",
    visibleRoutes: ["/", "/adapters", "/playground"],
    headerSubtitle: "Build and manage your AGENR integrations.",
  },
  {
    name: "Maria Lopez",
    role: "Consumer",
    sessionToken: "maria-session-001",
    visibleRoutes: ["/", "/adapters", "/playground"],
    headerSubtitle: "Discover businesses on AGENR.",
  },
];

const DEMO_PERSONA_BY_SESSION_TOKEN = new Map(
  DEMO_PERSONAS.map((persona) => [persona.sessionToken, persona] as const),
);
const DEMO_SESSION_TOKEN_SET = new Set(DEMO_PERSONAS.map((persona) => persona.sessionToken));

export function isDemoSessionToken(token: string | null | undefined): boolean {
  if (!token) {
    return false;
  }

  return DEMO_SESSION_TOKEN_SET.has(token);
}

export function getDemoPersona(token: string | null | undefined): DemoPersona | null {
  if (!token) {
    return null;
  }

  return DEMO_PERSONA_BY_SESSION_TOKEN.get(token) ?? null;
}

export function getVisibleRoutes(token: string | null | undefined): string[] | null {
  const persona = getDemoPersona(token);
  return persona ? persona.visibleRoutes : null;
}
