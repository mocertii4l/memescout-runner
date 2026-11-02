// Bench by reason, not by token. The reason sets how long a rejection stays rejected.
// ttl -1 = forever (a honeypot never stops being a honeypot).
export function createBench(ttlByReason, { now = () => Date.now() } = {}) {
  const benched = new Map(); // id -> { reason, until }
  return {
    bench(id, reason) {
      const ttl = ttlByReason[reason] ?? ttlByReason.default;
      benched.set(id, { reason, until: ttl < 0 ? Infinity : now() + ttl });
    },
    isBenched(id) {
      const b = benched.get(id);
      if (!b) return null;
      if (now() >= b.until) { benched.delete(id); return null; }
      return b.reason;
    },
    size: () => benched.size,
  };
}
