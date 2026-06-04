import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";
import "@/i18n";
import { loadAndApplyTheme, watchSystemTheme } from "@/lib/theme";

function applyPlatformClass() {
  const isTauri = "__TAURI_INTERNALS__" in window || "__TAURI__" in window;
  if (isTauri && navigator.userAgent.includes("Mac OS X")) {
    document.documentElement.classList.add("platform-macos");
  }
}

// Apply theme before render to avoid flash
async function initApp() {
  applyPlatformClass();
  await loadAndApplyTheme();
  watchSystemTheme();

  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );
}

initApp();
