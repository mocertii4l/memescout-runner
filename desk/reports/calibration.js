// Calibration report: predicted probability vs what actually happened, per bucket, per question.
// If decisions tagged 0.8 don't come true ~80% of the time on YOUR venue, the number isn't ready to drive size.
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { readStream, LOG_DIR } from './read.js';

export function brier(rows) { return rows.length ? rows.reduce((s, r) => s + (r.p - r.y) ** 2, 0) / rows.length : null; }

export function buckets(rows, n = 10) {
  const out = Array.from({ length: n }, (_, i) => ({ lo: i / n, hi: (i + 1) / n, count: 0, sumP: 0, sumY: 0 }));
  for (const r of rows) { const b = out[Math.min(n - 1, Math.floor(r.p * n))]; b.count++; b.sumP += r.p; b.sumY += r.y; }
  return out.map((b) => ({ lo: b.lo, hi: b.hi, count: b.count, mean_p: b.count ? b.sumP / b.count : null, hit_rate: b.count ? b.sumY / b.count : null }));
}

/** Expected calibration error: count-weighted |mean_p − hit_rate|. */
export function ece(bs) { const n = bs.reduce((s, b) => s + b.count, 0); return n ? bs.reduce((s, b) => s + (b.count ? (b.count / n) * Math.abs(b.mean_p - b.hit_rate) : 0), 0) : null; }

/** Platt scaling: fit p' = σ(a·logit(p) + b) by gradient descent. Apply in the policy layer, never in the model. */
export function fitPlatt(rows, { iters = 2000, lr = 0.05 } = {}) {
  let a = 1, b = 0;
  const logit = (p) => Math.log(Math.max(1e-6, p) / Math.max(1e-6, 1 - p));
  for (let k = 0; k < iters; k++) {
    let ga = 0, gb = 0;
    for (const r of rows) { const x = logit(r.p); const q = 1 / (1 + Math.exp(-(a * x + b))); ga += (q - r.y) * x; gb += q - r.y; }
    a -= (lr * ga) / rows.length; b -= (lr * gb) / rows.length;
  }
  return { a, b };
}

export function reliabilitySvg(bs, title) {
  const W = 360, H = 360, P = 40, S = W - 2 * P;
  const x = (v) => P + v * S, y = (v) => H - P - v * S;
  const pts = bs.filter((b) => b.count);
  const maxC = Math.max(1, ...pts.map((b) => b.count));
  const bars = bs.map((b) => `<rect x="${x(b.lo) + 1}" y="${H - P - (b.count / maxC) * 40}" width="${S / bs.length - 2}" height="${(b.count / maxC) * 40}" fill="#9ca3af" opacity="0.35"/>`).join('');
  const line = pts.map((b) => `${x(b.mean_p).toFixed(1)},${y(b.hit_rate).toFixed(1)}`).join(' ');
  const dots = pts.map((b) => `<circle cx="${x(b.mean_p).toFixed(1)}" cy="${y(b.hit_rate).toFixed(1)}" r="4" fill="#2563eb"><title>p≈${b.mean_p.toFixed(2)} hit=${b.hit_rate.toFixed(2)} n=${b.count}</title></circle>`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" font-family="system-ui,sans-serif" font-size="11">
<rect width="100%" height="100%" fill="#fff"/><text x="${P}" y="20" font-size="13" font-weight="600">${escape(title)}</text>
<line x1="${x(0)}" y1="${y(0)}" x2="${x(1)}" y2="${y(1)}" stroke="#d1d5db" stroke-dasharray="4 4"/>
<line x1="${x(0)}" y1="${y(0)}" x2="${x(1)}" y2="${y(0)}" stroke="#6b7280"/><line x1="${x(0)}" y1="${y(0)}" x2="${x(0)}" y2="${y(1)}" stroke="#6b7280"/>
<text x="${W / 2}" y="${H - 8}" text-anchor="middle">predicted probability</text><text x="12" y="${H / 2}" transform="rotate(-90 12 ${H / 2})" text-anchor="middle">observed frequency</text>
${bars}<polyline points="${line}" fill="none" stroke="#2563eb" stroke-width="2"/>${dots}</svg>`;
}
const escape = (s) => String(s).replace(/[<&>]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[c]);

export function calibrationReport(rows, { minRows = 30 } = {}) {
  const byQ = {};
  for (const r of rows) (byQ[`${r.bot}:${r.question}`] ??= []).push(r);
  return Object.entries(byQ).sort().map(([q, rs]) => {
    const bs = buckets(rs);
    return { question: q, n: rs.length, brier: brier(rs), base_rate: rs.reduce((s, r) => s + r.y, 0) / rs.length, ece: ece(bs), platt: rs.length >= minRows ? fitPlatt(rs) : null, buckets: bs };
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const rows = readStream('outcomes').filter((r) => Number.isFinite(r.p));
  const report = calibrationReport(rows);
  const outDir = join(LOG_DIR, 'reports');
  mkdirSync(outDir, { recursive: true });
  const svgs = [];
  for (const q of report) {
    const file = `reliability-${q.question.replace(/[^a-z0-9]+/gi, '_')}.svg`;
    writeFileSync(join(outDir, file), reliabilitySvg(q.buckets, `${q.question} (n=${q.n}, Brier ${q.brier.toFixed(3)})`));
    svgs.push(file);
  }
  const html = `<!doctype html><meta charset="utf-8"><title>Calibration</title><body style="font-family:system-ui;margin:24px">
<h1>Calibration report</h1><p>${rows.length} labelled answers. Brier: lower is better (0.25 = coin flip at a 50% base rate). ECE: average gap between stated and observed probability.</p>
<table border="1" cellpadding="4" style="border-collapse:collapse"><tr><th>question</th><th>n</th><th>base rate</th><th>Brier</th><th>ECE</th><th>Platt a,b</th></tr>
${report.map((q) => `<tr><td>${q.question}</td><td>${q.n}</td><td>${q.base_rate.toFixed(2)}</td><td>${q.brier.toFixed(3)}</td><td>${q.ece.toFixed(3)}</td><td>${q.platt ? q.platt.a.toFixed(2) + ', ' + q.platt.b.toFixed(2) : 'n<30'}</td></tr>`).join('')}
</table><div style="display:flex;flex-wrap:wrap;gap:12px;margin-top:16px">${svgs.map((f) => `<img src="${f}">`).join('')}</div></body>`;
  writeFileSync(join(outDir, 'calibration.html'), html);
  console.table(report.map(({ question, n, base_rate, brier: b, ece: e }) => ({ question, n, base_rate: +base_rate.toFixed(2), brier: +b.toFixed(3), ece: +e.toFixed(3) })));
  console.log(`wrote ${join(outDir, 'calibration.html')}`);
}
