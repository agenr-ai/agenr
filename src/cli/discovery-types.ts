export type DiscoveryFindings = Record<string, string[]>;

export interface DiscoveryResult {
  findings: DiscoveryFindings;
  pagesVisited: number;
  toolCalls: number;
  sourceUrls: string[];
}

export function createEmptyFindings(): DiscoveryFindings {
  return {};
}
