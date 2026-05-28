/**
 * Example Next.js App Router page rendering the STRK20 dashboard.
 *
 * The dashboard components are client-side (they poll the API), so this page
 * just needs to declare "use client" and wrap them in the Strk20Provider.
 *
 * The Provider's `apiUrl` points at our own Next.js API route, which mounts
 * the @strk20/server handlers — see `./api/strk20/[...path]/route.ts`.
 */

"use client";

import { Dashboard, Strk20Provider } from "@strk20/dashboard";
import "@strk20/dashboard/style.css";

export default function PoolPage() {
  return (
    <Strk20Provider apiUrl="/api/strk20">
      <Dashboard />
    </Strk20Provider>
  );
}
