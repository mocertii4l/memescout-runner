// Typed question builders. A Noul becomes an if, a Choice a switch, a Score a sort key.
// Rules enforced here: every Choice has an "other" option; Choice needs ≥2 real options; Score ≤10 levels.

export const noul = (id, text) => ({ id, type: 'noul', text });

export function choice(id, text, options) {
  const opts = options.includes('other') ? options : [...options, 'other'];
  return { id, type: 'choice', text, options: opts };
}

export function score(id, text, rubric) {
  return { id, type: 'score', text, rubric };
}

export function validateBattery(battery) {
  const ids = new Set();
  if (!Array.isArray(battery.questions) || !battery.questions.length) throw new Error(`${battery.name}: empty battery`);
  for (const q of battery.questions) {
    if (ids.has(q.id)) throw new Error(`${battery.name}: duplicate question id ${q.id}`);
    ids.add(q.id);
    if (!q.text || q.text.length > 300) throw new Error(`${q.id}: question text missing or too long`);
    if (/\band\b.*\band\b/i.test(q.text)) throw new Error(`${q.id}: looks like more than one judgment — split it`);
    if (q.type === 'choice') {
      if (!q.options.includes('other')) throw new Error(`${q.id}: choice needs an "other" option`);
      if (q.options.length < 3) throw new Error(`${q.id}: choice over a single real option proves nothing`);
      if (q.options.length > 255) throw new Error(`${q.id}: too many options`);
    } else if (q.type === 'score') {
      if (q.rubric.length < 2 || q.rubric.length > 10) throw new Error(`${q.id}: rubric must have 2–10 levels`);
    } else if (q.type !== 'noul') throw new Error(`${q.id}: unknown type ${q.type}`);
  }
  for (const pair of battery.pairs ?? []) {
    // A Choice is relative; a Noul is absolute. Every "which one" ships beside a "worth it at all".
    if (!ids.has(pair.choice) || !ids.has(pair.gate)) throw new Error(`${battery.name}: choice/gate pair references unknown id`);
  }
  return battery;
}
