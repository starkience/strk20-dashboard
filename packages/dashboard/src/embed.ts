import { createRoot } from "react-dom/client";
import { createElement } from "react";
import { Dashboard } from "./Dashboard.js";
import { Strk20Provider } from "./lib/provider.js";

declare global {
  interface Window {
    Strk20Embed?: { mount: (selector: string, apiUrl?: string) => void };
  }
}

function mount(selector: string, apiUrl?: string) {
  const el = document.querySelector(selector);
  if (!el) {
    console.warn(`[strk20] mount target not found: ${selector}`);
    return;
  }
  const root = createRoot(el);
  root.render(
    createElement(Strk20Provider, {
      apiUrl: apiUrl ?? "https://api.strk20.xyz",
      children: createElement(Dashboard),
    })
  );
}

if (typeof window !== "undefined") {
  window.Strk20Embed = { mount };
  const auto = document.querySelector("[data-strk20-dashboard]");
  if (auto) mount("[data-strk20-dashboard]", auto.getAttribute("data-api") ?? undefined);
}
