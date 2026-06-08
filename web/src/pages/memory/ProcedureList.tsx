/** Bulleted list block used in the procedure detail drawer. */
export function ProcedureList({ title, items }: { title: string; items: string[] }): React.ReactElement | null {
  if (items.length === 0) {
    return null;
  }
  return (
    <div className="stack" style={{ gap: "var(--space-2)" }}>
      <span className="section-title">{title}</span>
      <ul style={{ paddingLeft: "var(--space-5)", display: "flex", flexDirection: "column", gap: 4 }}>
        {items.map((item, index) => (
          <li key={index} className="secondary" style={{ fontSize: "var(--text-sm)" }}>
            {item}
          </li>
        ))}
      </ul>
    </div>
  );
}
