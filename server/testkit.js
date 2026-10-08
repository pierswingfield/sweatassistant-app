// Test fixtures only. NOT a suite: the name has no `test-` prefix, so run-tests.js
// never runs it, and test-no-gym-privilege.js exempts it from the "no gym id in
// application modules" scan.
//
// Production code has no "create an account bootstrapped on a gym" operation any
// more (accounts come from signup, gym-less; gyms are linked explicitly). Suites
// that need an account already linked to a gym use this, naming the gym.

const FIXTURE_GYM_ID = 'psycle-london';

/**
 * An account plus one linked gym, the shape most suites want.
 * @param {object} db            the ./db module
 * @param {string} email
 * @param {string} encryptedPassword  stored as the gym link's credential
 * @param {string} [gymId]       defaults to the fixture gym
 */
function createUser(db, email, encryptedPassword, gymId = FIXTURE_GYM_ID) {
  const result = db.db.prepare('INSERT INTO users (email, encrypted_password, priority) VALUES (?, ?, 200)')
    .run(email, encryptedPassword);
  const userId = result.lastInsertRowid;
  db.upsertUserGym(userId, gymId, { gym_email: email, encrypted_password: encryptedPassword, priority: 200 });
  return userId;
}

module.exports = { FIXTURE_GYM_ID, createUser };
