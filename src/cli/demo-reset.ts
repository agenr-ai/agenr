import { createClient, type Client, type InStatement } from "@libsql/client";
import { hashToken } from "../db/sessions";

export interface DemoUser {
  id: string;
  email: string;
  name: string;
  provider: string;
  providerId: string;
  sessionToken: string;
}

export const DEMO_USERS: DemoUser[] = [
  {
    id: "joe-user-001",
    email: "joe@joespizza.demo",
    name: "Joe Napoli",
    provider: "google",
    providerId: "joe-google-001",
    sessionToken: "joe-session-001",
  },
  {
    id: "sarah-user-001",
    email: "sarah@devshop.demo",
    name: "Sarah Chen",
    provider: "github",
    providerId: "sarah-github-001",
    sessionToken: "sarah-session-001",
  },
  {
    id: "maria-user-001",
    email: "maria@consumer.demo",
    name: "Maria Lopez",
    provider: "google",
    providerId: "maria-google-001",
    sessionToken: "maria-session-001",
  },
  {
    id: "eja-user-001",
    email: "eja@agenr.demo",
    name: "EJA",
    provider: "github",
    providerId: "eja-github-001",
    sessionToken: "eja-session-001",
  },
];

export interface DemoUserDeleteSummary {
  userId: string;
  businesses: number;
  credentials: number;
  userKeys: number;
  sessions: number;
}

export interface DemoResetSummary {
  deleted: DemoUserDeleteSummary[];
  usersUpserted: number;
  sessionsUpserted: number;
}

interface RunDemoResetOptions {
  client?: Client;
  log?: (message: string) => void;
}

function toAuthToken(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function noun(count: number, singular: string, plural: string): string {
  return count === 1 ? singular : plural;
}

export function demoUserIds(): string[] {
  return DEMO_USERS.map((user) => user.id);
}

function buildDeleteStatements(userId: string): InStatement[] {
  return [
    { sql: "DELETE FROM businesses WHERE owner_id = ?", args: [userId] },
    { sql: "DELETE FROM credentials WHERE user_id = ?", args: [userId] },
    { sql: "DELETE FROM user_keys WHERE user_id = ?", args: [userId] },
    { sql: "DELETE FROM sessions WHERE user_id = ?", args: [userId] },
  ];
}

function buildUpsertUserStatement(user: DemoUser): InStatement {
  return {
    sql: `INSERT INTO users (
      id,
      email,
      name,
      avatar_url,
      provider,
      provider_id,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, NULL, ?, ?, datetime('now'), datetime('now'))
    ON CONFLICT(id) DO UPDATE SET
      email = excluded.email,
      name = excluded.name,
      avatar_url = NULL,
      provider = excluded.provider,
      provider_id = excluded.provider_id,
      updated_at = datetime('now')`,
    args: [user.id, user.email, user.name, user.provider, user.providerId],
  };
}

function buildUpsertSessionStatement(userId: string, sessionToken: string): InStatement {
  const hashedToken = hashToken(sessionToken);
  return {
    sql: `INSERT INTO sessions (
      id,
      user_id,
      expires_at,
      created_at,
      last_active_at
    ) VALUES (?, ?, '2027-12-31T00:00:00.000Z', datetime('now'), datetime('now'))
    ON CONFLICT(id) DO UPDATE SET
      user_id = excluded.user_id,
      expires_at = excluded.expires_at,
      last_active_at = datetime('now')`,
    args: [hashedToken, userId],
  };
}

function totalDeleted(summary: DemoResetSummary): number {
  return summary.deleted.reduce(
    (acc, item) => acc + item.businesses + item.credentials + item.userKeys + item.sessions,
    0,
  );
}

export function runDemoReset(dbUrl: string, dbAuthToken: string): Promise<DemoResetSummary>;
export function runDemoReset(
  dbUrl: string,
  dbAuthToken: string,
  options: RunDemoResetOptions,
): Promise<DemoResetSummary>;
export async function runDemoReset(
  dbUrl: string,
  dbAuthToken: string,
  options: RunDemoResetOptions = {},
): Promise<DemoResetSummary> {
  const log = options.log ?? ((message) => console.log(message));
  const createdClient = options.client
    ? null
    : createClient({
        url: dbUrl,
        authToken: toAuthToken(dbAuthToken),
      });
  const client = options.client ?? createdClient;

  if (!client) {
    throw new Error("Failed to initialize database client.");
  }

  const summary: DemoResetSummary = {
    deleted: [],
    usersUpserted: 0,
    sessionsUpserted: 0,
  };

  try {
    // Build all statements for a single atomic batch
    const statements: InStatement[] = [];

    // Delete statements for each demo user
    for (const userId of demoUserIds()) {
      statements.push(...buildDeleteStatements(userId));
    }

    // Upsert users
    for (const user of DEMO_USERS) {
      statements.push(buildUpsertUserStatement(user));
    }

    // Upsert hashed sessions
    for (const user of DEMO_USERS) {
      statements.push(buildUpsertSessionStatement(user.id, user.sessionToken));
    }

    // Execute all statements in a single write transaction
    const results = await client.batch(statements, "write");

    // Parse delete results (4 statements per user)
    const DELETE_STATEMENTS_PER_USER = 4;
    for (let userIndex = 0; userIndex < DEMO_USERS.length; userIndex++) {
      const baseIndex = userIndex * DELETE_STATEMENTS_PER_USER;
      const userId = DEMO_USERS[userIndex]!.id;
      const userSummary: DemoUserDeleteSummary = {
        userId,
        businesses: results[baseIndex]?.rowsAffected ?? 0,
        credentials: results[baseIndex + 1]?.rowsAffected ?? 0,
        userKeys: results[baseIndex + 2]?.rowsAffected ?? 0,
        sessions: results[baseIndex + 3]?.rowsAffected ?? 0,
      };
      summary.deleted.push(userSummary);

      log(`[RESET] Deleted ${userSummary.businesses} ${noun(userSummary.businesses, "business", "businesses")} for ${userId}`);
      log(`[RESET] Deleted ${userSummary.credentials} ${noun(userSummary.credentials, "credential", "credentials")} for ${userId}`);
      log(`[RESET] Deleted ${userSummary.userKeys} ${noun(userSummary.userKeys, "user_key", "user_keys")} for ${userId}`);
      log(`[RESET] Deleted ${userSummary.sessions} ${noun(userSummary.sessions, "session", "sessions")} for ${userId}`);
    }

    // Log upserts
    for (const user of DEMO_USERS) {
      summary.usersUpserted += 1;
      log(`[RESET] Upserted user ${user.id} (${user.email})`);
    }

    for (const user of DEMO_USERS) {
      summary.sessionsUpserted += 1;
      log(`[RESET] Upserted hashed session for ${user.id} (${hashToken(user.sessionToken).slice(0, 12)}...)`);
    }

    log(
      `[RESET] Complete. Deleted ${totalDeleted(summary)} records, upserted ${summary.usersUpserted} users, and upserted ${summary.sessionsUpserted} sessions.`,
    );

    return summary;
  } finally {
    if (createdClient) {
      await createdClient.close();
    }
  }
}
