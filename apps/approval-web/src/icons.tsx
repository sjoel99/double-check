import type { JSX } from "react";

const P: Record<string, JSX.Element> = {
  key: <><circle cx="8" cy="15" r="4" /><path d="M10.8 12.2 20 3" /><path d="M17 6l3 3" /><path d="M15 8l2 2" /></>,
  shield: <path d="M12 3 4 6v6c0 4.5 3.4 8.3 8 9 4.6-.7 8-4.5 8-9V6l-8-3Z" />,
  shieldcheck: <><path d="M12 3 4 6v6c0 4.5 3.4 8.3 8 9 4.6-.7 8-4.5 8-9V6l-8-3Z" /><path d="m8.5 12 2.5 2.5 4.5-5" /></>,
  shieldalert: <><path d="M12 3 4 6v6c0 4.5 3.4 8.3 8 9 4.6-.7 8-4.5 8-9V6l-8-3Z" /><path d="M12 8v5" /><path d="M12 16.5v.01" /></>,
  check: <path d="m5 12.5 4.5 4.5L19 7.5" />,
  x: <><path d="M6 6l12 12" /><path d="M18 6 6 18" /></>,
  arrowup: <><path d="M7 17 17 7" /><path d="M9 7h8v8" /></>,
  arrowdown: <><path d="M17 7 7 17" /><path d="M15 17H7V9" /></>,
  back: <path d="M15 6l-6 6 6 6" />,
  chev: <path d="m9 6 6 6-6 6" />,
  home: <><path d="M4 11 12 4l8 7" /><path d="M6 10v10h12V10" /></>,
  list: <><path d="M8 6h12" /><path d="M8 12h12" /><path d="M8 18h12" /><path d="M4 6h.01" /><path d="M4 12h.01" /><path d="M4 18h.01" /></>,
  clock: <><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></>,
  phone: <><rect x="7" y="3" width="10" height="18" rx="2.5" /><path d="M11 17.5h2" /></>,
  server: <><rect x="4" y="4" width="16" height="7" rx="2" /><rect x="4" y="13" width="16" height="7" rx="2" /><path d="M8 7.5h.01" /><path d="M8 16.5h.01" /></>,
  bolt: <path d="M13 3 5 13.5h6L10 21l8-10.5h-6L13 3Z" />,
  send: <><path d="M5 12h9" /><path d="M4 5l16 7-16 7 3-7-3-7Z" /></>,
  finger: <><path d="M7.5 18.5c1-1.6 1.5-3.4 1.5-5.5a3 3 0 0 1 6 0c0 1.2-.1 2.4-.4 3.5" /><path d="M5 15.5c.6-1.2 1-2.5 1-4a6 6 0 0 1 10.5-4" /><path d="M18.4 10c.1.6.1 1.2.1 2 0 2.6-.6 5-1.7 7" /><path d="M12 13c0 3-.8 5.5-2.3 7.5" /><path d="M14.7 18.5c-.3.9-.7 1.7-1.2 2.5" /></>,
  ext: <><path d="M14 5h5v5" /><path d="M19 5l-8 8" /><path d="M17 14v4a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 5 18V8.5A1.5 1.5 0 0 1 6.5 7H10" /></>,
  lock: <><rect x="5" y="10.5" width="14" height="10" rx="2.5" /><path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5" /></>,
  plus: <><path d="M12 5v14" /><path d="M5 12h14" /></>,
  copy: <><rect x="8" y="8" width="12" height="12" rx="2.5" /><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" /></>,
  drop: <path d="M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11Z" />,
  refresh: <><path d="M20 11a8 8 0 0 0-14.5-4.5L4 8" /><path d="M4 4v4h4" /><path d="M4 13a8 8 0 0 0 14.5 4.5L20 16" /><path d="M20 20v-4h-4" /></>,
};

export function Icon({ name, size = 20, color = "currentColor", sw = 1.8 }: { name: keyof typeof P | string; size?: number; color?: string; sw?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {P[name]}
    </svg>
  );
}

export function Logo({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden="true">
      <rect x="1" y="1" width="30" height="30" rx="9" fill="#14171C" stroke="#262B33" />
      <circle cx="12" cy="16" r="5" stroke="#C8F169" strokeWidth="2" />
      <circle cx="20" cy="16" r="5" stroke="#EDEEF0" strokeWidth="2" />
    </svg>
  );
}
