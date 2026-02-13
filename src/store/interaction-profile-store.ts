import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import type { InteractionProfile } from "../types/profile";

export class InteractionProfileStore {
  private readonly profiles = new Map<string, InteractionProfile>();

  constructor(directoryPath: string) {
    const resolvedDirectory = resolve(directoryPath);
    let files: string[];
    try {
      files = readdirSync(resolvedDirectory).filter((file) => file.endsWith(".json"));
    } catch {
      files = [];
    }

    for (const file of files) {
      const filePath = join(resolvedDirectory, file);
      const parsed = JSON.parse(readFileSync(filePath, "utf8")) as InteractionProfile;
      this.profiles.set(parsed.platform, parsed);
    }
  }

  getByPlatform(platform: string): InteractionProfile | undefined {
    return this.profiles.get(platform);
  }

  listPlatforms(): string[] {
    return Array.from(this.profiles.keys());
  }
}
