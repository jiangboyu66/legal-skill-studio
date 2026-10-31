/**
 * Safe condition language for workflow branches (no eval):
 *   nodes.check.output.overall_risk == "high"
 *   count(nodes.check.output.findings, "risk_level", "high") > 0 && inputs.channel != "SMS"
 *   nodes.legal_approval.decision == "approved"
 * Supports: paths (a.b[0].c), strings, numbers, true/false/null, == != > >= < <=, && || !, ( ),
 * functions len(x), contains(x, y), count(list, field, value), any(list, field, value).
 */
type Node =
  | { k: 'lit'; v: unknown }
  | { k: 'path'; parts: (string | number)[] }
  | { k: 'not'; e: Node }
  | { k: 'bin'; op: string; l: Node; r: Node }
  | { k: 'call'; fn: string; args: Node[] };

const FUNCS = new Set(['len', 'contains', 'count', 'any']);

function tokenize(src: string): string[] {
  const out: string[] = [];
  const re = /\s*(?:(==|!=|>=|<=|&&|\|\||[()!<>,.[\]])|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')|(\d+(?:\.\d+)?)|([A-Za-z_][A-Za-z0-9_]*))/y;
  let pos = 0;
  while (pos < src.length) {
    if (/^\s*$/.test(src.slice(pos))) break;
    re.lastIndex = pos;
    const m = re.exec(src);
    if (!m) throw new Error(`无法识别的字符：「${src.slice(pos).trim().slice(0, 10)}」`);
    out.push(m[1] ?? m[2] ?? m[3] ?? m[4]);
    pos = re.lastIndex;
  }
  return out;
}

class Parser {
  i = 0;
  constructor(private t: string[]) {}
  peek() {
    return this.t[this.i];
  }
  next() {
    return this.t[this.i++];
  }
  expect(s: string) {
    if (this.next() !== s) throw new Error(`缺少「${s}」`);
  }
  parse(): Node {
    const n = this.or();
    if (this.i < this.t.length) throw new Error(`多余的内容：「${this.t.slice(this.i).join(' ')}」`);
    return n;
  }
  or(): Node {
    let l = this.and();
    while (this.peek() === '||') (this.next(), (l = { k: 'bin', op: '||', l, r: this.and() }));
    return l;
  }
  and(): Node {
    let l = this.not();
    while (this.peek() === '&&') (this.next(), (l = { k: 'bin', op: '&&', l, r: this.not() }));
    return l;
  }
  not(): Node {
    if (this.peek() === '!') {
      this.next();
      return { k: 'not', e: this.not() };
    }
    return this.cmp();
  }
  cmp(): Node {
    const l = this.primary();
    const op = this.peek();
    if (['==', '!=', '>', '>=', '<', '<='].includes(op)) {
      this.next();
      return { k: 'bin', op, l, r: this.primary() };
    }
    return l;
  }
  primary(): Node {
    const t = this.next();
    if (t === undefined) throw new Error('表达式不完整');
    if (t === '(') {
      const e = this.or();
      this.expect(')');
      return e;
    }
    if (/^["']/.test(t)) return { k: 'lit', v: t.slice(1, -1).replace(/\\(.)/g, '$1') };
    if (/^\d/.test(t)) return { k: 'lit', v: Number(t) };
    if (t === 'true' || t === 'false') return { k: 'lit', v: t === 'true' };
    if (t === 'null') return { k: 'lit', v: null };
    if (/^[A-Za-z_]/.test(t)) {
      if (this.peek() === '(') {
        if (!FUNCS.has(t)) throw new Error(`不支持的函数：${t}`);
        this.next();
        const args: Node[] = [];
        if (this.peek() !== ')') {
          args.push(this.or());
          while (this.peek() === ',') (this.next(), args.push(this.or()));
        }
        this.expect(')');
        return { k: 'call', fn: t, args };
      }
      const parts: (string | number)[] = [t];
      for (;;) {
        if (this.peek() === '.') {
          this.next();
          const id = this.next();
          if (!id || !/^[A-Za-z_]/.test(id)) throw new Error('路径格式错误');
          parts.push(id);
        } else if (this.peek() === '[') {
          this.next();
          const n = this.next();
          if (!/^\d+$/.test(n ?? '')) throw new Error('下标必须是数字');
          this.expect(']');
          parts.push(Number(n));
        } else break;
      }
      return { k: 'path', parts };
    }
    throw new Error(`无法解析「${t}」`);
  }
}

export function parseExpr(src: string): Node {
  return new Parser(tokenize(src)).parse();
}

function get(ctx: unknown, parts: (string | number)[]): unknown {
  let cur = ctx;
  for (const p of parts) {
    if (cur === null || cur === undefined) return undefined;
    cur = (cur as Record<string | number, unknown>)[p];
  }
  return cur;
}

function evalNode(n: Node, ctx: unknown): unknown {
  switch (n.k) {
    case 'lit':
      return n.v;
    case 'path':
      return get(ctx, n.parts);
    case 'not':
      return !evalNode(n.e, ctx);
    case 'call': {
      const a = n.args.map((x) => evalNode(x, ctx));
      if (n.fn === 'len') return Array.isArray(a[0]) || typeof a[0] === 'string' ? (a[0] as unknown[]).length : 0;
      if (n.fn === 'contains') return Array.isArray(a[0]) ? a[0].includes(a[1]) : typeof a[0] === 'string' ? a[0].includes(String(a[1])) : false;
      const list = Array.isArray(a[0]) ? (a[0] as Record<string, unknown>[]) : [];
      const hits = list.filter((x) => x && x[String(a[1])] === a[2]).length;
      return n.fn === 'count' ? hits : hits > 0;
    }
    case 'bin': {
      if (n.op === '&&') return !!evalNode(n.l, ctx) && !!evalNode(n.r, ctx);
      if (n.op === '||') return !!evalNode(n.l, ctx) || !!evalNode(n.r, ctx);
      const l = evalNode(n.l, ctx);
      const r = evalNode(n.r, ctx);
      switch (n.op) {
        case '==':
          return l === r || (l == null && r == null);
        case '!=':
          return !(l === r || (l == null && r == null));
        case '>':
          return Number(l) > Number(r);
        case '>=':
          return Number(l) >= Number(r);
        case '<':
          return Number(l) < Number(r);
        case '<=':
          return Number(l) <= Number(r);
      }
    }
  }
  return undefined;
}

export function evaluate(src: string, ctx: unknown): boolean {
  return !!evalNode(parseExpr(src), ctx);
}

/** Node ids referenced as nodes.<id>... (used to validate that conditions only look upstream). */
export function referencedNodes(src: string): string[] {
  const out = new Set<string>();
  const walk = (n: Node) => {
    if (n.k === 'path' && n.parts[0] === 'nodes' && typeof n.parts[1] === 'string') out.add(n.parts[1]);
    if (n.k === 'not') walk(n.e);
    if (n.k === 'bin') (walk(n.l), walk(n.r));
    if (n.k === 'call') n.args.forEach(walk);
  };
  walk(parseExpr(src));
  return [...out];
}
