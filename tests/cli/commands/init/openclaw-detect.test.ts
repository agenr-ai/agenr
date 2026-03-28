import { describe, expect, it } from "vitest";

import { detectOpenClawInstallation, resolveDefaultOpenClawStateDir } from "../../../../src/cli/commands/init/openclaw-detect.js";

describe("detectOpenClawInstallation", () => {
  it("prefers OPENCLAW_STATE_DIR over the default path", () => {
    const detection = detectOpenClawInstallation(
      {
        OPENCLAW_STATE_DIR: "~/custom-openclaw",
      },
      () => false,
    );

    expect(detection.detected).toBe(true);
    expect(detection.stateDir).toContain("custom-openclaw");
    expect(detection.source).toBe("environment");
    expect(detection.sessionsRoot).toContain("agents");
  });

  it("falls back to the default state dir when no env override exists", () => {
    const defaultStateDir = resolveDefaultOpenClawStateDir();
    const detection = detectOpenClawInstallation({}, (targetPath) => targetPath === defaultStateDir);

    expect(detection.detected).toBe(true);
    expect(detection.stateDir).toBe(defaultStateDir);
    expect(detection.configPath).toBe(`${defaultStateDir}/openclaw.json`);
    expect(detection.source).toBe("default");
  });

  it("returns not detected when neither the env nor filesystem indicate OpenClaw", () => {
    const detection = detectOpenClawInstallation({}, () => false);

    expect(detection.detected).toBe(false);
  });
});
