import { escapeHtml } from '../escape-html.js';
import { mascotHtml } from './teams-ui.js';

/** Shared speech bubble used by Team creation and the welcome tour. */
export function bubbleHtml(text) {
  return `<p class="tm-cf-bubble">${escapeHtml(text)}</p>`;
}

export function setupGuideHtml({ title, eyebrow = '', id = '' }) {
  return `<div class="app-onb-guide">${mascotHtml({ size: 96, pose: 'referee' })}<div class="app-onb-guide-copy">${eyebrow ? `<div class="app-onb-eyebrow">${escapeHtml(eyebrow)}</div>` : ''}<h2 class="app-onb-title tm-cf-bubble"${id ? ` id="${escapeHtml(id)}"` : ''}>${escapeHtml(title)}</h2></div></div>`;
}
