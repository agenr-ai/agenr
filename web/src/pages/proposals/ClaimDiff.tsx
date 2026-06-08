/** Claim-key before/after diff rendering. */
export function ClaimDiff({ current, proposed }: { current: string[]; proposed: string[] }): React.ReactElement {
  return (
    <div className="diff">
      {current.length === 0 ? (
        <div className="diff__row diff__row--del">
          <span className="diff__mark">-</span>
          <span className="muted">(no current key)</span>
        </div>
      ) : (
        current.map((key) => (
          <div key={`c-${key}`} className="diff__row diff__row--del">
            <span className="diff__mark">-</span>
            <span>{key}</span>
          </div>
        ))
      )}
      {proposed.map((key) => (
        <div key={`p-${key}`} className="diff__row diff__row--add">
          <span className="diff__mark">+</span>
          <span>{key}</span>
        </div>
      ))}
    </div>
  );
}
