import assert from 'node:assert/strict';

// Browser globals used only by voice playback; this test exercises session
// ownership and emergency cancellation without opening an audio device.
globalThis.BroadcastChannel = undefined;
globalThis.CustomEvent = class { constructor(type, options) { this.type = type; this.detail = options?.detail; } };
globalThis.window = { dispatchEvent() {} };

const { store } = await import('../pico-ui/src/store.js');
const { bridge } = await import('../pico-ui/src/bridge.js');
const { claimVoice, updateVoice, stopEverything, releaseVoice, onVoiceSession, isSpokenStop, voiceOwner } = await import('../pico-ui/src/voice-session.js');

const sent = [];
bridge.onSend((command, payload) => sent.push({ command, payload }));
store.setPhase('Acting');
for (const phase of ['requesting', 'recording', 'transcribing', 'thinking', 'speaking', 'error']) {
  claimVoice();
  updateVoice({ phase, message: phase });
  assert.equal(store.state.voice.owner, voiceOwner);
  stopEverything();
  assert.equal(store.state.voice.active, false, `Stop must end voice in ${phase}`);
  assert.equal(sent.at(-2)?.command, 'stop', `Stop must cancel the task in ${phase}`);
  assert.equal(sent.at(-1)?.command, 'voiceSession');
  assert.equal(sent.at(-1)?.payload.action, 'end');
}
/* Hold-to-talk puts the microphone down without stopping anything: no task
   stop, no 'stop' notice that would silence the reply about to be spoken. */
store.setPhase('Idle');
let stopNotices = 0;
const offStop = onVoiceSession(event => { if (event.type === 'stop') stopNotices += 1; });
claimVoice();
updateVoice({ phase: 'transcribing' });
const before = sent.length;
releaseVoice();
assert.equal(store.state.voice.active, false, 'release ends the session');
assert.deepEqual(sent.slice(before).map(x => x.command), ['voiceSession'], 'and sends only the end of the session');
assert.equal(stopNotices, 0, 'without telling anything to stop');
offStop();
let lostOwnership = false;
onVoiceSession(event => { if (event.type === 'claim') lostOwnership = true; });
claimVoice();
const previousVoice = store.state.voice;
store.set({ voice: { ...previousVoice, owner: 'another_window' } }, { type: 'voice', remote: true, previousVoice });
assert.equal(lostOwnership, true, 'A new window must interrupt the old microphone owner');
assert.equal(isSpokenStop('stop Halo'), true);
assert.equal(isSpokenStop('stop the music'), false);
console.log('Cross-window ownership and Stop during every voice state passed.');
