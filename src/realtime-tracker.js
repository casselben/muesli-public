import { extractIncremental } from './asana-extractor.js';

const BATCH_SIZE = 4;
const DEBOUNCE_MS = 3000;

let _accumulated = { tasks: [], decisions: [], follow_ups: [], topics_discussed: [] };
let _processedCount = 0;
let _buffer = [];
let _timer = null;
let _processing = false;
let _onUpdate = null;
let _apiKey = null;

export function initTracker({ apiKey, onUpdate }) {
  _apiKey = apiKey;
  _onUpdate = onUpdate;
  resetTracker();
}

export function resetTracker() {
  _accumulated = { tasks: [], decisions: [], follow_ups: [], topics_discussed: [] };
  _processedCount = 0;
  _buffer = [];
  _processing = false;
  if (_timer) {
    clearTimeout(_timer);
    _timer = null;
  }
}

export function feedEntry(entry) {
  _buffer.push(entry);

  if (_buffer.length >= BATCH_SIZE && !_processing) {
    _scheduleBatch(0);
  } else if (!_timer && !_processing) {
    _scheduleBatch(DEBOUNCE_MS);
  }
}

export function getAccumulated() {
  return JSON.parse(JSON.stringify(_accumulated));
}

export function flush() {
  if (_buffer.length > 0 && !_processing) {
    _processBatch();
  }
}

function _scheduleBatch(delayMs) {
  if (_timer) clearTimeout(_timer);
  _timer = setTimeout(() => {
    _timer = null;
    _processBatch();
  }, delayMs);
}

async function _processBatch() {
  if (_processing || _buffer.length === 0) return;
  _processing = true;

  const batch = _buffer.splice(0);

  try {
    const result = await extractIncremental(batch, _accumulated, { apiKey: _apiKey });
    _merge(result);
    _processedCount += batch.length;
    if (_onUpdate) _onUpdate(_accumulated);
  } catch (err) {
    console.error('Realtime extraction failed:', err);
  } finally {
    _processing = false;
    if (_buffer.length >= BATCH_SIZE) {
      _scheduleBatch(0);
    } else if (_buffer.length > 0) {
      _scheduleBatch(DEBOUNCE_MS);
    }
  }
}

function _merge(newData) {
  if (newData.tasks) {
    newData.tasks.forEach(t => {
      if (!_accumulated.tasks.some(existing => existing.title === t.title)) {
        _accumulated.tasks.push(t);
      }
    });
  }
  if (newData.decisions) {
    newData.decisions.forEach(d => {
      if (!_accumulated.decisions.some(existing => existing.summary === d.summary)) {
        _accumulated.decisions.push(d);
      }
    });
  }
  if (newData.follow_ups) {
    newData.follow_ups.forEach(f => {
      if (!_accumulated.follow_ups.some(existing => existing.description === f.description)) {
        _accumulated.follow_ups.push(f);
      }
    });
  }
  if (newData.topics_discussed) {
    newData.topics_discussed.forEach(t => {
      if (!_accumulated.topics_discussed.includes(t)) {
        _accumulated.topics_discussed.push(t);
      }
    });
  }
}
