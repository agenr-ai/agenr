import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";

import "./styles/tokens.css";
import "./styles/global.css";
import "./styles/components.css";
import "./styles/shell.css";

import { AppShell } from "./components/AppShell";
import { ToastProvider } from "./components/Toast";
import { InstanceProvider } from "./state/InstanceContext";
import { CockpitPage } from "./pages/CockpitPage";
import { DreamingPage } from "./pages/DreamingPage";
import { ProposalsPage } from "./pages/ProposalsPage";
import { MemoryPage } from "./pages/MemoryPage";
import { ProceduresPage } from "./pages/ProceduresPage";
import { SettingsPage } from "./pages/SettingsPage";

const container = document.getElementById("root");
if (!container) {
  throw new Error("Root container #root was not found.");
}

createRoot(container).render(
  <StrictMode>
    <ToastProvider>
      <InstanceProvider>
        <BrowserRouter>
          <Routes>
            <Route element={<AppShell />}>
              <Route index element={<CockpitPage />} />
              <Route path="dreaming" element={<DreamingPage />} />
              <Route path="proposals" element={<ProposalsPage />} />
              <Route path="memory" element={<MemoryPage />} />
              <Route path="procedures" element={<ProceduresPage />} />
              <Route path="settings" element={<SettingsPage />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Route>
          </Routes>
        </BrowserRouter>
      </InstanceProvider>
    </ToastProvider>
  </StrictMode>,
);
