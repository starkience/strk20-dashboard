import { createRoot } from "react-dom/client";
import { StrictMode } from "react";
import { Receipts } from "./Receipts.js";
import { Strk20Provider } from "./lib/provider.js";
import "./styles/tokens.css";
import "./styles/receipts.css";

const apiUrl = import.meta.env.VITE_STRK20_API_URL ?? "http://localhost:8787";

const root = createRoot(document.getElementById("root")!);
root.render(
  <StrictMode>
    <Strk20Provider apiUrl={apiUrl}>
      <Receipts />
    </Strk20Provider>
  </StrictMode>,
);
