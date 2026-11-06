const dashboardState = {
  data: null,
  historyFilter: 'all',
  loading: false,
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[character]);
}

function safeHttpUrl(value) {
  if (typeof value !== 'string' || value.length === 0) {
    return '';
  }

  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) ? url.href : '';
  } catch {
    return '';
  }
}

function safeUrl(value) {
  const href = safeHttpUrl(value);
  return href ? escapeHtml(href) : '';
}

function formatNumber(value) {
  return new Intl.NumberFormat('zh-CN').format(Number(value) || 0);
}

function formatClock(value) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    return '--';
  }
  return new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(timestamp);
}

function formatDateTime(value) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    return '--';
  }
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(timestamp);
}

function formatRelativeTime(value) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    return '--';
  }

  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 10) {
    return '刚刚';
  }
  if (seconds < 60) {
    return `${seconds} 秒前`;
  }
  if (seconds < 3600) {
    return `${Math.floor(seconds / 60)} 分钟前`;
  }
  if (seconds < 86_400) {
    return `${Math.floor(seconds / 3600)} 小时前`;
  }
  return `${Math.floor(seconds / 86_400)} 天前`;
}

function formatInterval(milliseconds) {
  const seconds = Math.max(1, Math.round((Number(milliseconds) || 0) / 1000));
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return remainingSeconds === 0 ? `${minutes}m` : `${minutes}m ${remainingSeconds}s`;
}

function shortSha(sha) {
  return typeof sha === 'string' && sha.length > 0 ? sha.slice(0, 8) : '--';
}

function shortThreadId(threadId) {
  return typeof threadId === 'string' && threadId.length > 0 ? threadId.slice(0, 8) : '未配置';
}

function roleLabel(role) {
  return role === 'developer' ? '普通开发者' : '审核端';
}

function pipelineMeta(status) {
  const normalized = String(status ?? '').toLowerCase();
  if (['success', 'passed'].includes(normalized)) {
    return { className: 'success', label: 'CI passed' };
  }
  if (['failed', 'canceled', 'cancelled'].includes(normalized)) {
    return { className: 'failed', label: 'CI failed' };
  }
  if (['running', 'pending', 'created'].includes(normalized)) {
    return { className: 'running', label: 'CI running' };
  }
  return { className: 'neutral', label: status || 'CI none' };
}

function mergeMeta(status) {
  const normalized = String(status ?? '').toLowerCase();
  if (normalized === 'mergeable') {
    return { className: 'success', label: '可合并' };
  }
  if (['conflict', 'cannot_be_merged'].includes(normalized)) {
    return { className: 'failed', label: '有冲突' };
  }
  if (normalized === 'need_rebase') {
    return { className: 'warning', label: '需 rebase' };
  }
  if (normalized === 'discussions_not_resolved') {
    return { className: 'warning', label: '讨论未解决' };
  }
  if (normalized === 'ci_must_pass') {
    return { className: 'warning', label: 'CI 未通过' };
  }
  if (normalized === 'not_approved') {
    return { className: 'neutral', label: '未批准' };
  }
  return { className: 'neutral', label: status || '未知' };
}

function eventIcon(type) {
  return ({
    new_mr: '+',
    thread_created: '＋',
    agent_notified: '→',
    review_started: '↗',
    mr_update: '↻',
    developer_notify: '✓',
    developer_manual: '→',
    mapping_added: '⌁',
    mapping_removed: '−',
    watcher_started: '◉',
    watcher_stopped: '■',
    gitlab_authenticated: '✓',
    error: '!',
  })[type] ?? '·';
}

function eventLabel(type) {
  return ({
    new_mr: '发现新 MR',
    thread_created: '创建审查线程',
    agent_notified: '通知 agent',
    review_started: '启动审查检查',
    mr_update: 'MR 发生变化',
    developer_notify: '通知开发 agent',
    developer_manual: '手动通知开发 agent',
    mapping_added: '新增分配映射',
    mapping_removed: '删除分配映射',
    watcher_started: 'watcher 启动',
    watcher_stopped: 'watcher 停止',
    gitlab_authenticated: 'GitLab 认证成功',
    error: '执行错误',
  })[type] ?? type;
}

function animateCount(element, target) {
  const nextValue = Number(target) || 0;
  const previousValue = Number(element.dataset.current ?? 0) || 0;
  if (previousValue === nextValue) {
    element.textContent = formatNumber(nextValue);
    return;
  }

  const startedAt = performance.now();
  const duration = 480;

  function step(now) {
    const progress = Math.min(1, (now - startedAt) / duration);
    const eased = 1 - (1 - progress) ** 3;
    const value = Math.round(previousValue + (nextValue - previousValue) * eased);
    element.textContent = formatNumber(value);
    if (progress < 1) {
      requestAnimationFrame(step);
      return;
    }
    element.dataset.current = String(nextValue);
  }

  element.dataset.current = String(previousValue);
  requestAnimationFrame(step);
}

function showToast(message) {
  const toast = $('#toast');
  toast.textContent = message;
  toast.classList.add('visible');
  window.clearTimeout(showToast.timeoutId);
  showToast.timeoutId = window.setTimeout(() => {
    toast.classList.remove('visible');
  }, 2600);
}

function updateStatus(status, stats, auth) {
  const hasError = Boolean(status.lastError);
  const isPolling = Boolean(status.isPolling);
  const needsAuthentication = Boolean(auth?.needsAuthentication);
  const role = roleLabel(status.role);
  const statusDot = $('#sidebar-status-dot');
  const statusLabel = $('#sidebar-status');
  const livePill = $('#live-pill');
  const liveLabel = $('#live-label');

  statusDot.classList.toggle('error', hasError);
  statusDot.classList.toggle('waiting', needsAuthentication && !hasError);
  statusLabel.classList.toggle('error', hasError);
  statusLabel.classList.toggle('waiting', needsAuthentication && !hasError);
  livePill.classList.toggle('error', hasError);
  livePill.classList.toggle('waiting', needsAuthentication && !hasError);
  $('#sidebar-role').textContent = role;
  $('#role-pill').textContent = role;

  if (hasError) {
    statusLabel.textContent = '有错误';
    liveLabel.textContent = '有错误';
  } else if (needsAuthentication) {
    statusLabel.textContent = '待认证';
    liveLabel.textContent = '待认证';
  } else if (isPolling) {
    statusLabel.textContent = '检查中';
    liveLabel.textContent = '检查中';
  } else {
    statusLabel.textContent = '运行中';
    liveLabel.textContent = '实时';
  }

  const lastPoll = status.lastPollAt
    ? `上次检查 ${formatClock(status.lastPollAt)}`
    : '尚未检查';
  const duration = status.lastPollDurationMs
    ? ` · 耗时 ${formatInterval(status.lastPollDurationMs)}`
    : '';
  $('#last-poll-chip').textContent = lastPoll;
  $('#poll-speed-chip').textContent = `${Math.round(stats.pollIntervalMs / 1000)} 秒 / 轮`;
  $('#poll-interval').textContent = formatInterval(stats.pollIntervalMs);
  $('#stat-interval').textContent = formatInterval(stats.pollIntervalMs);

  if (hasError) {
    $('#sidebar-summary').textContent = `上一轮失败：${status.lastError}`;
  } else if (needsAuthentication) {
    $('#sidebar-summary').textContent = 'GitLab 尚未连接，请在“接入设置”中粘贴 Token。';
  } else if (isPolling) {
    $('#sidebar-summary').textContent = '正在读取 GitLab 与检查映射...';
  } else if (status.lastPollAt) {
    $('#sidebar-summary').textContent = `${lastPoll}${duration}`;
  } else {
    $('#sidebar-summary').textContent = '等待第一次轮询...';
  }

  $('#dashboard-url').textContent = status.dashboardUrl
    ? status.dashboardUrl.replace(/^https?:\/\//, '')
    : '管理页未启动';
}

function updateCountdown() {
  const data = dashboardState.data;
  if (!data) {
    return;
  }

  const progress = $('#poll-progress');
  const nextPoll = $('#next-poll');
  const interval = Number(data.stats.pollIntervalMs) || 60_000;

  if (data.status.isPolling) {
    progress.style.width = '100%';
    nextPoll.textContent = '正在检查...';
    return;
  }

  if (!data.status.nextPollAt) {
    progress.style.width = '0%';
    nextPoll.textContent = '等待下一轮';
    return;
  }

  const remaining = Math.max(0, Date.parse(data.status.nextPollAt) - Date.now());
  const ratio = Math.min(1, Math.max(0, 1 - remaining / interval));
  progress.style.width = `${Math.round(ratio * 100)}%`;
  nextPoll.textContent = remaining > 0
    ? `${Math.ceil(remaining / 1000)} 秒后检查`
    : '即将检查';
}

function renderMappings(mappings) {
  const list = $('#mapping-list');
  if (!Array.isArray(mappings) || mappings.length === 0) {
    list.innerHTML = '<div class="empty-state">还没有审查映射。新 MR 会由 watcher 直接创建审查线程。</div>';
    return;
  }

  list.innerHTML = mappings.map((mapping) => `
    <div class="mapping-row">
      <div class="mapping-key">
        <span class="mapping-badge">!${escapeHtml(mapping.mrIid)}</span>
        <strong title="${escapeHtml(mapping.project)}">${escapeHtml(mapping.project)}</strong>
      </div>
      <div class="mapping-thread">
        <code title="${escapeHtml(mapping.threadId)}">${escapeHtml(mapping.threadId)}</code>
      </div>
      <div class="row-actions">
        <button class="mini-btn" type="button" data-action="copy-thread" data-thread="${escapeHtml(mapping.threadId)}">复制</button>
        <button class="mini-btn danger" type="button" data-action="delete-mapping" data-key="${escapeHtml(mapping.key)}">删除</button>
      </div>
    </div>
  `).join('');
}

function renderAgents(agents) {
  const list = $('#agent-list');
  if (!Array.isArray(agents) || agents.length === 0) {
    list.innerHTML = '<div class="empty-state">还没有 agent 注册。使用 <code>npx @alanwalk/mr-watch register ...</code> 注册会话或 hook。</div>';
    return;
  }

  list.innerHTML = agents.map((agent, index) => {
    const role = agent.role === 'reviewer' ? 'reviewer' : 'developer';
    const label = agent.label || `${role} agent`;
    const projects = Array.isArray(agent.projects) && agent.projects.length > 0
      ? agent.projects.join(', ')
      : '全部项目';
    const mrIids = Array.isArray(agent.mrIids) && agent.mrIids.length > 0
      ? agent.mrIids.map((iid) => `!${iid}`).join(', ')
      : '全部 MR';
    const targetLabel = agent.threadId ? 'THREAD' : 'HOOK';
    const target = agent.threadId || agent.hookUrl || '-';
    return `
      <div class="agent-row" style="animation-delay:${Math.min(index * 40, 280)}ms">
        <div class="agent-main">
          <span class="agent-avatar">${role === 'reviewer' ? 'R' : 'D'}</span>
          <div>
            <strong>${escapeHtml(label)}</strong>
            <small>${escapeHtml(projects)} · ${escapeHtml(mrIids)}</small>
          </div>
        </div>
        <div class="agent-target">
          <span>${targetLabel}</span>
          <code title="${escapeHtml(target)}">${escapeHtml(target)}</code>
        </div>
        <div class="agent-side">
          <span class="agent-role ${role}">${role}</span>
          <small>${formatRelativeTime(agent.updatedAt || agent.createdAt)}</small>
        </div>
      </div>
    `;
  }).join('');
}

function renderAuth(auth) {
  const authStatus = auth || {};
  const authenticated = Boolean(authStatus.authenticated);
  const managedByEnvironment = Boolean(authStatus.managedByEnvironment);
  const environmentLocked = managedByEnvironment && authenticated;
  const remoteUrl = authStatus.webUrl || [
    authStatus.host,
    authStatus.project,
  ].filter(Boolean).join('/');
  const authBadge = $('#auth-badge');
  const authCard = $('#auth-status-card');
  const authVisual = $('#auth-visual');
  const authUser = $('#auth-user');
  const authSummary = $('#auth-summary');
  const authRemote = $('#auth-remote');
  const tokenSettingsLink = $('#token-settings-link');
  const tokenInput = $('#auth-token');
  const authSubmit = $('#auth-submit');

  authBadge.textContent = authenticated ? '已连接' : '待认证';
  authBadge.classList.toggle('connected', authenticated);
  authBadge.classList.toggle('waiting', !authenticated);
  authCard.classList.toggle('connected', authenticated);
  authVisual.classList.toggle('connected', authenticated);

  if (authenticated) {
    authUser.textContent = `@${authStatus.currentUser}`;
    if (managedByEnvironment) {
      authSummary.textContent = '当前使用环境变量 GITLAB_TOKEN；页面不改写环境变量。';
    } else if (authStatus.mode === 'glab') {
      authSummary.textContent = '当前使用本机 glab 登录态；粘贴 Token 后即可改为直连 GitLab API。';
    } else {
      authSummary.textContent = 'Token 已在本机保存，并通过 GitLab 用户接口验证。';
    }
  } else {
    authUser.textContent = '等待 GitLab 接入';
    authSummary.textContent = managedByEnvironment
      ? '环境变量 GITLAB_TOKEN 未能通过验证；可以粘贴新 Token 临时接入。'
      : '已从 workspace 的 origin remote 自动解析，无需再填写 GitLab 地址。';
  }

  authRemote.textContent = remoteUrl || '无法解析 origin remote';
  authRemote.title = remoteUrl || '';
  const tokenSettingsUrl = safeHttpUrl(authStatus.tokenSettingsUrl);
  tokenSettingsLink.href = tokenSettingsUrl || '#';
  tokenSettingsLink.classList.toggle('disabled', !tokenSettingsUrl);
  tokenSettingsLink.setAttribute('aria-disabled', tokenSettingsUrl ? 'false' : 'true');

  if (environmentLocked) {
    tokenInput.disabled = true;
    tokenInput.placeholder = '当前由 GITLAB_TOKEN 接管';
    authSubmit.disabled = true;
    authSubmit.textContent = '环境变量已接管';
  } else {
    tokenInput.disabled = false;
    tokenInput.placeholder = 'glpat-...';
    authSubmit.disabled = false;
    authSubmit.textContent = authenticated ? '更新 Token' : '保存并验证';
  }
}

function renderActive(activeMergeRequests) {
  const list = $('#active-list');
  if (!Array.isArray(activeMergeRequests) || activeMergeRequests.length === 0) {
    list.innerHTML = '<div class="empty-state">当前没有正在跟踪的 MR。等待下一轮轮询。</div>';
    return;
  }

  list.innerHTML = activeMergeRequests.map((mergeRequest, index) => {
    const pipeline = pipelineMeta(mergeRequest.pipelineStatus);
    const merge = mergeMeta(mergeRequest.mergeStatus);
    const safeWebUrl = safeUrl(mergeRequest.webUrl);
    const title = escapeHtml(mergeRequest.title || `MR !${mergeRequest.mrIid}`);
    const project = escapeHtml(mergeRequest.project);
    const author = escapeHtml(mergeRequest.author || 'unknown');
    const threadId = escapeHtml(mergeRequest.threadId || '未映射');
    const staleBadge = mergeRequest.isStale
      ? '<span class="status-chip stale">已停止更新</span>'
      : '';
    const titleMarkup = safeWebUrl
      ? `<a class="mr-link" href="${safeWebUrl}" target="_blank" rel="noreferrer">${title}</a>`
      : title;

    return `
      <article class="active-row" style="animation-delay:${Math.min(index * 45, 320)}ms">
        <div class="active-title">
          <span class="repo-dot">MR</span>
          <div>
            <strong>${titleMarkup}</strong>
            <small>${project}!${escapeHtml(mergeRequest.mrIid)} · ${author} · ${escapeHtml(shortSha(mergeRequest.headSha))}</small>
          </div>
        </div>
        <div class="meta-stack">
          <span>PIPELINE</span>
          <span class="status-chip ${pipeline.className}">${escapeHtml(pipeline.label)}</span>
          <span>MERGE</span>
          <span class="status-chip ${merge.className}">${escapeHtml(merge.label)}</span>
        </div>
        <div class="meta-stack">
          <span>THREAD</span>
          <strong class="thread-link" title="${threadId}">${threadId}</strong>
          <span>${escapeHtml(roleLabel(mergeRequest.role))} · ${formatRelativeTime(mergeRequest.lastSeenAt || mergeRequest.updatedAt)}</span>
        </div>
        <div class="active-actions">
          ${staleBadge}
          <button class="mini-btn" type="button" data-action="copy-thread" data-thread="${threadId}">复制线程</button>
        </div>
      </article>
    `;
  }).join('');
}

function filteredEvents(events) {
  if (dashboardState.historyFilter === 'all') {
    return events;
  }
  if (dashboardState.historyFilter === 'developer_notify') {
    return events.filter((event) => ['developer_notify', 'developer_manual'].includes(event.type));
  }
  return events.filter((event) => event.type === dashboardState.historyFilter);
}

function historyTarget(event) {
  const parts = [];
  if (event.project) {
    parts.push(event.project);
  }
  if (event.mrIid) {
    parts.push(`!${event.mrIid}`);
  }
  if (event.headSha) {
    parts.push(shortSha(event.headSha));
  }
  return parts.join(' · ');
}

function renderHistory(events) {
  const list = $('#history-list');
  const visibleEvents = filteredEvents(Array.isArray(events) ? events : []);

  if (visibleEvents.length === 0) {
    list.innerHTML = '<div class="empty-state">当前筛选下没有历史事件。</div>';
    return;
  }

  list.innerHTML = visibleEvents.map((event, index) => {
    const type = event.type || 'unknown';
    const target = historyTarget(event);
    const thread = event.threadId ? `→ ${shortThreadId(event.threadId)}` : '';
    const summary = escapeHtml(event.summary || '');
    return `
      <article class="history-item" style="animation-delay:${Math.min(index * 28, 350)}ms">
        <span class="history-icon ${escapeHtml(type)}">${eventIcon(type)}</span>
        <div class="history-body">
          <div class="history-title">
            <strong>${escapeHtml(eventLabel(type))}</strong>
            ${target ? `<span class="event-type">${escapeHtml(target)}</span>` : ''}
            ${thread ? `<span class="event-type">${escapeHtml(thread)}</span>` : ''}
          </div>
          <p>${summary}</p>
        </div>
        <time class="history-time" title="${escapeHtml(formatDateTime(event.timestamp))}">${formatRelativeTime(event.timestamp)}</time>
      </article>
    `;
  }).join('');
}

function renderDashboard(data) {
  dashboardState.data = data;
  const stats = data.stats || {};
  const status = data.status || {};
  const config = data.config || {};
  const projects = Array.isArray(config.projects) ? config.projects : [];
  const projectLabel = projects.length > 0 ? projects.join(', ') : '未配置项目';

  $('#project-pill').textContent = projectLabel;
  $('#flow-project').textContent = projects[0] || '未配置项目';
  $('#orbit-project').textContent = projects[0] || '未配置项目';
  $('#flow-thread-count').textContent = String(stats.mappingCount ?? 0);
  $('#orbit-review-count').textContent = `${stats.mappingCount ?? 0} mapped`;
  const appServerLabel = config.appServerUrl
    ? config.appServerUrl.replace(/^wss?:\/\//, '')
    : 'app server';
  $('#orbit-orchestrator').textContent = appServerLabel;
  $('#orbit-orchestrator').title = config.appServerUrl || '未配置 App Server';
  $('#active-badge').textContent = `${stats.activeCount ?? 0} 个`;
  $('#history-badge').textContent = `${stats.eventCount ?? 0} 条`;
  $('#agent-badge').textContent = `${stats.agentCount ?? 0} 个`;

  updateStatus(status, stats, data.auth);
  $$('[data-count]').forEach((element) => {
    animateCount(element, stats[element.dataset.count] ?? 0);
  });
  renderMappings(data.mappings);
  renderAgents(data.agents);
  renderAuth(data.auth);
  renderActive(data.activeMergeRequests);
  renderHistory(data.events);
  updateCountdown();

  const updatedAt = data.generatedAt || new Date().toISOString();
  $('#last-updated').textContent = `更新于 ${formatDateTime(updatedAt)}`;
}

async function refreshDashboard() {
  if (dashboardState.loading) {
    return;
  }

  dashboardState.loading = true;
  const refreshButton = $('#refresh-btn');
  refreshButton.style.transform = 'rotate(120deg)';

  try {
    const response = await fetch('/api/overview', { cache: 'no-store' });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    renderDashboard(await response.json());
  } catch (error) {
    showToast(`管理页读取失败：${error.message}`);
    const statusLabel = $('#sidebar-status');
    statusLabel.textContent = '连接失败';
    statusLabel.classList.add('error');
  } finally {
    dashboardState.loading = false;
    window.setTimeout(() => {
      refreshButton.style.transform = '';
    }, 220);
  }
}

async function copyText(text) {
  if (!text) {
    showToast('没有可复制的内容');
    return;
  }

  try {
    await navigator.clipboard.writeText(text);
    showToast('已复制到剪贴板');
  } catch {
    showToast(`复制失败：${text}`);
  }
}

async function submitMapping(event) {
  event.preventDefault();
  const key = $('#mapping-key').value.trim();
  const threadId = $('#mapping-thread').value.trim();
  if (!key || !threadId) {
    showToast('请填写分配键和 thread UUID');
    return;
  }

  try {
    const response = await fetch('/api/mappings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key, threadId }),
    });
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.error || `HTTP ${response.status}`);
    }
    renderDashboard(payload);
    $('#mapping-form').classList.remove('visible');
    $('#mapping-key').value = '';
    $('#mapping-thread').value = '';
    showToast('映射已保存，下一轮轮询生效');
  } catch (error) {
    showToast(`保存失败：${error.message}`);
  }
}

async function submitGitLabAuth(event) {
  event.preventDefault();
  const tokenInput = $('#auth-token');
  const authSubmit = $('#auth-submit');
  const token = tokenInput.value.trim();
  if (!token) {
    showToast('请先粘贴 GitLab Personal Access Token');
    tokenInput.focus();
    return;
  }

  authSubmit.disabled = true;
  authSubmit.textContent = '验证中...';

  try {
    const response = await fetch('/api/auth/gitlab', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.error || `HTTP ${response.status}`);
    }

    renderDashboard(payload);
    const currentUser = payload.currentUser || payload.auth?.currentUser || 'unknown';
    tokenInput.value = '';
    tokenInput.type = 'password';
    $('#toggle-token').textContent = '显示';
    showToast(`GitLab 已连接：@${currentUser}，即将开始检查 MR`);
  } catch (error) {
    showToast(`GitLab 认证失败：${error.message}`);
    if (dashboardState.data?.auth) {
      renderAuth(dashboardState.data.auth);
    }
  }
}

function toggleAuthTokenVisibility() {
  const tokenInput = $('#auth-token');
  const toggleButton = $('#toggle-token');
  const shouldShow = tokenInput.type === 'password';
  tokenInput.type = shouldShow ? 'text' : 'password';
  toggleButton.textContent = shouldShow ? '隐藏' : '显示';
}

async function deleteMapping(key) {
  if (!window.confirm(`删除映射 ${key}？`)) {
    return;
  }

  try {
    const response = await fetch(`/api/mappings?key=${encodeURIComponent(key)}`, {
      method: 'DELETE',
    });
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.error || `HTTP ${response.status}`);
    }
    renderDashboard(payload);
    showToast('映射已删除');
  } catch (error) {
    showToast(`删除失败：${error.message}`);
  }
}

function setHistoryFilter(filter) {
  dashboardState.historyFilter = filter;
  $$('.filter-btn').forEach((button) => {
    button.classList.toggle('active', button.dataset.filter === filter);
  });
  if (dashboardState.data) {
    renderHistory(dashboardState.data.events);
  }
}

function bindEvents() {
  $('#refresh-btn').addEventListener('click', refreshDashboard);
  $('#auth-form').addEventListener('submit', submitGitLabAuth);
  $('#toggle-token').addEventListener('click', toggleAuthTokenVisibility);
  $('#copy-auth-remote').addEventListener('click', () => {
    copyText($('#auth-remote').textContent);
  });

  $('#toggle-mapping-form').addEventListener('click', () => {
    const form = $('#mapping-form');
    form.classList.toggle('visible');
    if (form.classList.contains('visible')) {
      $('#mapping-key').focus();
    }
  });

  $('#cancel-mapping').addEventListener('click', () => {
    $('#mapping-form').classList.remove('visible');
  });

  $('#mapping-form').addEventListener('submit', submitMapping);

  $('#mapping-list').addEventListener('click', (event) => {
    const button = event.target.closest('button[data-action]');
    if (!button) {
      return;
    }
    if (button.dataset.action === 'copy-thread') {
      copyText(button.dataset.thread);
    }
    if (button.dataset.action === 'delete-mapping') {
      deleteMapping(button.dataset.key);
    }
  });

  $('#active-list').addEventListener('click', (event) => {
    const button = event.target.closest('button[data-action="copy-thread"]');
    if (button) {
      copyText(button.dataset.thread);
    }
  });

  $('#history-filters').addEventListener('click', (event) => {
    const button = event.target.closest('button[data-filter]');
    if (button) {
      setHistoryFilter(button.dataset.filter);
    }
  });

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      refreshDashboard();
    }
  });
}

function bindScrollSpy() {
  const sections = ['overview', 'allocations', 'active', 'agents', 'settings', 'history']
    .map((id) => document.getElementById(id))
    .filter(Boolean);
  if (!('IntersectionObserver' in window)) {
    return;
  }

  const observer = new IntersectionObserver((entries) => {
    const visible = entries
      .filter((entry) => entry.isIntersecting)
      .sort((left, right) => right.intersectionRatio - left.intersectionRatio)[0];
    if (!visible) {
      return;
    }
    $$('.nav-item').forEach((item) => {
      item.classList.toggle('active', item.getAttribute('href') === `#${visible.target.id}`);
    });
  }, {
    rootMargin: '-20% 0px -60% 0px',
    threshold: [0.1, 0.3, 0.6],
  });

  sections.forEach((section) => observer.observe(section));
}

function init() {
  bindEvents();
  bindScrollSpy();
  refreshDashboard();
  window.setInterval(refreshDashboard, 15_000);
  window.setInterval(updateCountdown, 1_000);
}

init();
