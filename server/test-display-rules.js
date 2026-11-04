// Per-gym display rules: class-name rules (Homerun "Base (X)") and instructor aliases (JAB).
const assert = require('assert');
const { applyClassNameRules, applyInstructorAlias } = require('./providers/display-rules');
const { makeEvent } = require('./providers/normalize');

let r = applyClassNameRules('homerun-london', 'Base (Upper Body)', 'Base (Upper Body)');
assert.deepStrictEqual(r, { name: 'Upper Body', discipline: 'Base' });
r = applyClassNameRules('homerun-london', 'Base (Lower Body)', 'Base (Lower Body)');
assert.strictEqual(r.name, 'Lower Body');
for (const n of ['Speed', 'Endurance', 'Speed (Fast)', 'Base']) {
  assert.deepStrictEqual(applyClassNameRules('homerun-london', n, n), { name: n, discipline: n }, n);
}
assert.deepStrictEqual(applyClassNameRules('psycle-london', 'Base (X)', 'Base (X)'), { name: 'Base (X)', discipline: 'Base (X)' });
assert.deepStrictEqual(applyClassNameRules(undefined, 'a', 'b'), { name: 'a', discipline: 'b' });

for (const n of ['Luis Javier Pareja Munoz', 'Luis Javier Pareja Muñoz', ' luis  javier pareja MUÑOZ ']) {
  assert.strictEqual(applyInstructorAlias('jab-boxing', n), 'Luis Javier', n);
}
assert.strictEqual(applyInstructorAlias('jab-boxing', 'Someone Else'), 'Someone Else');
assert.strictEqual(applyInstructorAlias('psycle-london', 'Luis Javier Pareja Munoz'), 'Luis Javier Pareja Munoz');

const ev = makeEvent({ id: 1, gymId: 'homerun-london', name: 'Base (Upper Body)', discipline: 'Base (Upper Body)', instructors: [] });
assert.strictEqual(ev.name, 'Upper Body'); assert.strictEqual(ev.discipline, 'Base');
const ev2 = makeEvent({ id: 2, gymId: 'jab-boxing', name: 'x', discipline: 'y', instructors: [{ id: 1, name: 'Luis Javier Pareja Muñoz' }] });
assert.strictEqual(ev2.instructors[0].name, 'Luis Javier');
console.log('display-rules: ok');
