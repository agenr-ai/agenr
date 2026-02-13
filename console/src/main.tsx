import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import App from "./App";
import { AuthProvider } from "./context/AuthContext";
import { RoleProvider } from "./context/RoleContext";
import "./index.css";

let initialTheme: "dark" | "light" = "light";
try {
  const storedTheme = window.localStorage.getItem("agenr-theme");
  if (storedTheme === "dark" || storedTheme === "light") {
    initialTheme = storedTheme;
  }
} catch {
  // default light
}

document.documentElement.classList.remove("dark", "light");
document.documentElement.classList.add(initialTheme);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <RoleProvider>
          <App />
        </RoleProvider>
      </AuthProvider>
    </BrowserRouter>
  </StrictMode>,
);
