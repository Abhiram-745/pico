/** Extract a requested choice only when it is explicitly attached to a named control. */
/* The label as a person would write it in a task. Windows names a control
   from its whole <label>, and on a real page that is often more than the
   words in front of it: "Dropdown (select) Open this select menu" is the
   label AND the option the select is showing. Each of these is tried. */
function labelVariants(name, value) {
  const out = new Set([name]);
  const v = String(value ?? '').trim();
  const bare = v && name.toLowerCase().endsWith(v.toLowerCase()) ? name.slice(0, name.length - v.length).trim() : name;
  out.add(bare);
  for (const n of [name, bare]) {
    out.add(n.replace(/\s*\([^)]*\)\s*/g, ' ').replace(/\s+/g, ' ').trim());   // "Dropdown (select)" -> "Dropdown"
    out.add(n.replace(/[()]/g, '').replace(/\s+/g, ' ').trim());                 // -> "Dropdown select"
  }
  return [...out].filter((n) => n.length >= 2).sort((a, b) => b.length - a.length);
}

const cut = (raw) => {
  const option = String(raw || '').split(/\s+(?:and|then|before|after|while|in|from|on|for)\b|[.,;'"()]/i)[0].trim();
  return option && option.split(/\s+/).length <= 4 ? option : null;
};

export function requestedOption(goal, controlName, currentValue = '') {
  const text = String(goal || '');
  const name = String(controlName || '').trim();
  if (!name || name.length > 120) return null;
  const own = /\(([^)]*)\)/.exec(name)?.[1]?.trim().toLowerCase() ?? null;
  for (const label of labelVariants(name, currentValue)) {
    const at = text.toLowerCase().indexOf(label.toLowerCase());
    if (at < 0) continue;
    /* A label found with its brackets taken off must not be a different
       control's label with ITS brackets: "the Dropdown (select)" is not
       "Dropdown (datalist)", measured on a page that has both. */
    const next = /^\s*\(([^)]*)\)/.exec(text.slice(at + label.length));
    if (next && !label.includes('(') && next[1].trim().toLowerCase() !== own) continue;
    // After it: "set Priority to High", "Priority dropdown shows 'High'".
    const tail = text.slice(at + label.length, at + label.length + 90);
    const after = tail.match(/^\s*(?:dropdown|select|menu|list|field|box|slider)?\s*(?:is\s+set\s+to|set\s+to|to|as|shows|equals|is|=|:)\s+['"“]?([a-z0-9][a-z0-9 .-]{0,40})/i);
    if (after) { const o = cut(after[1]); if (o) return o; }
    // Before it: "choose Two in the Dropdown (select)", "pick High from Priority".
    const head = text.slice(Math.max(0, at - 70), at);
    const before = head.match(/\b(?:choose|select|pick|set|use)\s+(?:the\s+)?(?:option\s+)?['"“]?([a-z0-9][a-z0-9 .-]{0,40}?)['"”]?\s+(?:in|from|for|on|as)\s+(?:the\s+)?$/i);
    if (before) { const o = cut(before[1]); if (o) return o; }
  }
  return null;
}

export async function upgradeDropdownClick(action, { goal, shot, sense, windowHwnd = null }) {
  if (action.type !== 'click' || !/dropdown|combo\s*box|select\b/i.test(`${action.target || ''} ${action.why || ''}`)
    || !Number.isFinite(action.x) || !Number.isFinite(action.y) || !sense) return action;
  const point = shot.toPhysical(action.x, action.y);
  const hit = await sense.hit(point.x, point.y).catch(() => null);
  let control = hit?.at?.type === 'ComboBox' ? hit.at : null;
  // A model point may be off, while the named control is still exact in UIA.
  // Accept one matching ComboBox from the current window and use its real
  // rectangle; ambiguous or missing controls go back to visual reasoning.
  if (!control && windowHwnd) {
    const seen = await sense.look(windowHwnd, 120).catch(() => null);
    const named = seen?.elements?.filter(el => el.type === 'ComboBox' && el.name?.length >= 3
      && String(action.target || '').toLowerCase().includes(el.name.toLowerCase())
      && requestedOption(goal, el.name)) ?? [];
    if (named.length === 1) control = named[0];
  }
  const option = control ? requestedOption(goal, control.name) : null;
  if (!option) return action;
  const rect = control.rect;
  if (!Array.isArray(rect)) return action;
  return {
    ...action,
    type: 'select_option', text: option, target: `${control.name} dropdown`,
    why: `Set ${control.name} to ${option}`,
    expect: `${control.name} shows ${option}`,
    ...(shot.fromPhysical
      ? shot.fromPhysical(rect[0] + rect[2] / 2, rect[1] + rect[3] / 2)
      : { x: Math.round(((rect[0] + rect[2] / 2) * shot.width) / shot.physical.width), y: Math.round(((rect[1] + rect[3] / 2) * shot.height) / shot.physical.height) }),
    observedTarget: control,
  };
}
