import { escapeHtml } from '../escape-html.js';
import { teamAvatar } from './teams-ui.js';

/** Shared small speech bubble used by Team creation and the welcome tour. */
export function bubbleHtml(text) {
  return `<p class="tm-cf-bubble">${escapeHtml(text)}</p>`;
}

/** A page title is independent of the guide's conversational line. */
export function setupGuideHtml({ title, message = "Let's get you set up.", id = '' }) {
  return `<h2 class="app-onb-title" tabindex="-1"${id ? ` id="${escapeHtml(id)}"` : ''}>${escapeHtml(title)}</h2><div class="app-onb-guide">${teamAvatar({ size: 'lg', pose: 'referee' })}${bubbleHtml(message)}</div>`;
}
