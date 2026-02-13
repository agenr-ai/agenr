import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { BusinessProfile, UserProfile } from "../types/profile";
import { logger } from "../utils/logger";

const EMPTY_PROFILE: UserProfile = { user: "anonymous", businesses: [] };

export class ProfileStore {
  private readonly profile: UserProfile;

  constructor(profilePath: string) {
    const resolvedPath = resolve(profilePath);
    if (!existsSync(resolvedPath)) {
      logger.warn("profile_store_missing_profile_file", {
        path: resolvedPath,
      });
      this.profile = EMPTY_PROFILE;
      return;
    }
    const raw = readFileSync(resolvedPath, "utf8");
    this.profile = JSON.parse(raw) as UserProfile;
  }

  getUserProfile(): UserProfile {
    return this.profile;
  }

  getBusinessProfile(businessId: string): BusinessProfile | undefined {
    return this.profile.businesses.find((business) => business.id === businessId);
  }
}
