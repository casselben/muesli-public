import { escapeHtml } from './utils.js';

let _sidebarEl = null;

export function getSidebarElement() {
  if (_sidebarEl) return _sidebarEl;

  _sidebarEl = document.createElement('div');
  _sidebarEl.className = 'asana-sidebar';
  _sidebarEl.id = 'asanaSidebar';
  _sidebarEl.innerHTML = `
    <div class="asana-sidebar-header">
      <h3>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
          <path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-2 10H7v-2h10v2z" fill="currentColor"/>
        </svg>
        Live Action Items
        <span class="asana-task-panel-badge" id="sidebarBadge">0</span>
      </h3>
      <button class="asana-sidebar-close" id="closeSidebar">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
          <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" fill="currentColor"/>
        </svg>
      </button>
    </div>
    <div class="asana-sidebar-body" id="sidebarBody">
      <div class="asana-sidebar-status" id="sidebarStatus">
        <span class="pulse-dot"></span>
        Listening for action items...
      </div>
      <div id="sidebarTopics"></div>
      <div id="sidebarTasks"></div>
      <div id="sidebarDecisions"></div>
      <div id="sidebarFollowUps"></div>
      <div class="asana-sidebar-empty" id="sidebarEmpty">
        Items will appear here as they're detected in the meeting.
      </div>
    </div>
  `;

  document.body.appendChild(_sidebarEl);

  _sidebarEl.querySelector('#closeSidebar').addEventListener('click', () => {
    closeSidebar();
  });

  return _sidebarEl;
}

export function openSidebar() {
  const el = getSidebarElement();
  clearSidebar();
  el.classList.add('open');
  document.body.classList.add('asana-sidebar-open');
}

export function clearSidebar() {
  const el = getSidebarElement();
  const badge = el.querySelector('#sidebarBadge');
  if (badge) badge.textContent = '0';
  const empty = el.querySelector('#sidebarEmpty');
  if (empty) empty.style.display = 'block';
  ['#sidebarTopics', '#sidebarTasks', '#sidebarDecisions', '#sidebarFollowUps'].forEach(sel => {
    const c = el.querySelector(sel);
    if (c) c.innerHTML = '';
  });
  const status = el.querySelector('#sidebarStatus');
  if (status) status.innerHTML = '<span class="pulse-dot"></span> Listening for action items...';
}

export function closeSidebar() {
  const el = getSidebarElement();
  el.classList.remove('open');
  document.body.classList.remove('asana-sidebar-open');
}

export function isSidebarOpen() {
  return _sidebarEl && _sidebarEl.classList.contains('open');
}

export function updateSidebar(accumulated) {
  const el = getSidebarElement();
  const { tasks = [], decisions = [], follow_ups = [], topics_discussed = [] } = accumulated;

  const totalCount = tasks.length + decisions.length + follow_ups.length;

  // Badge
  const badge = el.querySelector('#sidebarBadge');
  if (badge) badge.textContent = totalCount;

  // Empty state
  const empty = el.querySelector('#sidebarEmpty');
  if (empty) empty.style.display = totalCount === 0 ? 'block' : 'none';

  // Topics
  const topicsContainer = el.querySelector('#sidebarTopics');
  if (topicsContainer && topics_discussed.length > 0) {
    topicsContainer.innerHTML = '';
    const chips = document.createElement('div');
    chips.className = 'asana-topics';
    topics_discussed.forEach(t => {
      const chip = document.createElement('span');
      chip.className = 'asana-topic-chip';
      chip.textContent = t;
      chips.appendChild(chip);
    });
    topicsContainer.appendChild(chips);
  }

  // Tasks
  const tasksContainer = el.querySelector('#sidebarTasks');
  if (tasksContainer) {
    renderSidebarSection(tasksContainer, 'Tasks', tasks, renderSidebarTask);
  }

  // Decisions
  const decisionsContainer = el.querySelector('#sidebarDecisions');
  if (decisionsContainer) {
    renderSidebarSection(decisionsContainer, 'Decisions', decisions, renderSidebarDecision);
  }

  // Follow-ups
  const fuContainer = el.querySelector('#sidebarFollowUps');
  if (fuContainer) {
    renderSidebarSection(fuContainer, 'Follow-ups', follow_ups, renderSidebarFollowUp);
  }
}

function renderSidebarSection(container, title, items, renderFn) {
  if (items.length === 0) {
    container.innerHTML = '';
    return;
  }

  container.innerHTML = `
    <div class="asana-section-title">${escapeHtml(title)} <span class="asana-section-count">${items.length}</span></div>
  `;
  items.forEach(item => container.appendChild(renderFn(item)));
}

function renderSidebarTask(task) {
  if (!task) return document.createElement('div');
  const card = document.createElement('div');
  card.className = 'asana-card asana-card-enter';
  const title = task.title || task.description || task.summary || '(untitled task)';
  const assignee = task.assignee && task.assignee !== 'Unassigned' ? task.assignee : '';
  const priorityClass = task.priority ? `priority-${task.priority}` : '';
  card.innerHTML = `
    <div class="asana-card-row">
      <div class="asana-card-check" tabindex="0" role="checkbox" aria-checked="false"></div>
      <div class="asana-card-body">
        <div class="asana-card-title">${escapeHtml(title)}</div>
        <div class="asana-card-meta">
          ${assignee ? `<span class="asana-tag assignee">${escapeHtml(assignee)}</span>` : ''}
          ${task.due && task.due !== 'No date' ? `<span class="asana-tag due">${escapeHtml(task.due)}</span>` : ''}
          ${priorityClass ? `<span class="asana-tag ${priorityClass}">${escapeHtml(task.priority)}</span>` : ''}
        </div>
      </div>
    </div>
  `;
  const check = card.querySelector('.asana-card-check');
  const titleEl = card.querySelector('.asana-card-title');
  check.addEventListener('click', () => {
    const isChecked = check.classList.toggle('checked');
    check.setAttribute('aria-checked', String(isChecked));
    titleEl.classList.toggle('done', isChecked);
  });
  return card;
}

function renderSidebarDecision(d) {
  if (!d) return document.createElement('div');
  const card = document.createElement('div');
  card.className = 'asana-decision-card asana-card-enter';
  const summary = d.summary || d.description || d.title || '(no summary)';
  card.innerHTML = `
    <div class="asana-decision-summary">${escapeHtml(summary)}</div>
    ${d.made_by ? `<div class="asana-decision-by">by ${escapeHtml(d.made_by)}</div>` : ''}
  `;
  return card;
}

function renderSidebarFollowUp(fu) {
  if (!fu) return document.createElement('div');
  const card = document.createElement('div');
  card.className = 'asana-followup-card asana-card-enter';
  const desc = fu.description || fu.summary || fu.title || '(no description)';
  card.innerHTML = `
    <div class="asana-followup-desc">${escapeHtml(desc)}</div>
    ${fu.owner ? `<div class="asana-followup-owner">${escapeHtml(fu.owner)}</div>` : ''}
  `;
  return card;
}

export function updateSidebarStatus(message) {
  const el = getSidebarElement();
  const status = el.querySelector('#sidebarStatus');
  if (status) {
    status.innerHTML = `<span class="pulse-dot"></span> ${escapeHtml(message)}`;
  }
}
