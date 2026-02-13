import { Hono, type Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";

import { cleanExpiredStates, createState, validateAndConsumeState } from "../connections/oauth-state";
import { cleanupExpiredSessions, createSession, deleteSession, touchSession, validateSession } from "../db/sessions";
import { getUserById, upsertOAuthUser, type AuthProvider, type UserRecord } from "../db/users";
import { hasAppCredential, retrieveAppCredential } from "../vault/app-credential-store";
import { logger } from "../utils/logger";
import { getBaseUrl } from "../connections/base-url";

const SESSION_COOKIE_NAME = "agenr_session";
const OAUTH_LOGIN_STATE_USER_ID = "__oauth_login__";
const DEFAULT_CONSOLE_ORIGIN = "http://localhost:5173";

interface OAuthClientCredentials {
  clientId: string;
  clientSecret: string;
}

interface OAuthTokenResponse {
  accessToken: string;
  idToken?: string;
}

interface GoogleProfile {
  sub: string;
  email: string;
  name: string | null;
  picture: string | null;
}

interface GitHubProfile {
  id: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
}

function isAdminEmail(email: string): boolean {
  const admins = process.env.AGENR_ADMIN_EMAILS?.split(",").map((entry) => entry.trim().toLowerCase()) ?? [];
  return admins.includes(email.toLowerCase());
}

function normalizeConsoleOrigin(): string {
  const raw = process.env.CONSOLE_ORIGIN?.trim();
  return raw && raw.length > 0 ? raw.replace(/\/$/, "") : DEFAULT_CONSOLE_ORIGIN;
}

function oauthCallbackUrl(provider: AuthProvider): string {
  return `${getBaseUrl()}/auth/${provider}/callback`;
}

function isProductionEnv(): boolean {
  const env = process.env.NODE_ENV ?? "";
  return env !== "" && env !== "development" && env !== "test";
}

function sessionCookieOptions(expiresAt: string) {
  const production = isProductionEnv();
  const sameSite = production ? ("None" as const) : ("Lax" as const);
  return {
    httpOnly: true,
    secure: production,
    sameSite,
    path: "/",
    expires: new Date(expiresAt),
  };
}

function clearSessionCookie(c: Context): void {
  const production = isProductionEnv();
  const sameSite = production ? ("None" as const) : ("Lax" as const);
  deleteCookie(c, SESSION_COOKIE_NAME, {
    httpOnly: true,
    secure: production,
    sameSite,
    path: "/",
  });
}



function redirectToConsole(c: Context, path = "/"): Response {
  return c.redirect(`${normalizeConsoleOrigin()}${path}`, 302);
}

function toBase64Url(input: Buffer | Uint8Array): string {
  return Buffer.from(input)
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function randomCodeVerifier(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return toBase64Url(bytes);
}

async function codeChallengeS256(codeVerifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(codeVerifier));
  return toBase64Url(new Uint8Array(digest));
}

function parseTokenResponse(payload: unknown): OAuthTokenResponse {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("OAuth token response was invalid");
  }

  const record = payload as Record<string, unknown>;
  const accessToken = typeof record["access_token"] === "string" ? record["access_token"] : null;
  if (!accessToken) {
    throw new Error("OAuth token response did not include access_token");
  }

  const idToken = typeof record["id_token"] === "string" ? record["id_token"] : undefined;
  return { accessToken, idToken };
}

function parseJwtPayload(token: string): Record<string, unknown> {
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new Error("id_token is malformed");
  }

  const payloadPart = parts[1];
  const padded = payloadPart.padEnd(payloadPart.length + ((4 - (payloadPart.length % 4)) % 4), "=");
  const normalized = padded.replaceAll("-", "+").replaceAll("_", "/");
  const decoded = Buffer.from(normalized, "base64").toString("utf-8");
  const payload = JSON.parse(decoded) as unknown;

  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("id_token payload is invalid");
  }

  return payload as Record<string, unknown>;
}

function validateIdTokenClaims(payload: Record<string, unknown>, expectedClientId: string): void {
  const iss = typeof payload["iss"] === "string" ? payload["iss"] : "";
  if (iss !== "https://accounts.google.com" && iss !== "accounts.google.com") {
    throw new Error("id_token issuer is not Google");
  }

  const aud = typeof payload["aud"] === "string" ? payload["aud"] : "";
  if (aud !== expectedClientId) {
    throw new Error("id_token audience does not match client ID");
  }

  const exp = typeof payload["exp"] === "number" ? payload["exp"] : 0;
  const nowSeconds = Math.floor(Date.now() / 1000);
  const clockSkewSeconds = 300;
  if (exp < nowSeconds - clockSkewSeconds) {
    throw new Error("id_token is expired");
  }
}

function parseGoogleProfileFromIdToken(idToken: string, expectedClientId: string): GoogleProfile {
  const payload = parseJwtPayload(idToken);

  validateIdTokenClaims(payload, expectedClientId);

  const sub = typeof payload["sub"] === "string" ? payload["sub"].trim() : "";
  const email = typeof payload["email"] === "string" ? payload["email"].trim().toLowerCase() : "";

  if (!sub || !email) {
    throw new Error("Google profile is missing required sub/email fields");
  }

  return {
    sub,
    email,
    name: typeof payload["name"] === "string" ? payload["name"].trim() : null,
    picture: typeof payload["picture"] === "string" ? payload["picture"].trim() : null,
  };
}

function firstVerifiedEmail(items: unknown): string | null {
  if (!Array.isArray(items)) {
    return null;
  }

  const rows = items.filter((item): item is Record<string, unknown> => !!item && typeof item === "object");
  const primaryVerified = rows.find((row) => row["primary"] === true && row["verified"] === true);
  if (primaryVerified && typeof primaryVerified["email"] === "string") {
    return primaryVerified["email"].trim().toLowerCase();
  }

  const verified = rows.find((row) => row["verified"] === true);
  if (verified && typeof verified["email"] === "string") {
    return verified["email"].trim().toLowerCase();
  }

  return null;
}

async function fetchGithubProfile(accessToken: string): Promise<GitHubProfile> {
  const commonHeaders = {
    authorization: `Bearer ${accessToken}`,
    accept: "application/vnd.github+json",
    "user-agent": "agenr",
  };

  const userResponse = await fetch("https://api.github.com/user", {
    method: "GET",
    headers: commonHeaders,
  });

  if (!userResponse.ok) {
    const text = await userResponse.text();
    throw new Error(`GitHub profile request failed (${userResponse.status}): ${text}`);
  }

  const userPayload = (await userResponse.json()) as Record<string, unknown>;
  const idValue = userPayload["id"];
  const providerId =
    typeof idValue === "number" || typeof idValue === "bigint" || typeof idValue === "string"
      ? String(idValue)
      : "";
  if (!providerId) {
    throw new Error("GitHub profile is missing id");
  }

  let email = typeof userPayload["email"] === "string" ? userPayload["email"].trim().toLowerCase() : "";

  if (!email) {
    const emailsResponse = await fetch("https://api.github.com/user/emails", {
      method: "GET",
      headers: commonHeaders,
    });

    if (!emailsResponse.ok) {
      const text = await emailsResponse.text();
      throw new Error(`GitHub email request failed (${emailsResponse.status}): ${text}`);
    }

    email = firstVerifiedEmail(await emailsResponse.json()) ?? "";
  }

  if (!email) {
    throw new Error("GitHub profile is missing an accessible email address");
  }

  return {
    id: providerId,
    email,
    name: typeof userPayload["name"] === "string" ? userPayload["name"].trim() : null,
    avatarUrl: typeof userPayload["avatar_url"] === "string" ? userPayload["avatar_url"].trim() : null,
  };
}

async function loadOAuthClientCredentials(
  service: "google_auth" | "github_auth",
  envClientId: string,
  envClientSecret: string,
): Promise<OAuthClientCredentials> {
  if (await hasAppCredential(service)) {
    return retrieveAppCredential(service);
  }

  const clientId = process.env[envClientId]?.trim();
  const clientSecret = process.env[envClientSecret]?.trim();
  if (!clientId || !clientSecret) {
    throw new Error(`OAuth credentials missing for ${service}`);
  }

  return { clientId, clientSecret };
}

async function exchangeGoogleCode(
  code: string,
  codeVerifier: string,
  redirectUri: string,
): Promise<GoogleProfile> {
  const credentials = await loadOAuthClientCredentials(
    "google_auth",
    "GOOGLE_CLIENT_ID",
    "GOOGLE_CLIENT_SECRET",
  );

  const body = new URLSearchParams({
    client_id: credentials.clientId,
    client_secret: credentials.clientSecret,
    code,
    code_verifier: codeVerifier,
    grant_type: "authorization_code",
    redirect_uri: redirectUri,
  }).toString();

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
    },
    body,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Google token exchange failed (${response.status}): ${text}`);
  }

  const tokenResponse = parseTokenResponse(await response.json());
  if (!tokenResponse.idToken) {
    throw new Error("Google token response missing id_token");
  }

  return parseGoogleProfileFromIdToken(tokenResponse.idToken, credentials.clientId);
}

async function exchangeGithubCode(code: string, redirectUri: string): Promise<GitHubProfile> {
  const credentials = await loadOAuthClientCredentials(
    "github_auth",
    "GITHUB_CLIENT_ID",
    "GITHUB_CLIENT_SECRET",
  );

  const response = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      client_id: credentials.clientId,
      client_secret: credentials.clientSecret,
      code,
      redirect_uri: redirectUri,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`GitHub token exchange failed (${response.status}): ${text}`);
  }

  const tokenResponse = parseTokenResponse(await response.json());
  return fetchGithubProfile(tokenResponse.accessToken);
}

function isAllowedUser(email: string): boolean {
  const allowlist = process.env.AGENR_ALLOWED_EMAILS?.split(',').map(e => e.trim().toLowerCase()) ?? [];
  if (allowlist.length === 0) return true; // no allowlist = open registration
  return allowlist.includes(email.toLowerCase());
}

async function establishSession(c: Context, user: UserRecord): Promise<Response> {
  if (!isAllowedUser(user.email)) {
    logger.warn("auth_user_not_allowed", { email: user.email, userId: user.id });
    return authFailureRedirect(c, "access_denied");
  }

  await cleanupExpiredSessions();
  const session = await createSession(user.id);
  setCookie(c, SESSION_COOKIE_NAME, session.token, sessionCookieOptions(session.expiresAt));

  return redirectToConsole(c, `/?session_token=${encodeURIComponent(session.token)}`);
}

function authFailureRedirect(c: Context, reason: string): Response {
  const encoded = encodeURIComponent(reason);
  return redirectToConsole(c, `/login?error=${encoded}`);
}

async function currentUserFromSession(c: Context): Promise<UserRecord | null> {
  const sessionId = getCookie(c, SESSION_COOKIE_NAME) ?? "";
  if (!sessionId) {
    return null;
  }

  const session = await validateSession(sessionId);
  if (!session) {
    clearSessionCookie(c);
    return null;
  }

  const user = await getUserById(session.userId);
  if (!user) {
    await deleteSession(sessionId);
    clearSessionCookie(c);
    return null;
  }

  void touchSession(sessionId).catch((error) => {
    logger.warn("auth_touch_session_failed", { sessionId: session.id, error });
  });

  return user;
}

function extractBearerToken(c: Context): string | null {
  const header = c.req.header("authorization") ?? "";
  if (header.startsWith("Bearer ")) {
    const token = header.slice(7).trim();
    return token.length > 0 ? token : null;
  }
  return null;
}

async function currentUserFromBearer(c: Context): Promise<UserRecord | null> {
  const sessionId = extractBearerToken(c);
  if (!sessionId) {
    return null;
  }

  const session = await validateSession(sessionId);
  if (!session) {
    return null;
  }

  const user = await getUserById(session.userId);
  if (!user) {
    await deleteSession(sessionId);
    return null;
  }

  void touchSession(sessionId).catch((error) => {
    logger.warn("auth_touch_session_failed", { sessionId: session.id, error });
  });

  return user;
}

export const authApp = new Hono();

authApp.get("/google", async (c) => {
  try {
    const credentials = await loadOAuthClientCredentials(
      "google_auth",
      "GOOGLE_CLIENT_ID",
      "GOOGLE_CLIENT_SECRET",
    );

    await cleanExpiredStates();
    const codeVerifier = randomCodeVerifier();
    const codeChallenge = await codeChallengeS256(codeVerifier);
    const state = await createState(OAUTH_LOGIN_STATE_USER_ID, "google_auth", codeVerifier);
    const redirectUri = oauthCallbackUrl("google");

    const params = new URLSearchParams({
      client_id: credentials.clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: "openid email profile",
      state,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
      access_type: "offline",
      prompt: "consent",
    });

    return c.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`, 302);
  } catch (error) {
    logger.error("auth_google_start_failed", { error });
    return authFailureRedirect(c, "google_start_failed");
  }
});

authApp.get("/google/callback", async (c) => {
  const code = c.req.query("code")?.trim();
  const state = c.req.query("state")?.trim();
  const oauthError = c.req.query("error")?.trim();

  if (oauthError) {
    return authFailureRedirect(c, oauthError);
  }

  if (!code || !state) {
    return authFailureRedirect(c, "missing_oauth_parameters");
  }

  try {
    await cleanExpiredStates();
    const stateRecord = await validateAndConsumeState(state);
    if (!stateRecord || stateRecord.service !== "google_auth" || !stateRecord.codeVerifier) {
      return authFailureRedirect(c, "invalid_state");
    }

    const profile = await exchangeGoogleCode(code, stateRecord.codeVerifier, oauthCallbackUrl("google"));
    const user = await upsertOAuthUser({
      provider: "google",
      providerId: profile.sub,
      email: profile.email,
      name: profile.name,
      avatarUrl: profile.picture,
    });

    return establishSession(c, user);
  } catch (error) {
    logger.error("auth_google_callback_failed", { error });
    return authFailureRedirect(c, "google_callback_failed");
  }
});

authApp.get("/github", async (c) => {
  try {
    const credentials = await loadOAuthClientCredentials(
      "github_auth",
      "GITHUB_CLIENT_ID",
      "GITHUB_CLIENT_SECRET",
    );

    await cleanExpiredStates();
    const state = await createState(OAUTH_LOGIN_STATE_USER_ID, "github_auth");
    const redirectUri = oauthCallbackUrl("github");

    const params = new URLSearchParams({
      client_id: credentials.clientId,
      redirect_uri: redirectUri,
      scope: "read:user user:email",
      state,
    });

    return c.redirect(`https://github.com/login/oauth/authorize?${params.toString()}`, 302);
  } catch (error) {
    logger.error("auth_github_start_failed", { error });
    return authFailureRedirect(c, "github_start_failed");
  }
});

authApp.get("/github/callback", async (c) => {
  const code = c.req.query("code")?.trim();
  const state = c.req.query("state")?.trim();
  const oauthError = c.req.query("error")?.trim();

  if (oauthError) {
    return authFailureRedirect(c, oauthError);
  }

  if (!code || !state) {
    return authFailureRedirect(c, "missing_oauth_parameters");
  }

  try {
    await cleanExpiredStates();
    const stateRecord = await validateAndConsumeState(state);
    if (!stateRecord || stateRecord.service !== "github_auth") {
      return authFailureRedirect(c, "invalid_state");
    }

    const profile = await exchangeGithubCode(code, oauthCallbackUrl("github"));
    const user = await upsertOAuthUser({
      provider: "github",
      providerId: profile.id,
      email: profile.email,
      name: profile.name,
      avatarUrl: profile.avatarUrl,
    });

    return establishSession(c, user);
  } catch (error) {
    logger.error("auth_github_callback_failed", { error });
    return authFailureRedirect(c, "github_callback_failed");
  }
});

authApp.get("/me", async (c) => {
  try {
    const user = await currentUserFromSession(c) ?? await currentUserFromBearer(c);
    if (!user) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    return c.json({
      id: user.id,
      email: user.email,
      name: user.name,
      avatarUrl: user.avatarUrl,
      provider: user.provider,
      isAdmin: isAdminEmail(user.email),
    });
  } catch (error) {
    logger.error("auth_me_failed", { error });
    return c.json({ error: "Internal server error" }, 500);
  }
});

authApp.post("/logout", async (c) => {
  const sessionId = getCookie(c, SESSION_COOKIE_NAME) || extractBearerToken(c) || "";
  if (sessionId) {
    await deleteSession(sessionId);
  }

  clearSessionCookie(c);
  return c.json({ status: "logged_out" });
});
