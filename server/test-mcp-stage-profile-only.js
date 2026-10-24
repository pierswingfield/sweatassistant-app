'use strict';
const assert = require('node:assert/strict');
const profileOnly = require('./mcp/stage-profile-only');
const previous = process.env.MCP_STAGE_JAB_PROFILE_ONLY;
try {
  delete process.env.MCP_STAGE_JAB_PROFILE_ONLY;
  assert.equal(profileOnly.enabled(), false);
  assert.equal(profileOnly.permitsProvider({ provider: 'codexfit' }), true);
  assert.equal(profileOnly.backgroundServicesEnabled(), true);
  assert.equal(profileOnly.linkSideEffectsEnabled(), true);

  process.env.MCP_STAGE_JAB_PROFILE_ONLY = 'true';
  assert.equal(profileOnly.enabled(), true);
  assert.equal(profileOnly.permitsProvider({ provider: 'marianatek' }), true);
  assert.equal(profileOnly.permitsProvider({ provider: 'codexfit' }), false);
  assert.equal(profileOnly.backgroundServicesEnabled(), false);
  assert.equal(profileOnly.linkSideEffectsEnabled(), false);
  process.stdout.write('stage profile-only gates preserve normal mode and suppress provider background/link side effects\n');
} finally {
  if (previous === undefined) delete process.env.MCP_STAGE_JAB_PROFILE_ONLY;
  else process.env.MCP_STAGE_JAB_PROFILE_ONLY = previous;
}
