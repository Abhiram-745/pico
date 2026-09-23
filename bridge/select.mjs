/** Extract a requested choice only when it is explicitly attached to a named control. */
export function requestedOption(goal, controlName) {
  const text = String(goal || '');
  const name = String(controlName || '').trim();
  if (!name || name.length > 80) return null;
  const at = text.toLowerCase().indexOf(name.toLowerCase());
  if (at < 0) return null;
  const tail = text.slice(at + name.length, at + name.length + 90);
  const match = tail.match(/\b(?:is\s+set\s+to|set\s+to|to|as|shows|equals|is)\s+['"]?([a-z0-9][a-z0-9 -]{0,40})/i);
  if (!match) return null;
  const option = match[1].split(/\s+(?:and|then|before|after|while)\b|[.,;'"()]/i)[0].trim();
  return option && option.split(/\s+/).length <= 4 ? option : null;
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
    x: Math.round(((rect[0] + rect[2] / 2) * shot.width) / shot.physical.width),
    y: Math.round(((rect[1] + rect[3] / 2) * shot.height) / shot.physical.height),
    observedTarget: control,
  };
}
