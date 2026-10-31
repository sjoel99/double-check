import type { ReactNode } from "react";

/** Linha rótulo → valor das telas de confirmação. */
export const Detail = ({ label, value, mono }: { label: string; value: ReactNode; mono?: boolean }) => (
  <div className="detail">
    <div>{label}</div>
    <div className={mono ? "mono" : undefined}>{value}</div>
  </div>
);
