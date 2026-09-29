// Universal Web & iOS PWA Haptic Engine
//
// Provides tactile feedback across platforms:
// 1. Modern Vibration API (navigator.vibrate) — Android, desktop Chrome, Edge, etc.
// 2. iOS 17.4+ WebKit PWA / Safari — leverages the native switch control Taptic Engine tick.
// 3. Tactile micro-pulse — low-frequency sub-bass acoustic transducer pulse on mobile speakers.
// 4. Safe fallback: zero-overhead no-op on unsupported browsers, never throws.

let iosSwitchInput = null;
let audioCtx = null;

function getIosSwitch() {
  if (typeof document === 'undefined') return null;
  if (!iosSwitchInput) {
    try {
      const container = document.createElement('div');
      container.style.cssText = 'position:fixed;top:-9999px;left:-9999px;opacity:0;pointer-events:none;width:0;height:0;overflow:hidden;';
      container.setAttribute('aria-hidden', 'true');
      const label = document.createElement('label');
      const sw = document.createElement('input');
      sw.type = 'checkbox';
      sw.setAttribute('switch', '');
      label.appendChild(sw);
      container.appendChild(label);
      document.body.appendChild(container);
      iosSwitchInput = sw;
    } catch (_) {
      iosSwitchInput = null;
    }
  }
  return iosSwitchInput;
}

function triggerIosSwitchTick() {
  try {
    const sw = getIosSwitch();
    if (sw) {
      sw.checked = !sw.checked;
      sw.dispatchEvent(new Event('change', { bubbles: true }));
    }
  } catch (_) {}
}

function triggerAcousticPulse(freq = 55, duration = 0.02) {
  try {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) return;
    if (!audioCtx) {
      audioCtx = new AudioContext();
    }
    if (audioCtx.state === 'suspended') {
      audioCtx.resume().catch(() => {});
    }
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq, audioCtx.currentTime);
    gain.gain.setValueAtTime(0.08, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + duration);
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.start();
    osc.stop(audioCtx.currentTime + duration);
  } catch (_) {}
}

const PATTERNS = {
  light: [12],
  medium: [24],
  heavy: [38],
  success: [15, 60, 22],
  warning: [25, 50, 25],
  error: [35, 45, 35, 45, 45],
};

/**
 * Triggers haptic feedback.
 * @param {'light'|'medium'|'heavy'|'success'|'warning'|'error'} type
 */
export function haptic(type = 'light') {
  if (typeof window === 'undefined') return;

  // 1. Vibration API (standard on Android / supported browsers)
  if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
    try {
      const pattern = PATTERNS[type] || PATTERNS.light;
      navigator.vibrate(pattern);
    } catch (_) {}
  }

  // 2. iOS Taptic Engine tick via Switch element
  triggerIosSwitchTick();

  // Multi-pulse cadence for iOS switch
  if (type === 'success') {
    setTimeout(triggerIosSwitchTick, 75);
  } else if (type === 'error') {
    setTimeout(triggerIosSwitchTick, 80);
    setTimeout(triggerIosSwitchTick, 160);
  }
}
