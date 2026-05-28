import type { ReactNode } from "react";

/**
 * The single layout primitive for the whole dashboard: one variable per
 * horizontal row — label on the left, optional faint context, value on the
 * right. Everything reads like a spec sheet. Restyle freely.
 */
export function Row({
  label,
  value,
  context,
}: {
  label: ReactNode;
  value: ReactNode;
  context?: ReactNode;
}) {
  return (
    <div data-strk20-row>
      <span className="k">{label}</span>
      <span className="r">
        {context != null && <span className="ctx">{context}</span>}
        <span className="v">{value}</span>
      </span>
    </div>
  );
}
