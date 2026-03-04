/**
 * Push extracted tasks to Asana via REST API.
 * Maps current app schema (title, assignee, due, priority, etc.) to Asana task payload.
 * Assignee name goes in Owner custom field only; task assignee is not set.
 * Requires ASANA_PAT and ASANA_* GIDs in .env.
 */
const https = require('https');

function getEnv(name) {
  return process.env[name] || '';
}

function priorityToGid(priority) {
  const p = (priority || '').toLowerCase();
  if (p === 'high') return getEnv('ASANA_PRIORITY_HIGH_GID');
  if (p === 'medium') return getEnv('ASANA_PRIORITY_MEDIUM_GID');
  if (p === 'low') return getEnv('ASANA_PRIORITY_LOW_GID');
  return getEnv('ASANA_PRIORITY_MEDIUM_GID') || getEnv('ASANA_PRIORITY_LOW_GID');
}

function statusToGid(status) {
  const s = (status || '').toLowerCase().replace(/\s+/g, ' ');
  if (/not started/.test(s)) return getEnv('ASANA_STATUS_NOT_STARTED_GID');
  if (/on track/.test(s)) return getEnv('ASANA_STATUS_ONTRACK_GID');
  if (/at risk/.test(s)) return getEnv('ASANA_STATUS_ATRISK_GID');
  if (/off track/.test(s)) return getEnv('ASANA_STATUS_OFFTRACK_GID');
  return getEnv('ASANA_STATUS_NOT_STARTED_GID') || getEnv('ASANA_STATUS_ONTRACK_GID');
}

/** Parse due string to YYYY-MM-DD or return null */
function parseDueOn(due) {
  if (!due || due === 'No date') return null;
  const s = String(due).trim().toLowerCase();
  if (!s) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);

  if (/^today$|^end of day$/i.test(s)) return today.toISOString().slice(0, 10);
  if (/^tomorrow$/i.test(s)) {
    const t = new Date(today);
    t.setDate(t.getDate() + 1);
    return t.toISOString().slice(0, 10);
  }

  const weekdays = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const targetDay = weekdays.find(d => s.startsWith(d));
  if (targetDay !== undefined) {
    const targetIdx = weekdays.indexOf(targetDay);
    const currentIdx = today.getDay();
    let daysAhead = targetIdx - currentIdx;
    if (daysAhead <= 0) daysAhead += 7;
    const d = new Date(today);
    d.setDate(d.getDate() + daysAhead);
    return d.toISOString().slice(0, 10);
  }

  // Month+day (e.g. "March 15th") — no 4-digit year in input, so use current year
  const hasExplicitYear = /\d{4}/.test(s);
  const cleaned = s.replace(/\b(\d{1,2})(st|nd|rd|th)\b/gi, '$1');
  const currentYear = today.getFullYear();
  const d = new Date(cleaned);
  if (!isNaN(d.getTime())) {
    if (!hasExplicitYear || d.getFullYear() < 2000 || d.getFullYear() > 2100) d.setFullYear(currentYear);
    return d.toISOString().slice(0, 10);
  }
  const d2 = new Date(s);
  if (!isNaN(d2.getTime())) {
    if (!hasExplicitYear || d2.getFullYear() < 2000 || d2.getFullYear() > 2100) d2.setFullYear(currentYear);
    return d2.toISOString().slice(0, 10);
  }
  return null;
}

/**
 * Build Asana API task payload from our extraction task object.
 * Current schema: title, assignee, due, priority, project, description?, source_quote?
 */
function taskToAsanaPayload(task) {
  const projectGid = getEnv('ASANA_PROJECT_GID');
  const sectionGid = getEnv('ASANA_SECTION_TODO_GID');
  const priorityFieldGid = getEnv('ASANA_FIELD_PRIORITY_GID');
  const statusFieldGid = getEnv('ASANA_FIELD_STATUS_GID');
  const ownerTextFieldGid = getEnv('ASANA_FIELD_OWNER_TEXT_GID');

  const name = task.title || task.description || '(Untitled task)';
  const assigneeName = task.assignee && task.assignee !== 'Unassigned' ? task.assignee : '';
  const dueOn = parseDueOn(task.due);
  const priorityGid = priorityToGid(task.priority);
  const statusGid = statusToGid(task.status);

  const notesParts = [];
  if (assigneeName) notesParts.push('Owner: ' + assigneeName);
  if (task.description) notesParts.push(task.description);
  if (task.source_quote) notesParts.push('Source: ' + task.source_quote);
  const notes = notesParts.join('\n\n');

  const data = {
    name,
    projects: [projectGid],
    memberships: [{ project: projectGid, section: sectionGid }],
    notes: notes || undefined,
    due_on: dueOn || undefined,
    custom_fields: {}
  };

  if (priorityFieldGid && priorityGid) data.custom_fields[priorityFieldGid] = priorityGid;
  if (statusFieldGid && statusGid) data.custom_fields[statusFieldGid] = statusGid;
  if (ownerTextFieldGid && assigneeName) data.custom_fields[ownerTextFieldGid] = assigneeName;

  return { data };
}

function asanaPost(pathname, body) {
  return new Promise((resolve, reject) => {
    const pat = getEnv('ASANA_PAT');
    if (!pat) {
      resolve({ error: 'ASANA_PAT not set' });
      return;
    }

    const bodyStr = JSON.stringify(body);
    const req = https.request({
      hostname: 'app.asana.com',
      path: '/api/1.0' + pathname,
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + pat,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(bodyStr)
      }
    }, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try {
          const json = JSON.parse(raw || '{}');
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve({ success: true, data: json.data });
          } else {
            resolve({
              success: false,
              error: (json.errors && json.errors[0] && json.errors[0].message) || res.statusCode + ' ' + raw,
              payload: body
            });
          }
        } catch (e) {
          resolve({ success: false, error: e.message, payload: body });
        }
      });
    });
    req.on('error', err => resolve({ success: false, error: err.message, payload: body }));
    req.write(bodyStr);
    req.end();
  });
}

/**
 * Push a single task to Asana. Never throws.
 * @returns {Promise<{ success: boolean, gid?: string, permalink_url?: string, error?: string, payload?: object }>}
 */
async function pushTaskToAsana(task) {
  if (!task) return { success: false, error: 'No task', payload: null };
  const payload = taskToAsanaPayload(task);
  const result = await asanaPost('/tasks', payload);
  if (result.success && result.data) {
    return {
      success: true,
      gid: result.data.gid,
      permalink_url: result.data.permalink_url
    };
  }
  return {
    success: false,
    error: result.error || 'Unknown error',
    payload: payload
  };
}

/**
 * Push all tasks. Returns summary and per-task results. Never throws.
 */
async function pushAllTasksToAsana(tasks) {
  if (!Array.isArray(tasks) || tasks.length === 0) {
    return { succeeded: 0, failed: 0, results: [] };
  }

  const settled = await Promise.allSettled(
    tasks.map(t => pushTaskToAsana(t))
  );

  const results = settled.map((p, i) => {
    const task = tasks[i];
    if (p.status === 'fulfilled') {
      return { task, ...p.value };
    }
    return {
      task,
      success: false,
      error: (p.reason && p.reason.message) || String(p.reason),
      payload: taskToAsanaPayload(task)
    };
  });

  const succeeded = results.filter(r => r.success).length;
  const failed = results.length - succeeded;

  return { succeeded, failed, results };
}

module.exports = { pushTaskToAsana, pushAllTasksToAsana, taskToAsanaPayload };
