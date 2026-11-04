// Per-gym DISPLAY rewrites for provider text, driven only by gyms.config.js data:
//   classNameRules:   [{ match: '<regex, case-insensitive>', discipline, name }]
//                     first match wins; `$1`.. in `name`/`discipline` insert capture groups.
//   instructorAliases: { '<folded lower-case raw name>': 'Shown name' }
// Platform- and gym-agnostic: no gym id or literal name lives here.

function foldName(s) {
  return String(s == null ? '' : s).normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().trim().replace(/\s+/g, ' ');
}

function gymConfig(gymId) {
  if (!gymId) return null;
  try { return require('../gyms.config').getGymConfig(gymId); } catch { return null; }
}

function fill(tpl, m) {
  return String(tpl).replace(/\$(\d)/g, (_, n) => (m[Number(n)] == null ? '' : m[Number(n)])).trim();
}

/** @returns {{name:string, discipline:string}} rewritten (or unchanged) class name/discipline. */
function applyClassNameRules(gymId, name, discipline, cfg = gymConfig(gymId)) {
  const rules = cfg && cfg.classNameRules;
  if (!Array.isArray(rules)) return { name, discipline };
  const raw = String(name || '').trim();
  const rawDisc = String(discipline || '').trim();
  for (const r of rules) {
    const re = new RegExp(r.match, 'i');
    const m = re.exec(raw) || re.exec(rawDisc);
    if (!m) continue;
    return {
      name: r.name != null ? (fill(r.name, m) || name) : name,
      discipline: r.discipline != null ? (fill(r.discipline, m) || discipline) : discipline,
    };
  }
  return { name, discipline };
}

function applyInstructorAlias(gymId, name, cfg = gymConfig(gymId)) {
  const map = cfg && cfg.instructorAliases;
  if (!map || !name) return name;
  return map[foldName(name)] || name;
}

module.exports = { foldName, applyClassNameRules, applyInstructorAlias };
