// Single-instance deployment: one validated MCP execution per account across
// clients/grants/gyms. Incomplete uploads and idle GET/SSE are not executions.
const active = new Set();
function acquire(userId, res) {
  if (active.has(userId)) throw Object.assign(new Error('MCP request already in progress'), { code: 'RATE_LIMITED', retryAfter: 1 });
  active.add(userId);
  const release = () => {
    active.delete(userId);
    res.removeListener('finish', release);
    res.removeListener('close', release);
  };
  res.once('finish', release);
  res.once('close', release);
}
module.exports = { acquire };
