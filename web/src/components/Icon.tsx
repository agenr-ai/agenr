/** Inline stroke-based icon set so the console ships no icon-font dependency. */

/** Supported icon identifiers. */
export type IconName =
  | "cockpit"
  | "dream"
  | "proposals"
  | "memory"
  | "procedures"
  | "settings"
  | "search"
  | "chevron-down"
  | "chevron-right"
  | "close"
  | "plus"
  | "refresh"
  | "play"
  | "stop"
  | "check"
  | "x"
  | "alert"
  | "external"
  | "clock"
  | "tag"
  | "branch"
  | "spark"
  | "database"
  | "file"
  | "arrow-right"
  | "trash"
  | "edit"
  | "bolt"
  | "heart"
  | "history";

/** Props accepted by the icon component. */
interface IconProps {
  /** Icon to render. */
  name: IconName;
  /** Pixel size for width and height. Defaults to 18. */
  size?: number;
  /** Extra class names. */
  className?: string;
}

/** Path data for each supported icon, drawn on a 24x24 viewbox. */
const PATHS: Record<IconName, string> = {
  cockpit: "M3 13a9 9 0 0 1 18 0M12 13l4-3M9 20h6",
  dream: "M21 12.8A8 8 0 1 1 11.2 3a6 6 0 0 0 9.8 9.8zM18 4l.7 1.6L20.3 6l-1.6.7L18 8.3l-.7-1.6L15.7 6l1.6-.7z",
  proposals: "M3 7l9 6 9-6M4 6h16v12H4zM3 13h4l2 3h6l2-3h4",
  memory: "M4 6c0-1.5 3.6-3 8-3s8 1.5 8 3-3.6 3-8 3-8-1.5-8-3zM4 6v12c0 1.5 3.6 3 8 3s8-1.5 8-3V6M4 12c0 1.5 3.6 3 8 3s8-1.5 8-3",
  procedures: "M14 3v5h5M14 3H6v18h12V8zM9 13l-1.5 2L9 17M15 13l1.5 2L15 17",
  settings: "M4 6h10M18 6h2M4 12h2M10 12h10M4 18h7M15 18h5M14 4v4M8 10v4M11 16v4",
  search: "M11 19a8 8 0 1 1 0-16 8 8 0 0 1 0 16zM21 21l-4.3-4.3",
  "chevron-down": "M6 9l6 6 6-6",
  "chevron-right": "M9 6l6 6-6 6",
  close: "M6 6l12 12M18 6L6 18",
  plus: "M12 5v14M5 12h14",
  refresh: "M21 12a9 9 0 1 1-3-6.7M21 4v4h-4",
  play: "M7 4v16l13-8z",
  stop: "M7 7h10v10H7z",
  check: "M5 13l4 4L19 7",
  x: "M6 6l12 12M18 6L6 18",
  alert: "M12 9v4M12 17h.01M10.3 3.9 2 18a2 2 0 0 0 1.7 3h16.6a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z",
  external: "M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5",
  clock: "M12 7v5l3 2M12 21a9 9 0 1 1 0-18 9 9 0 0 1 0 18z",
  tag: "M3 12l9-9 9 9-9 9zM12 8h.01",
  branch: "M6 3v12M6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM18 9c0 6-12 1-12 6",
  spark: "M12 3l2.2 6.3L20 12l-5.8 2.7L12 21l-2.2-6.3L4 12l5.8-2.7z",
  database: "M4 6c0-1.5 3.6-3 8-3s8 1.5 8 3-3.6 3-8 3-8-1.5-8-3zM4 6v12c0 1.5 3.6 3 8 3s8-1.5 8-3V6",
  file: "M14 3v5h5M14 3H6v18h12V8z",
  "arrow-right": "M5 12h14M13 6l6 6-6 6",
  trash: "M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13",
  edit: "M4 20h4L20 8l-4-4L4 16zM14 6l4 4",
  bolt: "M13 2 4 14h7l-1 8 9-12h-7z",
  heart: "M12 20s-7-4.5-9.5-9A4.5 4.5 0 0 1 12 6a4.5 4.5 0 0 1 9.5 5c-2.5 4.5-9.5 9-9.5 9z",
  history: "M3 12a9 9 0 1 0 3-6.7M3 5v4h4M12 8v4l3 2",
};

/**
 * Renders one inline SVG icon.
 *
 * @param props - Icon name, size, and optional class names.
 * @returns The rendered SVG element.
 */
export function Icon({ name, size = 18, className }: IconProps): React.ReactElement {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
