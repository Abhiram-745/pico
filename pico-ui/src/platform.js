/* Which desktop this window is on, for copy that should not say "Windows"
   anywhere else. Browser-side only; the bridge decides what it can really do. */
const ua = typeof navigator === 'undefined' ? '' : `${navigator.userAgent} ${navigator.platform || ''}`;
export const isWindows = /Win/i.test(ua) && !/Darwin|Mac/i.test(ua);
export const isMac = /Mac/i.test(ua);
/** Name of the modifier key the keyboard drawing shows beside Ctrl. */
export const superKey = isMac ? 'Cmd' : 'Super';
