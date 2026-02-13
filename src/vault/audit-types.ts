export const AUDIT_ACTIONS = [
  "credential_stored",
  "credential_retrieved",
  "credential_deleted",
  "credential_rotated",
  "dek_generated",
  "dek_unwrapped",
  "connection_initiated",
  "connection_completed",
  "connection_failed",
  "credential_revoked_by_admin",
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export interface AuditEntry {
  id: string;
  userId: string;
  serviceId: string;
  action: AuditAction;
  executionId?: string;
  ipAddress?: string;
  metadata?: Record<string, unknown>;
  timestamp: string;
}
