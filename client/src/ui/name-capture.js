// Account-name helpers shared by the post-link onboarding step and Home W1.
// Gym profile names are suggestions only; the saved account setting is the
// single source of truth once a member has confirmed or edited it.

export function cleanFirstName(value) {
  return String(value || '').trim().split(/\s+/)[0] || '';
}

/** Return one unambiguous first-name suggestion, otherwise an empty string. */
export function inferFirstName(linkedGyms) {
  const byCanonical = new Map();
  for (const gym of linkedGyms || []) {
    const name = cleanFirstName(gym?.display_name || gym?.displayName);
    if (name && !byCanonical.has(name.toLocaleLowerCase())) byCanonical.set(name.toLocaleLowerCase(), name);
  }
  return byCanonical.size === 1 ? [...byCanonical.values()][0] : '';
}

export function welcomeText(firstName) {
  const name = cleanFirstName(firstName);
  return name ? `Welcome, ${name}!` : 'Welcome!';
}
