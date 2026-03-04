const OPENROUTER_MODEL = 'anthropic/claude-3.7-sonnet';

function buildSystemPrompt() {
  return `You are an AI assistant that extracts structured project-management data from meeting transcripts.

Return ONLY valid JSON — no markdown fences, no explanation.

Schema:
{
  "tasks": [
    {
      "title": "string — short imperative sentence",
      "assignee": "string — person name or 'Unassigned'",
      "due": "string — date mentioned or 'No date'",
      "priority": "high | medium | low",
      "status": "Not started | On track | At risk | Off track",
      "project": "string — project/feature area or 'General'",
      "source_quote": "string — verbatim snippet from transcript"
    }
  ],
  "decisions": [
    {
      "summary": "string — one-sentence decision",
      "made_by": "string — who decided",
      "source_quote": "string"
    }
  ],
  "follow_ups": [
    {
      "description": "string",
      "owner": "string",
      "source_quote": "string"
    }
  ],
  "topics_discussed": ["string"]
}

Rules:
- Extract every actionable task, decision, and follow-up.
- "priority" should be "high" only for blockers or time-sensitive items.
- "status" defaults to "Not started" for new tasks unless the transcript clearly indicates otherwise.
- Keep source_quote to at most 40 words.
- If information is uncertain, still include it with best guess.`;
}

function buildUserMessage(transcriptEntries) {
  const lines = transcriptEntries
    .map(e => `${e.speaker}: ${e.text}`)
    .join('\n');
  return `Extract tasks, decisions, and follow-ups from this meeting transcript:\n\n${lines}`;
}

export async function extractFromTranscript(transcriptEntries, { apiKey, onStream } = {}) {
  if (!apiKey) throw new Error('Missing OpenRouter API key');
  if (!transcriptEntries || transcriptEntries.length === 0) {
    return { tasks: [], decisions: [], follow_ups: [], topics_discussed: [] };
  }

  const messages = [
    { role: 'system', content: buildSystemPrompt() },
    { role: 'user', content: buildUserMessage(transcriptEntries) }
  ];

  const useStreaming = typeof onStream === 'function';

  const body = {
    model: OPENROUTER_MODEL,
    messages,
    max_tokens: 2000,
    temperature: 0.3,
    stream: useStreaming
  };

  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
      'HTTP-Referer': 'https://recall.ai',
      'X-Title': 'Muesli AI Notetaker'
    },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`OpenRouter API error ${res.status}: ${errText}`);
  }

  if (!useStreaming) {
    const json = await res.json();
    const raw = json.choices?.[0]?.message?.content || '{}';
    return parseExtraction(raw);
  }

  // Streaming path
  let fullText = '';
  const reader = res.body.getReader();
  const decoder = new TextDecoder();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    const chunk = decoder.decode(value, { stream: true });
    const lines = chunk.split('\n').filter(l => l.startsWith('data: '));

    for (const line of lines) {
      const payload = line.slice(6).trim();
      if (payload === '[DONE]') continue;
      try {
        const parsed = JSON.parse(payload);
        const delta = parsed.choices?.[0]?.delta?.content || '';
        if (delta) {
          fullText += delta;
          onStream(fullText);
        }
      } catch {
        // skip malformed SSE chunks
      }
    }
  }

  return parseExtraction(fullText);
}

function parseExtraction(raw) {
  // Strip markdown code fences if present
  let cleaned = raw.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/, '').replace(/```\s*$/, '');
  }
  try {
    const data = JSON.parse(cleaned);
    return {
      tasks: Array.isArray(data.tasks) ? data.tasks : [],
      decisions: Array.isArray(data.decisions) ? data.decisions : [],
      follow_ups: Array.isArray(data.follow_ups) ? data.follow_ups : [],
      topics_discussed: Array.isArray(data.topics_discussed) ? data.topics_discussed : []
    };
  } catch (e) {
    console.error('Failed to parse extraction JSON:', e, '\nRaw:', raw);
    return { tasks: [], decisions: [], follow_ups: [], topics_discussed: [] };
  }
}

// Incremental extraction for real-time sidebar
export async function extractIncremental(newEntries, existingContext, { apiKey }) {
  if (!apiKey) throw new Error('Missing OpenRouter API key');
  if (!newEntries || newEntries.length === 0) {
    return { tasks: [], decisions: [], follow_ups: [], topics_discussed: [] };
  }

  const existingTasks = (existingContext.tasks || []).map(t => t.title).join('; ');
  const existingDecisions = (existingContext.decisions || []).map(d => d.summary).join('; ');
  const existingFollowUps = (existingContext.follow_ups || []).map(f => f.description).join('; ');
  const existingTopics = (existingContext.topics_discussed || []).join(', ');

  const contextBlock = [
    existingTasks && `Already-extracted tasks: ${existingTasks}`,
    existingDecisions && `Already-extracted decisions: ${existingDecisions}`,
    existingFollowUps && `Already-extracted follow-ups: ${existingFollowUps}`,
    existingTopics && `Already-extracted topics: ${existingTopics}`
  ].filter(Boolean).join('\n') || 'No prior context.';

  const newLines = newEntries.map(e => `${e.speaker}: ${e.text}`).join('\n');

  const messages = [
    {
      role: 'system',
      content: `You extract NEW tasks, decisions, and follow-ups from the latest portion of a meeting transcript.
Only return items NOT already captured (see the "already-extracted" lists the user provides).

Return ONLY valid JSON — no markdown fences, no explanation.

Schema:
{
  "tasks": [
    {
      "title": "string — short imperative sentence",
      "assignee": "string — person name or 'Unassigned'",
      "due": "string — date mentioned or 'No date'",
      "priority": "high | medium | low",
      "status": "Not started | On track | At risk | Off track",
      "project": "string — project/feature area or 'General'",
      "source_quote": "string — verbatim snippet (max 40 words)"
    }
  ],
  "decisions": [
    {
      "summary": "string — one-sentence decision",
      "made_by": "string — who decided",
      "source_quote": "string"
    }
  ],
  "follow_ups": [
    {
      "description": "string",
      "owner": "string",
      "source_quote": "string"
    }
  ],
  "topics_discussed": ["string"]
}

Default "status" to "Not started" for new tasks unless the transcript clearly indicates otherwise.
If nothing new is found, return: {"tasks":[],"decisions":[],"follow_ups":[],"topics_discussed":[]}`
    },
    {
      role: 'user',
      content: `${contextBlock}\n\nNew transcript lines:\n${newLines}`
    }
  ];

  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
      'HTTP-Referer': 'https://recall.ai',
      'X-Title': 'Muesli AI Notetaker'
    },
    body: JSON.stringify({
      model: OPENROUTER_MODEL,
      messages,
      max_tokens: 1000,
      temperature: 0.3
    })
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`OpenRouter API error ${res.status}: ${errText}`);
  }

  const json = await res.json();
  const raw = json.choices?.[0]?.message?.content || '{}';
  return parseExtraction(raw);
}
