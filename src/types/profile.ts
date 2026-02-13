export interface UserProfile {
  user: string;
  businesses: BusinessProfile[];
}

export interface BusinessProfile {
  id: string;
  name: string;
  platform: string;
  location?: string;
  preferences?: Record<string, unknown>;
}

export interface InteractionCapability {
  operation: "discover" | "query" | "execute";
  method: string;
  endpoint: string;
  authRequired: boolean;
  description: string;
}

export interface InteractionProfile {
  platform: string;
  version: string;
  generated: string;
  method: "manual" | "ai-generated";
  capabilities: {
    discover: InteractionCapability;
    query: InteractionCapability;
    execute: InteractionCapability;
  };
}
