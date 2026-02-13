const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
const dateFormatter = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
});

export function relativeTime(iso: string): string {
  const value = Date.parse(iso);
  if (Number.isNaN(value)) {
    return iso;
  }

  const diffMs = Date.now() - value;

  if (diffMs < 45_000) {
    return "just now";
  }

  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 60) {
    return rtf.format(-minutes, "minute");
  }

  const hours = Math.floor(diffMs / 3_600_000);
  if (hours < 24) {
    return rtf.format(-hours, "hour");
  }

  if (hours < 48) {
    return "yesterday";
  }

  return dateFormatter.format(value);
}
