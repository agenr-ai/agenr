import { useState } from "react";

import { Tabs } from "../components/primitives";
import { RequireInstance } from "../components/states";
import { DurablesTab } from "./memory/DurablesTab";
import { EpisodesTab } from "./memory/EpisodesTab";
import { ProceduresTab } from "./memory/ProceduresTab";

/**
 * Memory Explorer page: browse durables, episodes, and procedures.
 *
 * @returns The rendered explorer.
 */
export function MemoryPage(): React.ReactElement {
  return (
    <RequireInstance>
      <MemoryInner />
    </RequireInstance>
  );
}

/** Explorer content shown once an instance is confirmed selected. */
function MemoryInner(): React.ReactElement {
  const [tab, setTab] = useState("durables");
  return (
    <div className="stack" style={{ gap: "var(--space-6)" }}>
      <div className="page-head">
        <div className="page-head__lead">
          <h2>Memory explorer</h2>
          <p>Inspect the knowledge corpus. Durable content is lifecycle-managed: retire or supersede rather than editing in place.</p>
        </div>
      </div>

      <Tabs
        tabs={[
          { id: "durables", label: "Durables" },
          { id: "episodes", label: "Episodes" },
          { id: "procedures", label: "Procedures" },
        ]}
        active={tab}
        onChange={setTab}
      />

      {tab === "durables" ? <DurablesTab /> : null}
      {tab === "episodes" ? <EpisodesTab /> : null}
      {tab === "procedures" ? <ProceduresTab /> : null}
    </div>
  );
}
