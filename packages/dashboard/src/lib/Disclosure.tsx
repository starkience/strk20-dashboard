import type { ReactNode } from "react";

/**
 * Collapsible metric group — native <details>, no JS state. Summary row shows
 * a label + optional headline value; expands to reveal the rows. Used for
 * many-variable metrics (token list, note ages, apps).
 */
export function Disclosure({
  label,
  summary,
  children,
  defaultOpen = false,
}: {
  label: ReactNode;
  summary?: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
}) {
  return (
    <details data-strk20-disclosure {...(defaultOpen ? { open: true } : {})}>
      <summary data-strk20-disclosure-summary>
        <span className="k">{label}</span>
        {summary != null && <span className="v">{summary}</span>}
      </summary>
      <div data-strk20-disclosure-body>{children}</div>
    </details>
  );
}
