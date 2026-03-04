import { escapeHtml } from './utils.js';

export function renderTaskPanel(container, extraction, options = {}) {
  if (!container) return;

  const { tasks = [], decisions = [], follow_ups = [], topics_discussed = [] } = extraction;
  const totalCount = tasks.length + decisions.length + follow_ups.length;
  const { onPushToAsana } = options;

  container.innerHTML = '';

  // Header
  const header = document.createElement('div');
  header.className = 'asana-task-panel-header';
  header.innerHTML = `
    <h2>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41L9 16.17z" fill="currentColor"/></svg>
      Extracted Items
      <span class="asana-task-panel-badge">${totalCount}</span>
    </h2>
    <button class="asana-task-panel-close" id="closeTaskPanel">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" fill="currentColor"/></svg>
    </button>
  `;
  container.appendChild(header);

  // Topics
  if (topics_discussed.length > 0) {
    const topicsDiv = document.createElement('div');
    topicsDiv.className = 'asana-topics';
    topics_discussed.forEach(t => {
      const chip = document.createElement('span');
      chip.className = 'asana-topic-chip';
      chip.textContent = t;
      topicsDiv.appendChild(chip);
    });
    container.appendChild(topicsDiv);
  }

  // Tasks section
  if (tasks.length > 0) {
    container.appendChild(buildSection('Tasks', tasks.length, tasks.map(renderTask)));
  }

  // Decisions section
  if (decisions.length > 0) {
    container.appendChild(buildSection('Decisions', decisions.length, decisions.map(renderDecision)));
  }

  // Follow-ups section
  if (follow_ups.length > 0) {
    container.appendChild(buildSection('Follow-ups', follow_ups.length, follow_ups.map(renderFollowUp)));
  }

  // Push to Asana button (tasks only)
  if (tasks.length > 0 && typeof onPushToAsana === 'function') {
    const footer = document.createElement('div');
    footer.className = 'asana-task-panel-footer';
    footer.innerHTML = `
      <button class="asana-push-btn" id="pushToAsanaBtn">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z" fill="currentColor"/></svg>
        Push to Asana
      </button>
      <span class="asana-powered-by">Powered by Recall.ai Desktop SDK</span>
    `;
    const pushBtn = footer.querySelector('#pushToAsanaBtn');
    pushBtn.addEventListener('click', () => onPushToAsana(tasks));
    container.appendChild(footer);
  }

  // Close button
  const closeBtn = container.querySelector('#closeTaskPanel');
  if (closeBtn) {
    closeBtn.addEventListener('click', () => {
      container.classList.remove('visible');
    });
  }

  container.classList.add('visible');
}

function buildSection(title, count, cardElements) {
  const section = document.createElement('div');
  section.className = 'asana-section';
  section.innerHTML = `
    <div class="asana-section-title">
      ${escapeHtml(title)}
      <span class="asana-section-count">${count}</span>
    </div>
  `;
  cardElements.forEach(el => section.appendChild(el));
  return section;
}

function renderTask(task) {
  if (!task) return document.createElement('div');
  const card = document.createElement('div');
  card.className = 'asana-card asana-card-enter';

  const title = task.title || task.description || task.summary || '(untitled task)';
  const priorityClass = task.priority ? `priority-${task.priority}` : '';

  card.innerHTML = `
    <div class="asana-card-row">
      <div class="asana-card-check" tabindex="0" role="checkbox" aria-checked="false"></div>
      <div class="asana-card-body">
        <div class="asana-card-title">${escapeHtml(title)}</div>
        <div class="asana-card-meta">
          ${task.assignee && task.assignee !== 'Unassigned' ? `<span class="asana-tag assignee">${escapeHtml(task.assignee)}</span>` : ''}
          ${task.due && task.due !== 'No date' ? `<span class="asana-tag due">${escapeHtml(task.due)}</span>` : ''}
          ${task.project && task.project !== 'General' ? `<span class="asana-tag project">${escapeHtml(task.project)}</span>` : ''}
          ${priorityClass ? `<span class="asana-tag ${priorityClass}">${escapeHtml(task.priority)}</span>` : ''}
        </div>
        ${task.source_quote ? `<div class="asana-card-quote">"${escapeHtml(task.source_quote)}"</div>` : ''}
      </div>
    </div>
  `;

  // Toggle check
  const check = card.querySelector('.asana-card-check');
  const titleEl = card.querySelector('.asana-card-title');
  check.addEventListener('click', () => {
    const isChecked = check.classList.toggle('checked');
    check.setAttribute('aria-checked', String(isChecked));
    titleEl.classList.toggle('done', isChecked);
  });

  return card;
}

function renderDecision(decision) {
  if (!decision) return document.createElement('div');
  const card = document.createElement('div');
  card.className = 'asana-decision-card asana-card-enter';
  const summary = decision.summary || decision.description || decision.title || '(no summary)';
  card.innerHTML = `
    <div class="asana-decision-summary">${escapeHtml(summary)}</div>
    ${decision.made_by ? `<div class="asana-decision-by">Decided by ${escapeHtml(decision.made_by)}</div>` : ''}
    ${decision.source_quote ? `<div class="asana-card-quote">"${escapeHtml(decision.source_quote)}"</div>` : ''}
  `;
  return card;
}

function renderFollowUp(fu) {
  if (!fu) return document.createElement('div');
  const card = document.createElement('div');
  card.className = 'asana-followup-card asana-card-enter';
  const desc = fu.description || fu.summary || fu.title || '(no description)';
  card.innerHTML = `
    <div class="asana-followup-desc">${escapeHtml(desc)}</div>
    ${fu.owner ? `<div class="asana-followup-owner">Owner: ${escapeHtml(fu.owner)}</div>` : ''}
    ${fu.source_quote ? `<div class="asana-card-quote">"${escapeHtml(fu.source_quote)}"</div>` : ''}
  `;
  return card;
}

export function renderLoadingSkeleton(container) {
  if (!container) return;
  container.innerHTML = `
    <div class="asana-task-panel-header">
      <h2>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41L9 16.17z" fill="currentColor"/></svg>
        Extracting tasks...
      </h2>
    </div>
    <div class="asana-skeleton"></div>
    <div class="asana-skeleton" style="width:80%"></div>
    <div class="asana-skeleton" style="width:60%"></div>
  `;
  container.classList.add('visible');
}
