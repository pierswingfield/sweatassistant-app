const MAX_QUANTITY_OPTIONS = 4;

export function maxAttendeesPerClass({ providerLimit, gymLimit, fallback = MAX_QUANTITY_OPTIONS } = {}) {
  const configured = [providerLimit, gymLimit]
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value) && value > 0);
  return Math.max(1, Math.floor(Math.min(...configured, fallback)));
}

export function bookingQuantityOptions(limit = MAX_QUANTITY_OPTIONS) {
  const count = Math.max(1, Math.min(MAX_QUANTITY_OPTIONS, Math.floor(Number(limit) || 1)));
  return Array.from({ length: count }, (_, index) => index + 1);
}
