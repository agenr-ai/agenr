export type AuthStrategy =
  | "bearer"
  | "api-key-header"
  | "basic"
  | "cookie"
  | "custom"
  | "client-credentials"
  | "none";

export type OAuthTokenContentType = "form" | "json";

export interface OAuthManifestConfig {
  oauthService?: string;
  authorizationUrl: string;
  tokenUrl: string;
  tokenContentType?: OAuthTokenContentType;
  extraAuthParams?: Record<string, string>;
}

export interface AdapterManifest {
  name?: string;
  version?: string;
  description?: string;
  platform?: string;
  auth: {
    type: "oauth2" | "api_key" | "cookie" | "basic" | "client_credentials" | "none";
    strategy: AuthStrategy;
    scopes?: string[];
    headerName?: string;
    cookieName?: string;
    oauth?: OAuthManifestConfig;
  };
  authenticatedDomains: string[];
  allowedDomains?: string[];
}

function normalizeDomainEntries(
  domains: string[] | undefined,
  fieldName: "authenticatedDomains" | "allowedDomains",
  required = false,
): string[] {
  if (domains === undefined) {
    if (required) {
      throw new Error(`Manifest '${fieldName}' is required.`);
    }
    return [];
  }

  if (!Array.isArray(domains)) {
    throw new Error(`Manifest '${fieldName}' must be an array of domain strings.`);
  }

  return domains
    .map((domain) => {
      if (typeof domain !== "string") {
        throw new Error(`Manifest '${fieldName}' must only include domain strings.`);
      }
      return domain.trim();
    })
    .filter((domain) => domain.length > 0);
}

function normalizeDomainForComparison(domain: string): string {
  return domain.toLowerCase().replace(/\.$/, "");
}

export function defineManifest(manifest: AdapterManifest): AdapterManifest {
  const authenticatedDomains = normalizeDomainEntries(
    manifest.authenticatedDomains,
    "authenticatedDomains",
    true,
  );
  const allowedDomains = normalizeDomainEntries(manifest.allowedDomains, "allowedDomains");

  if (manifest.auth.strategy !== "none" && authenticatedDomains.length === 0) {
    throw new Error(
      "Adapters with auth strategy other than 'none' must declare at least one authenticatedDomain.",
    );
  }

  const authenticatedDomainSet = new Set(
    authenticatedDomains.map((domain) => normalizeDomainForComparison(domain)),
  );

  for (const domain of allowedDomains) {
    if (authenticatedDomainSet.has(normalizeDomainForComparison(domain))) {
      throw new Error(
        `Manifest domain '${domain}' cannot appear in both authenticatedDomains and allowedDomains.`,
      );
    }
  }

  return {
    ...manifest,
    authenticatedDomains,
    allowedDomains,
  };
}
