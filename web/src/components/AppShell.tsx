import { NavLink, Outlet, useLocation } from "react-router-dom";

import { useInstances } from "../state/InstanceContext";
import { Icon, type IconName } from "./Icon";
import { InstanceSwitcher } from "./InstanceSwitcher";

/** One sidebar navigation entry. */
interface NavEntry {
  to: string;
  label: string;
  icon: IconName;
  crumb: string;
  description: string;
}

/** Primary navigation entries with their topbar metadata. */
const NAV: NavEntry[] = [
  { to: "/", label: "Ops Cockpit", icon: "cockpit", crumb: "Overview", description: "Corpus health, recent runs, and pending work at a glance." },
  { to: "/dreaming", label: "Dreaming Runs", icon: "dream", crumb: "Maintenance", description: "Launch and monitor corpus maintenance runs." },
  { to: "/proposals", label: "Proposal Review", icon: "proposals", crumb: "Adjudication", description: "Review and adjudicate claim-key proposals." },
  { to: "/memory", label: "Memory Explorer", icon: "memory", crumb: "Knowledge", description: "Browse durables, episodes, and procedures." },
  { to: "/procedures", label: "Procedure Editor", icon: "procedures", crumb: "Authoring", description: "Edit and sync repo-authored procedure YAML." },
  { to: "/settings", label: "Instance Settings", icon: "settings", crumb: "Configuration", description: "Register and manage local agenr instances." },
];

/**
 * Resolves topbar metadata for the current path.
 *
 * @param pathname - Current location path.
 * @returns The matching nav entry, defaulting to the cockpit.
 */
function resolveEntry(pathname: string): NavEntry {
  if (pathname === "/") {
    return NAV[0];
  }
  return NAV.find((entry) => entry.to !== "/" && pathname.startsWith(entry.to)) ?? NAV[0];
}

/**
 * Application chrome: sidebar navigation, topbar, instance switcher, content.
 *
 * @returns The rendered shell with a routed outlet.
 */
export function AppShell(): React.ReactElement {
  const location = useLocation();
  const { selected } = useInstances();
  const entry = resolveEntry(location.pathname);

  return (
    <div className="shell">
      <nav className="sidebar">
        <div className="brand">
          <span className="brand__mark">a</span>
          <span className="stack" style={{ gap: 0 }}>
            <span className="brand__name">agenr</span>
            <span className="brand__tag">operator console</span>
          </span>
        </div>

        <div className="nav">
          <div className="nav__group">Workspace</div>
          {NAV.map((item) => (
            <NavLink key={item.to} to={item.to} end={item.to === "/"} className={({ isActive }) => `nav__item${isActive ? " is-active" : ""}`}>
              <Icon name={item.icon} className="nav__icon" />
              <span className="grow">{item.label}</span>
            </NavLink>
          ))}
        </div>

        <div className="sidebar__foot">
          <span>local-only</span>
          <span className="row" style={{ gap: 5 }}>
            <span className={`dot dot--${selected ? "success" : "neutral"}`} />
            loopback
          </span>
        </div>
      </nav>

      <div className="main">
        <header className="topbar">
          <div className="topbar__title">
            <span className="topbar__crumb">{entry.crumb}</span>
            <h1>{entry.label}</h1>
          </div>
          <div className="topbar__actions">
            <InstanceSwitcher />
          </div>
        </header>

        <main className="content">
          <div className="content__inner">
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  );
}
