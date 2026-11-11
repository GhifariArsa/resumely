/** Unified line diff (LCS-based) of two texts. Returns "" when equal. */
export function unifiedDiff(a: string, b: string, o: { from: string; to: string; context?: number }): string {
  if (a === b) return "";
  const ctx = o.context ?? 3;
  const x = a === "" ? [] : a.replace(/\n$/, "").split("\n");
  const y = b === "" ? [] : b.replace(/\n$/, "").split("\n");
  const n = x.length;
  const m = y.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i]![j] = x[i] === y[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);

  type Op = { t: " " | "-" | "+"; s: string };
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && x[i] === y[j]) ops.push({ t: " ", s: x[i++]! }), j++;
    else if (j < m && (i === n || dp[i]![j + 1]! >= dp[i + 1]![j]!)) ops.push({ t: "+", s: y[j++]! });
    else ops.push({ t: "-", s: x[i++]! });
  }

  const changed = ops.map((op, k) => (op.t === " " ? -1 : k)).filter((k) => k >= 0);
  if (!changed.length) return "";
  // Group changes whose context windows touch into hunks.
  const ranges: [number, number][] = [];
  for (const k of changed) {
    const lo = Math.max(0, k - ctx);
    const hi = Math.min(ops.length, k + ctx + 1);
    const last = ranges[ranges.length - 1];
    if (last && lo <= last[1]) last[1] = Math.max(last[1], hi);
    else ranges.push([lo, hi]);
  }

  const out = [`--- ${o.from}`, `+++ ${o.to}`];
  for (const [lo, hi] of ranges) {
    let aStart = 1;
    let bStart = 1;
    for (const op of ops.slice(0, lo)) {
      if (op.t !== "+") aStart++;
      if (op.t !== "-") bStart++;
    }
    const slice = ops.slice(lo, hi);
    const aLen = slice.filter((op) => op.t !== "+").length;
    const bLen = slice.filter((op) => op.t !== "-").length;
    out.push(`@@ -${aLen === 0 ? aStart - 1 : aStart},${aLen} +${bLen === 0 ? bStart - 1 : bStart},${bLen} @@`);
    for (const op of slice) out.push(op.t + op.s);
  }
  return out.join("\n") + "\n";
}
