import type { Durable, DurableKind } from "../types.js";

/** Bounded active corpus row shown to dreaming extract for claim-key reuse. */
export interface DreamClaimKeyContextDurable {
  id: string;
  type: DurableKind;
  subject: string;
  content: string;
  claimKey: string;
  project?: string;
}

/**
 * Maps active corpus durables into the slim prompt context used by dreaming extract.
 *
 * @param durables - Active keyed durables selected for one episode.
 * @returns Prompt-safe claim-key context rows.
 */
export function toDreamClaimKeyContextDurables(durables: Durable[]): DreamClaimKeyContextDurable[] {
  return durables.flatMap((durable) => {
    const claimKey = durable.claim_key?.trim();
    if (!claimKey) {
      return [];
    }

    return [
      {
        id: durable.id,
        type: durable.type,
        subject: durable.subject,
        content: durable.content,
        claimKey,
        ...(durable.project ? { project: durable.project } : {}),
      },
    ];
  });
}
