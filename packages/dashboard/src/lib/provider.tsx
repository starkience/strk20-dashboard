import { createContext, useContext, type ReactNode } from "react";

export interface Strk20Context {
  apiUrl: string;
}

const Ctx = createContext<Strk20Context | null>(null);

export function Strk20Provider({
  apiUrl,
  children,
}: {
  apiUrl: string;
  children: ReactNode;
}) {
  return <Ctx.Provider value={{ apiUrl }}>{children}</Ctx.Provider>;
}

export function useStrk20() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useStrk20 must be used inside <Strk20Provider>");
  return ctx;
}
