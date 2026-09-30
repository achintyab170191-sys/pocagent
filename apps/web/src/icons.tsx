import { type ReactNode } from 'react';

const iconPaths: Record<string, string> = {
  chat: 'M21 12a8 8 0 0 1-8 8H7l-4 3v-7a8 8 0 0 1 8-8h2a8 8 0 0 1 8 8z',
  layers: 'M12 3l9 5-9 5-9-5 9-5z M3 13l9 5 9-5 M3 17.5l9 5 9-5',
  clipboard: 'M9 4h6l1 2h3v15H5V6h3l1-2z M9 12l2 2 4-4',
  search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16z M21 21l-4.3-4.3',
  building: 'M4 21V6l8-3 8 3v15 M2 21h20 M9 9h1 M14 9h1 M9 13h1 M14 13h1 M10 21v-4h4v4',
  check: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z M8 12l3 3 5-6',
  phone: 'M8 2h8a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z M12 18h.01',
  plus: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z M12 8v8 M8 12h8',
  sliders: 'M4 21v-7 M4 10V3 M12 21v-9 M12 8V3 M20 21v-5 M20 12V3 M1 14h6 M9 8h6 M17 16h6',
  arrows: 'M17 3l4 4-4 4 M3 7h18 M7 21l-4-4 4-4 M21 17H3',
  refresh: 'M21 12a9 9 0 1 1-3-6.7 M21 3v6h-6',
  shield: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z M9 12l2 2 4-4',
  clip: 'M21 11l-9 9a5 5 0 0 1-7-7l9-9a3 3 0 0 1 4 4l-9 9a1 1 0 0 1-2-2l8-8',
  send: 'M22 2L11 13 M22 2l-7 20-4-9-9-4 20-7z',
  user: 'M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2 M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z',
  spark: 'M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3z M19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8L19 16z',
  x: 'M18 6L6 18 M6 6l12 12',
  dot: 'M12 12h.01',
};

/** Decorative inline icon (stroke, 24px grid). Always aria-hidden: the text next to it carries the meaning. */
export function Icon({ name }: { name: string }) {
  return <svg className="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d={iconPaths[name] ?? iconPaths.dot} /></svg>;
}

export function PageHead({ title, children }: { title: string; children?: ReactNode }) {
  return <div className="page-head"><h2>{title}</h2>{children ? <p className="lead">{children}</p> : null}</div>;
}
