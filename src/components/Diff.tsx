import type { ReactNode } from 'react';

/** Minimal line diff (LCS) to show reviewers exactly what changed. */
export function lineDiff(a: string, b: string): { t: ' ' | '+' | '-'; s: string }[] {
  const x = a.split('\n');
  const y = b.split('\n');
  if (x.length * y.length > 400_000) return [...x.map((s) => ({ t: '-' as const, s })), ...y.map((s) => ({ t: '+' as const, s }))];
  const dp = Array.from({ length: x.length + 1 }, () => new Array<number>(y.length + 1).fill(0));
  for (let i = x.length - 1; i >= 0; i--) for (let j = y.length - 1; j >= 0; j--) dp[i][j] = x[i] === y[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out: { t: ' ' | '+' | '-'; s: string }[] = [];
  let i = 0;
  let j = 0;
  while (i < x.length && j < y.length) {
    if (x[i] === y[j]) (out.push({ t: ' ', s: x[i] }), i++, j++);
    else if (dp[i + 1][j] >= dp[i][j + 1]) out.push({ t: '-', s: x[i++] });
    else out.push({ t: '+', s: y[j++] });
  }
  while (i < x.length) out.push({ t: '-', s: x[i++] });
  while (j < y.length) out.push({ t: '+', s: y[j++] });
  return out;
}

export function Diff({ before, after, same }: { before?: string; after: string; same?: ReactNode }) {
  if (before === undefined) return <pre className="raw">{after}</pre>;
  const d = lineDiff(before, after);
  if (!d.some((l) => l.t !== ' ')) return <div className="muted small">{same ?? '与线上版本相同。'}</div>;
  return (
    <pre className="raw diff" data-testid="diff">
      {d.map((l, i) => (
        <div key={i} className={l.t === '+' ? 'add' : l.t === '-' ? 'del' : ''}>
          {l.t} {l.s}
        </div>
      ))}
    </pre>
  );
}

