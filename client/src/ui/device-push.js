// T12: is Web Push set up on THIS device? Mirrors the app's own state (main.js
// updatePushUI): permission granted AND an active push subscription on the service worker.
// Never throws and never hangs (a missing service worker is "not ready", not an error).

export async function devicePushReady() {
  try {
    if (typeof Notification === 'undefined' || !('serviceWorker' in navigator)) return false;
    if (Notification.permission !== 'granted') return false;
    const reg = await Promise.race([
      navigator.serviceWorker.getRegistration(),
      new Promise((resolve) => setTimeout(() => resolve(null), 1500)),
    ]);
    if (!reg || !reg.pushManager) return false;
    return !!(await reg.pushManager.getSubscription());
  } catch (_) {
    return false;
  }
}
