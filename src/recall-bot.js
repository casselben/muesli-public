/**
 * Recall API bot operations: create bots, poll status, fetch and convert transcripts.
 * Uses RECALLAI_API_URL and RECALLAI_API_KEY from process.env.
 */
const https = require('https');

function getEnv(name) {
  return process.env[name] || '';
}

function recallPost(pathname, data) {
  return new Promise((resolve, reject) => {
    const apiUrl = getEnv('RECALLAI_API_URL') || 'https://us-west-2.recall.ai';
    const parsed = new URL(apiUrl);
    const bodyStr = JSON.stringify(data);

    const req = https.request({
      hostname: parsed.hostname,
      port: parsed.port || 443,
      path: pathname,
      method: 'POST',
      headers: {
        'Authorization': 'Token ' + getEnv('RECALLAI_API_KEY'),
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(bodyStr)
      }
    }, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try {
          const json = JSON.parse(body || '{}');
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(json);
          } else {
            reject(new Error(`Recall API ${res.statusCode}: ${JSON.stringify(json.errors || json.detail || json)}`));
          }
        } catch (e) {
          reject(new Error(`Recall API parse error: ${e.message}`));
        }
      });
    });
    req.on('error', reject);
    req.write(bodyStr);
    req.end();
  });
}

function recallGet(pathname) {
  return new Promise((resolve, reject) => {
    const apiUrl = getEnv('RECALLAI_API_URL') || 'https://us-west-2.recall.ai';
    const parsed = new URL(apiUrl);

    const req = https.request({
      hostname: parsed.hostname,
      port: parsed.port || 443,
      path: pathname,
      method: 'GET',
      headers: {
        'Authorization': 'Token ' + getEnv('RECALLAI_API_KEY'),
        'Content-Type': 'application/json'
      }
    }, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try {
          const json = JSON.parse(body || '{}');
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(json);
          } else {
            reject(new Error(`Recall API ${res.statusCode}: ${JSON.stringify(json.errors || json.detail || json)}`));
          }
        } catch (e) {
          reject(new Error(`Recall API parse error: ${e.message}`));
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

/**
 * Send a bot to a meeting URL.
 * Returns the full bot object from Recall (includes id, status_changes, etc.)
 */
async function createBot(meetingUrl) {
  return recallPost('/api/v1/bot/', {
    meeting_url: meetingUrl,
    bot_name: 'Muesli Notetaker',
    recording_config: {
      transcript: {
        provider: {
          assembly_ai_v3_streaming: {}
        }
      }
    }
  });
}

/**
 * Get bot details including latest status.
 * status_changes is an array like [{ code: "ready", message: "...", created_at: "..." }, ...]
 */
async function getBotStatus(botId) {
  return recallGet(`/api/v1/bot/${botId}/`);
}

/**
 * Get the transcript produced by the bot (array of TranscriptLegacyParagraph).
 */
async function getBotTranscript(botId) {
  return recallGet(`/api/v1/bot/${botId}/transcript/`);
}

/**
 * Convert Recall's TranscriptLegacyParagraph[] to the app's [{speaker, text, timestamp}].
 * Each paragraph has: speaker (string), words (array of {text, start_timestamp, end_timestamp}).
 */
function convertTranscript(paragraphs, meetingStartTime) {
  const baseTime = meetingStartTime ? new Date(meetingStartTime).getTime() : Date.now();

  return paragraphs.map(p => {
    const speaker = p.speaker || p.participant?.name || 'Unknown';
    const text = (p.words || []).map(w => w.text).join(' ');
    const offsetSec = (p.words && p.words.length > 0) ? p.words[0].start_timestamp : 0;
    const timestamp = new Date(baseTime + offsetSec * 1000).toISOString();
    return { speaker, text, timestamp };
  }).filter(e => e.text.trim().length > 0);
}

/**
 * Extract the latest status code from a bot object's status_changes array.
 * Terminal statuses: "done", "fatal"
 */
function getLatestStatus(botData) {
  const changes = botData.status_changes || [];
  if (changes.length === 0) return { code: 'unknown', message: '' };
  const latest = changes[changes.length - 1];
  return { code: latest.code || 'unknown', message: latest.message || '' };
}

function isTerminalStatus(code) {
  return ['done', 'fatal'].includes(code);
}

module.exports = {
  createBot,
  getBotStatus,
  getBotTranscript,
  convertTranscript,
  getLatestStatus,
  isTerminalStatus
};
