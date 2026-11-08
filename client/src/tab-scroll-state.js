/**
 * The shell's shared scrollport owns tab-specific layout classes. Keeping this
 * explicit avoids making a parent layout depend on dynamic :has() matching of
 * a child panel's inline display state, which can lag in standalone WebKit.
 */
export function syncTabScrollState(scroller, tabId) {
  if (!scroller) return;
  scroller.classList.toggle('app-home-active', tabId === 'home');
  scroller.classList.toggle('app-timetable-active', tabId === 'class-timetable');
  scroller.classList.toggle('app-settings-active', tabId === 'settings' || tabId === 'about');
  if (tabId !== 'settings' && tabId !== 'about') {
    const content = scroller.querySelector('.app-settings-content');
    if (content) { content.style.transform = ''; content.style.transition = ''; }
  }
}
