import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";

import { useInstances } from "../state/InstanceContext";
import { truncate } from "../lib/format";
import { Icon } from "./Icon";
import { StatusDot } from "./primitives";

/**
 * Topbar control for viewing and switching the active instance.
 *
 * @returns The rendered switcher.
 */
export function InstanceSwitcher(): React.ReactElement {
  const { instances, selected, select } = useInstances();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();

  useEffect(() => {
    if (!open) {
      return;
    }
    const onClick = (event: MouseEvent): void => {
      if (ref.current && !ref.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  const dbLabel = selected?.dbPath ? truncate(selected.dbPath.replace(/^.*\//, ""), 24) : "no database";

  return (
    <div className="switcher" ref={ref}>
      <button className="switcher__btn" onClick={() => setOpen((value) => !value)}>
        <StatusDot status={selected ? (selected.error ? "danger" : selected.dbExists ? "success" : "warning") : "neutral"} />
        <span className="switcher__meta grow">
          <span className="switcher__name truncate">{selected?.record.name ?? "No instance"}</span>
          <span className="switcher__path truncate">{dbLabel}</span>
        </span>
        <Icon name="chevron-down" size={15} />
      </button>

      {open ? (
        <div className="switcher__menu">
          {instances.length === 0 ? (
            <div className="muted" style={{ padding: "var(--space-3)", fontSize: "var(--text-sm)" }}>
              No instances registered yet.
            </div>
          ) : (
            instances.map((instance) => (
              <div
                key={instance.record.id}
                className={`switcher__option${instance.record.id === selected?.record.id ? " is-active" : ""}`}
                onClick={() => {
                  void select(instance.record.id);
                  setOpen(false);
                }}
              >
                <StatusDot status={instance.error ? "danger" : instance.dbExists ? "success" : "warning"} />
                <span className="grow stack" style={{ gap: 1, minWidth: 0 }}>
                  <span className="truncate" style={{ fontSize: "var(--text-sm)", fontWeight: 600 }}>
                    {instance.record.name}
                  </span>
                  <span className="switcher__path truncate">{instance.dbPath ?? instance.error ?? "unresolved"}</span>
                </span>
                {instance.record.id === selected?.record.id ? <Icon name="check" size={15} /> : null}
              </div>
            ))
          )}
          <div
            className="switcher__option"
            onClick={() => {
              navigate("/settings");
              setOpen(false);
            }}
            style={{ borderTop: "1px solid var(--border-subtle)", marginTop: "var(--space-2)", paddingTop: "var(--space-3)" }}
          >
            <Icon name="settings" size={15} />
            <span style={{ fontSize: "var(--text-sm)" }}>Manage instances</span>
          </div>
        </div>
      ) : null}
    </div>
  );
}
