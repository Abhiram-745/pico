// A recording belongs to one composer and one chat. Nothing records in the background.
export function createMicrophone({
  mediaDevices = globalThis.navigator?.mediaDevices,
  Recorder = globalThis.MediaRecorder,
  AudioContext = globalThis.AudioContext,
  fetchImpl = globalThis.fetch,
  onState = () => {}, onLevel = () => {}, onTranscript = () => {}, stopPlayback = () => {},
  maxMs = 60_000, silenceMs = 850,
} = {}) {
  let current = null;
  const state = (phase, message = '') => onState({ phase, message });
  const release = (session) => {
    clearTimeout(session.timer);
    clearInterval(session.voiceTimer);
    session.audioContext?.close().catch(() => {});
    session.stream?.getTracks().forEach(track => track.stop());
  };
  const cancel = () => {
    const session = current;
    current = null;
    if (session) {
      session.abort.abort();
      if (session.recorder?.state === 'recording') session.recorder.stop();
      release(session);
    }
    state('idle');
  };
  const finish = () => {
    if (current?.recorder?.state === 'recording') {
      state('transcribing', 'Transcribing…');
      clearTimeout(current.timer);
      current.recorder.stop();
    }
  };
  const start = async () => {
    cancel();
    if (!mediaDevices?.getUserMedia || !Recorder) {
      state('error', 'Microphone recording requires the local Halo app in Chrome or Edge.');
      return;
    }
    stopPlayback();
    const session = { abort: new AbortController(), chunks: [] };
    current = session;
    state('requesting', 'Allow microphone access when your browser asks.');
    try {
      session.stream = await mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
      if (current !== session) { release(session); return; }
      const mimeType = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4'].find(type => Recorder.isTypeSupported(type));
      session.recorder = new Recorder(session.stream, mimeType ? { mimeType } : undefined);
      session.recorder.ondataavailable = event => { if (event.data.size) session.chunks.push(event.data); };
      session.recorder.onerror = () => {
        if (current !== session) return;
        cancel(); state('error', 'The microphone stopped working. Check the selected input device.');
      };
      session.recorder.onstop = async () => {
        release(session);
        if (current !== session) return;
        state('transcribing', 'Transcribing…');
        try {
          const type = session.recorder.mimeType || mimeType || 'audio/webm';
          const audio = new Blob(session.chunks, { type });
          if (!audio.size) throw new Error('No audio was recorded. Please try again.');
          const timeout = setTimeout(() => session.abort.abort(), 50_000);
          let result;
          try {
            const response = await fetchImpl('/voice/transcribe', {
              method: 'POST', headers: { 'Content-Type': type }, body: audio, signal: session.abort.signal,
            });
            result = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(result.error || 'Transcription is unavailable. Restart Halo and try again.');
          } finally { clearTimeout(timeout); }
          if (current !== session) return;
          if (typeof result.text !== 'string' || !result.text.trim()) throw new Error('No speech was detected. Please try again.');
          current = null;
          state('idle');
          onTranscript(result.text.trim());
        } catch (error) {
          if (current !== session) return;
          current = null;
          state('error', session.abort.signal.aborted ? 'Transcription timed out. Please try again.' : error.message);
        }
      };
      session.recorder.start(250);
      state('recording', 'Listening… I’ll send when you finish speaking.');
      if (AudioContext) {
        try {
          session.audioContext = new AudioContext();
          if (session.audioContext.state === 'suspended') session.audioContext.resume().catch(() => {});
          const source = session.audioContext.createMediaStreamSource(session.stream);
          const analyser = session.audioContext.createAnalyser();
          analyser.fftSize = 1024;
          source.connect(analyser);
          const samples = new Uint8Array(analyser.fftSize);
          let noise = 0.004;
          let voiceSince = 0;
          let lastVoice = 0;
          session.voiceTimer = setInterval(() => {
            if (current !== session || session.recorder.state !== 'recording') return;
            analyser.getByteTimeDomainData(samples);
            let power = 0;
            for (const sample of samples) power += ((sample - 128) / 128) ** 2;
            const rms = Math.sqrt(power / samples.length);
            onLevel(Math.min(1, rms * 5));
            const now = Date.now();
            if (rms > Math.max(0.016, noise * 2.5)) {
              if (!voiceSince) voiceSince = now;
              lastVoice = now;
            } else if (!voiceSince) {
              noise = noise * 0.92 + rms * 0.08;
            }
            if (voiceSince && lastVoice - voiceSince >= 180 && now - lastVoice >= silenceMs) finish();
          }, 80);
        } catch { /* Recording still works if audio level monitoring is unavailable. */ }
      }
      session.timer = setTimeout(finish, maxMs);
    } catch (error) {
      release(session);
      if (current !== session) return;
      current = null;
      const errors = {
        NotAllowedError: 'Microphone permission was denied. Allow microphone access for localhost in your browser settings, then try again.',
        NotFoundError: 'No microphone was found. Connect a microphone and try again.',
        NotReadableError: 'The microphone is busy or unavailable. Check Windows microphone permissions and close other recording apps.',
      };
      state('error', errors[error.name] || 'Could not start the microphone. Please try again.');
    }
  };
  return { start, finish, cancel };
}
