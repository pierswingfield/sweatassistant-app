// One gate for every client-side state change. Offline writes are deliberately
// not queued: a replayed booking, cancellation, payment, unlink or calendar
// token rotation can have materially different consequences after reconnect.
const MUTATION_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function isMutationMethod(method = 'GET') {
  return MUTATION_METHODS.has(String(method).toUpperCase());
}

export function isOfflineForMutation() {
  const markedOffline = typeof document !== 'undefined'
    && document.documentElement?.classList.contains('sa-offline');
  const browserOffline = typeof navigator !== 'undefined' && navigator.onLine === false;
  return markedOffline || browserOffline;
}

export function assertMutationNetworkAvailable(method, message) {
  if (!isMutationMethod(method) || !isOfflineForMutation()) return;
  const error = new Error(message);
  error.code = 'OFFLINE_MUTATION_BLOCKED';
  throw error;
}
