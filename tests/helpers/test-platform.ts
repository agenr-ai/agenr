/** True on Windows hosts or when AGENR_TEST_WIN=1 simulates Windows test policy locally. */
export function isWindowsTestMode(): boolean {
  return process.platform === "win32" || process.env.AGENR_TEST_WIN === "1";
}
