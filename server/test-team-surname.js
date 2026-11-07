// Owner decision 2026-11-06: teammates may see a member's surname INITIAL (one letter),
// never the surname. Drives the real Teams functions and checks the serialized responses.
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);
process.env.DB_PATH = ':memory:';
const assert = require('assert');
const crypto = require('crypto');
const db = require('./db');
const teams = require('./teams');
const sharing = require('./team-sharing');

const PSY = 'psycle-london';
function mkUser(first, last) {
  const email = `sn-${first.toLowerCase()}-${crypto.randomBytes(4).toString('hex')}@surname.test`;
  const id = db.db.prepare("INSERT INTO users (email, encrypted_password, priority) VALUES (?, '', 200)").run(email).lastInsertRowid;
  db.setUserSettings(id, last === undefined ? { firstName: first } : { firstName: first, lastName: last });
  db.upsertUserGym(id, PSY, { gym_email: `gym-${first.toLowerCase()}@x.test` });
  return id;
}
const CAP = mkUser('Cora', 'Quillfeather');
const ANA = mkUser('Ana', 'Smithwick');
const ELI = mkUser('Éli', 'ébertson');
const NOS = mkUser('Nosur', '');
const PEN = mkUser('Pendy', 'Hollowbrook');
const { team, inviteToken } = teams.createTeam(CAP, { name: 'Surname Crew', share: sharing.defaultShare() });
for (const u of [ANA, ELI, NOS]) {
  const r = teams.requestJoin(u, inviteToken, sharing.defaultShare());
  teams.decideRequest(CAP, team.id, r.requestId, 'approve');
}
teams.requestJoin(PEN, inviteToken, sharing.defaultShare());

const SURNAMES = ['Quillfeather', 'Smithwick', 'ébertson', 'Ébertson', 'Hollowbrook'];
const responses = {
  getTeam: teams.getTeam(CAP, team.id),
  listRequests: teams.listRequests(CAP, team.id),
  listTeams: teams.listTeams(CAP),
};
try { responses.today = teams.getTeamToday(CAP, team.id); } catch (_) { /* optional */ }
try { responses.chips = teams.timetableChips(CAP); } catch (_) { /* optional */ }

const json = JSON.stringify(responses);
for (const s of SURNAMES) assert.ok(!json.includes(s), `surname ${s} leaked`);

const byFirst = Object.fromEntries(responses.getTeam.members.map((m) => [m.name.split(' ')[0], m]));
assert.strictEqual(byFirst.Ana.lastInitial, 'S');
assert.strictEqual(byFirst['Éli'].lastInitial, 'É');
assert.strictEqual(byFirst.Nosur.lastInitial, null);
assert.strictEqual(byFirst.Cora.lastInitial, 'Q');
assert.ok(responses.getTeam.members.every((m) => m.lastInitial === null || /^\p{L}$/u.test(m.lastInitial)));
assert.strictEqual(responses.listRequests[0].lastInitial, 'H');
const card = (responses.listTeams.teams || responses.listTeams)[0];
assert.ok(card.members.some((m) => m.lastInitial === 'S'), 'list card members carry lastInitial');

// initialOf: skip leading non-letters; no letter -> '' (null lastInitial).
const io = teams.__initialOf;
assert.strictEqual(io('-Smith'), 'S');
assert.strictEqual(io("'ébertson"), 'É');
assert.strictEqual(io('1abc'), 'A');
assert.strictEqual(io('123'), '');
assert.strictEqual(io('-'), '');
assert.strictEqual(io('\u{1F600}'), '');
assert.strictEqual(io('\u{1F600}Zed'), 'Z');
assert.strictEqual(io(''), '');
assert.strictEqual(io('ß'), 'S');
console.log('team surname initial: ok');
