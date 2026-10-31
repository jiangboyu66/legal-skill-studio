/**
 * Small inline SVG icons. Emoji such as 📎 render differently on Windows, macOS and Linux (and sometimes
 * as a plain glyph), so controls use these instead.
 */
const PATHS: Record<string, string> = {
  attach: 'M16.5 6.5 8.7 14.3a2 2 0 0 0 2.8 2.8l8.1-8.1a4 4 0 0 0-5.7-5.7L5.6 11.6a6 6 0 0 0 8.5 8.5l6.4-6.4',
  send: 'M5 12h13M12 5l7 7-7 7',
  stop: 'M7 7h10v10H7z',
  thinking: 'M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2.1h5c0-.9.4-1.6 1-2.1A6 6 0 0 0 12 3Z',
  plus: 'M12 5v14M5 12h14',
  chat: 'M4 5h16v11H8l-4 4V5Z',
};

export function Icon({ name, size = 16, title }: { name: keyof typeof PATHS | string; size?: number; title?: string }) {
  const filled = name === 'stop';
  return (
    <svg
      className={`icon icon-${name}`}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={filled ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth={filled ? 0 : 2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={title ? undefined : true}
      role={title ? 'img' : undefined}
    >
      {title && <title>{title}</title>}
      <path d={PATHS[name] ?? ''} />
    </svg>
  );
}
