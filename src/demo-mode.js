import demoTranscript from './demo-transcript.json';

const PLAYBACK_INTERVAL_MS = 800;

let _timer = null;
let _index = 0;
let _onEntry = null;
let _onDone = null;

export function startDemoPlayback({ onEntry, onDone }) {
  stopDemoPlayback();
  _index = 0;
  _onEntry = onEntry;
  _onDone = onDone;

  _timer = setInterval(() => {
    if (_index >= demoTranscript.length) {
      stopDemoPlayback();
      if (_onDone) _onDone();
      return;
    }
    const entry = demoTranscript[_index];
    _index++;
    if (_onEntry) _onEntry(entry, _index, demoTranscript.length);
  }, PLAYBACK_INTERVAL_MS);
}

export function stopDemoPlayback() {
  if (_timer) {
    clearInterval(_timer);
    _timer = null;
  }
}

export function isDemoPlaying() {
  return _timer !== null;
}

export function getDemoTranscript() {
  return demoTranscript;
}
