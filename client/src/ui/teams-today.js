// T-2 Teams list card lines (PLAN-teams.md §5.2). Pure: turns the server's per-Team
// `today` summary into text segments; teams.js escapes and renders them. Nothing here
// filters or derives data the server did not send (§2 principle 1): the projection
// already decided what this viewer may see.
//
// A segment is { text, strong?, muted? }. `when(startAt, timeZone)` returns
// { time: '08:30' (with a zone suffix when it differs from the device), day: 'Fri',
// isToday: bool }, injected so this module stays free of clocks and Intl.

const fill = (template, values) => String(template).replace(/\{(\w+)\}/g, (_, k) => (values[k] ?? ''));

/** "John doing 08:30 Train" / "3 doing Fri 07:30 Ride 45". */
function doingText(item, when, copy, { withDay = false } = {}) {
  const w = when(item.startAt, item.timeZone);
  const at = withDay && !w.isToday ? `${w.day} ${w.time}` : w.time;
  const who = item.count > 1 || !item.name ? fill(copy.nDoing, { count: item.count || 1 }) : fill(copy.nameDoing, { name: item.name });
  return `${who} ${at} ${item.className}`;
}

/**
 * The today line: the main state, then one detail, then "+N at other gyms".
 * @returns {{ text: string, strong?: boolean, muted?: boolean }[]}
 */
export function todayLineSegments(today, when, copy) {
  const t = today || {};
  const total = Number(t.total) || 0;
  const done = Number(t.done) || 0;
  const inProgress = Number(t.inProgress) || 0;
  const remaining = Number(t.remaining) || 0;
  const segs = [];
  const hint = () => {
    if (!t.next) return;
    const label = t.next.when === 'tomorrow' ? copy.tomorrow : copy.next;
    segs.push({ text: `${label}: ${doingText(t.next, when, copy, { withDay: t.next.when !== 'tomorrow' })}`, muted: true });
  };
  if (total === 0) {
    segs.push({ text: copy.restDay });
    hint();
  } else if (remaining === 0 && inProgress === 0) {
    segs.push({ text: copy.allDone });
    hint();
  } else {
    segs.push({ text: total === 1 ? copy.classesTodayOne : fill(copy.classesTodayMany, { count: total }), strong: true });
    if (inProgress > 0) segs.push({ text: fill(copy.inClassNow, { count: inProgress }) });
    else if (done > 0) segs.push({ text: fill(copy.nDone, { count: done }) });
    else if (t.solo) segs.push({ text: doingText({ ...t.solo, count: 1 }, when, copy) });
    else if (t.firstAt) segs.push({ text: fill(copy.firstAt, { time: when(t.firstAt.startAt, t.firstAt.timeZone).time }) });
  }
  if (Number(t.otherGyms) > 0) segs.push({ text: fill(copy.otherGyms, { count: t.otherGyms }), muted: true });
  return segs;
}

/** The hottest line, or null: shown only when two or more share a class the viewer can see. */
export function hottestSegments(today, when, copy) {
  const h = today && today.hottest;
  if (!h || !(Number(h.count) >= 2)) return null;
  const w = when(h.startAt, h.timeZone);
  const at = w.isToday ? w.time : `${w.day} ${w.time}`;
  const segs = [{ text: fill(copy.nDoing, { count: h.count }), strong: true }, { text: ` ${at} ${h.className}` }];
  if (h.locationName) segs.push({ text: ` · ${h.locationName}` });
  return segs;
}

/** Plain text of segments joined the way the card renders them (for aria and tests). */
export function segmentsText(segs) {
  if (!segs) return '';
  return segs.reduce((acc, s, i) => {
    if (i === 0) return s.text;
    return s.text.startsWith(' ') ? acc + s.text : `${acc} · ${s.text}`;
  }, '');
}
