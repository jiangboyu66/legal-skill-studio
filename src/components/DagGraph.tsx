import type { NodeStatus, WorkflowNode } from '../../shared/types';

const W = 160;
const H = 60;
const GX = 44;
const GY = 18;
const PAD = 14;

export interface DagNodeInfo {
  status?: NodeStatus;
  /** Second line, e.g. skill name and version */
  sub?: string;
}

function levels(nodes: WorkflowNode[]): Map<string, number> {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const memo = new Map<string, number>();
  const visit = (id: string, stack: Set<string>): number => {
    if (memo.has(id)) return memo.get(id)!;
    if (stack.has(id)) return 0; // cycle: validation reports it
    stack.add(id);
    const n = byId.get(id);
    const lv = n && n.needs.length ? 1 + Math.max(...n.needs.filter((d) => byId.has(d)).map((d) => visit(d, stack)), -1) : 0;
    stack.delete(id);
    memo.set(id, lv);
    return lv;
  };
  nodes.forEach((n) => visit(n.id, new Set()));
  return memo;
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/**
 * Workflow DAG as SVG: columns are dependency levels (left → right), dashed edges mark conditional
 * nodes ("if"), approval nodes are drawn with a double border. Nodes are keyboard-selectable.
 */
export default function DagGraph({
  nodes,
  info = {},
  selected,
  onSelect,
  testId = 'dag',
}: {
  nodes: WorkflowNode[];
  info?: Record<string, DagNodeInfo>;
  selected?: string;
  onSelect?: (id: string) => void;
  testId?: string;
}) {
  if (!nodes.length) return <div className="empty small">还没有节点。</div>;
  const lv = levels(nodes);
  const cols = new Map<number, WorkflowNode[]>();
  for (const n of nodes) cols.set(lv.get(n.id) ?? 0, [...(cols.get(lv.get(n.id) ?? 0) ?? []), n]);
  const maxRows = Math.max(...[...cols.values()].map((c) => c.length));
  const width = PAD * 2 + (Math.max(...cols.keys()) + 1) * (W + GX) - GX;
  const height = PAD * 2 + maxRows * (H + GY) - GY;
  const pos = new Map<string, { x: number; y: number }>();
  for (const [l, col] of cols) {
    const offset = ((maxRows - col.length) * (H + GY)) / 2;
    col.forEach((n, i) => pos.set(n.id, { x: PAD + l * (W + GX), y: PAD + offset + i * (H + GY) }));
  }

  return (
    <div className="dag-wrap" data-testid={testId}>
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} style={{ maxWidth: '100%', height: 'auto' }} role="group" aria-label="工作流节点图">
        <defs>
          <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" className="dag-arrow" />
          </marker>
        </defs>
        {nodes.flatMap((n) =>
          n.needs
            .filter((d) => pos.has(d))
            .map((d) => {
              const a = pos.get(d)!;
              const b = pos.get(n.id)!;
              const x1 = a.x + W;
              const y1 = a.y + H / 2;
              const x2 = b.x - 2;
              const y2 = b.y + H / 2;
              const mx = (x1 + x2) / 2;
              const st = info[n.id]?.status;
              return (
                <path
                  key={`${d}->${n.id}`}
                  d={`M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`}
                  className={`dag-edge ${n.when ? 'cond' : ''} ${st === 'skipped' ? 'off' : ''}`}
                  markerEnd="url(#arrow)"
                />
              );
            }),
        )}
        {nodes.map((n) => {
          const p = pos.get(n.id)!;
          const st = info[n.id]?.status;
          const sub = info[n.id]?.sub ?? (n.type === 'approval' ? '人工审批' : '');
          const label = `${n.name}${st ? `：${st}` : ''}`;
          return (
            <g
              key={n.id}
              transform={`translate(${p.x}, ${p.y})`}
              className={`dag-node t-${n.type} ${st ? `s-${st}` : ''} ${selected === n.id ? 'sel' : ''} ${onSelect ? 'click' : ''}`}
              data-testid={`dag-node-${n.id}`}
              data-status={st}
              role={onSelect ? 'button' : undefined}
              tabIndex={onSelect ? 0 : undefined}
              aria-label={label}
              onClick={() => onSelect?.(n.id)}
              onKeyDown={(e) => {
                if (onSelect && (e.key === 'Enter' || e.key === ' ')) {
                  e.preventDefault();
                  onSelect(n.id);
                }
              }}
            >
              <title>{`${n.name}${n.when ? `\n条件：${n.when}` : ''}`}</title>
              <rect width={W} height={H} rx={n.type === 'approval' ? 14 : 6} className="box" />
              {n.type === 'approval' && <rect x={3} y={3} width={W - 6} height={H - 6} rx={11} className="inner" />}
              <text x={12} y={24} className="name">
                {clip(n.name, 11)}
              </text>
              <text x={12} y={44} className="sub">
                {clip(sub, 16)}
              </text>
              {n.when && (
                <text x={W - 10} y={16} textAnchor="end" className="cond-mark">
                  if
                </text>
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}
