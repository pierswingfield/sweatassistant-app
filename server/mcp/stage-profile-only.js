'use strict';

function enabled() { return process.env.MCP_STAGE_JAB_PROFILE_ONLY === 'true'; }
function permitsProvider(gym) { return !enabled() || gym?.provider === 'marianatek'; }
function backgroundServicesEnabled() { return !enabled(); }
function linkSideEffectsEnabled() { return !enabled(); }

module.exports = { enabled, permitsProvider, backgroundServicesEnabled, linkSideEffectsEnabled };
