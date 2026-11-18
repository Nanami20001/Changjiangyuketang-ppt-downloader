'use strict';

const $ = (id) => document.getElementById(id);
const api = window.workspace;
const titles = { library: '课件工作台', downloads: '下载管理', history: '扫描记录', settings: '下载偏好' };
const jobLabels = {
  queued: '等待中', working: '导出中', paused: '已暂停', saving: '保存中',
  cancelled: '已取消', complete: '已保存', partial: '部分完成', failed: '失败'
};
const jobPriority = { working: 2, paused: 2, saving: 2, queued: 1 };
const timestamp = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' });
const priority = (job) => jobPriority[job.status] ?? 0;
const active = (job) => priority(job) > 0;
const keyOf = (course, lesson) => JSON.stringify([course.id, lesson.id]);
const lessonKeys = (courses) => new Set(courses.flatMap((course) => course.lessons.map((lesson) => keyOf(course, lesson))));
const countLessons = (courses) => courses.reduce((count, course) => count + course.lessons.length, 0);
const icon = (name) => `<svg class="icon" aria-hidden="true"><use href="#i-${name}"/></svg>`;
const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]
));

let state;
let view = 'library';
let filter = 'all';
let historyTime = null;
let noticeTimer;
let renderScheduled = false;
let jobMarkup;
const visible = new Map();
const selected = new Set();
const expanded = new Set();
const visibleKeys = () => [...visible.values()].flat();

function toast(message) {
  clearTimeout(noticeTimer);
  $('notice').textContent = message;
  $('notice').hidden = false;
  noticeTimer = setTimeout(() => { $('notice').hidden = true; }, 4500);
}

function empty(symbol, heading, description) {
  return `<div class="empty"><span class="metric-icon green">${icon(symbol)}</span><h3>${heading}</h3><p>${description}</p></div>`;
}

function showView(next) {
  if (!Object.hasOwn(titles, next)) return;
  view = next;
  for (const name of Object.keys(titles)) $(`view-${name}`).hidden = name !== view;
  for (const button of document.querySelectorAll('.nav-item')) {
    if (button.dataset.value === view) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  }
  $('section-name').textContent = titles[view];
  $('selection-bar').hidden = view !== 'library';
  $('workspace-content').scrollTop = 0;
  render();
}

function renderScan() {
  const { scan, history, courses, account } = state;
  const latest = history[0];
  const added = countLessons(latest?.added ?? []);
  const working = scan.status === 'working';
  $('library-caption').textContent = latest ? `上次扫描 ${timestamp.format(latest.time)}` :
    account === 'connected' ? '开始扫描，将雨课堂里的课程和课件同步到这里。' : '登录雨课堂后，即可扫描课程和课件。';
  $('scan-title').textContent = working ? '正在扫描课件' : '扫描课程课件';
  const details = {
    idle: '获取课程列表和新增课件',
    working: scan.total ? `${scan.done} / ${scan.total} 门 · ${scan.detail}` : scan.detail,
    failed: scan.detail,
    partial: `已扫描 ${scan.total - scan.skipped} 门课程，${scan.skipped} 门读取失败`,
    complete: `已扫描 ${scan.total} 门课程 · 新增 ${added} 个课件`
  };
  $('scan-detail').textContent = details[scan.status];
  const progress = $('scan-progress');
  progress.hidden = !working;
  progress.max = scan.total || 1;
  if (working && !scan.total) progress.removeAttribute('value');
  else progress.value = scan.done || 0;
  const button = $('scan-button');
  button.disabled = working;
  button.querySelector('span').textContent = working ? '扫描中' : latest ? '重新扫描' : '开始扫描';
  $('count-courses').textContent = courses.length;
  $('count-lessons').textContent = countLessons(courses);
  $('count-added').textContent = added;
}

function lessonRows(course, lessons, newKeys) {
  if (!lessons.length) return '<p class="row-empty">此课程暂无课件</p>';
  return lessons.map((lesson) => {
    const key = keyOf(course, lesson);
    return `<label class="lesson-row"><input type="checkbox" data-lesson="${escape(key)}">${icon('file')}
      <span class="lesson-name">${escape(lesson.title)}</span>
      ${newKeys.has(key) ? '<span class="tag new">新增</span>' : ''}
      <span class="tag">${escape(lesson.format.toUpperCase())}</span></label>`;
  }).join('');
}

function renderCourses() {
  const current = state.history.find((entry) => entry.time === historyTime);
  if (historyTime !== null && !current) historyTime = null;
  const added = current?.added ?? state.history[0]?.added ?? [];
  const source = current || filter === 'new' ? added : state.courses;
  const newKeys = lessonKeys(added);
  const available = current ? newKeys : lessonKeys(state.courses);
  for (const key of selected) if (!available.has(key)) selected.delete(key);
  const query = $('search').value.trim().toLocaleLowerCase();
  const matches = (value) => value.toLocaleLowerCase().includes(query);
  visible.clear();
  const groups = [];
  for (const course of source) {
    const courseMatch = !query || matches(`${course.title} ${course.group} ${course.teacher}`);
    const lessons = courseMatch ? course.lessons : course.lessons.filter((lesson) => matches(lesson.title));
    if (!courseMatch && !lessons.length) continue;
    const keys = lessons.map((lesson) => keyOf(course, lesson));
    visible.set(course.id, keys);
    const open = expanded.has(course.id) || Boolean(query);
    const meta = [course.group, course.teacher].filter(Boolean).map(escape).join(' · ');
    const count = keys.filter((key) => newKeys.has(key)).length;
    groups.push(`<div class="course-group"><div class="course-row">
      <input type="checkbox" data-course="${escape(course.id)}" aria-label="选择 ${escape(course.title)} 的课件" ${lessons.length ? '' : 'disabled'}>
      <button class="course-toggle" data-action="expand" data-value="${escape(course.id)}" aria-expanded="${open}">
        ${icon('chevron')}<span class="course-tile">${icon('book')}</span>
        <span class="course-text"><strong>${escape(course.title)}</strong>${meta ? `<small>${meta}</small>` : ''}</span>
        ${count ? `<span class="tag new">${count} 个新增</span>` : ''}<span class="subtle course-total">${lessons.length} 个课件</span>
      </button></div>${open ? `<div class="lesson-list">${lessonRows(course, lessons, newKeys)}</div>` : ''}</div>`);
  }

  $('list-title').textContent = current ? `新增课件 · ${timestamp.format(current.time)}` : '课程与课件';
  $('dismiss-history').hidden = !current;
  for (const button of document.querySelectorAll('[data-action="filter"]')) {
    button.setAttribute('aria-pressed', String(button.dataset.value === filter));
    button.disabled = Boolean(current);
  }
  let placeholder;
  if (query) placeholder = empty('search', '没有匹配的课件', '试试其他课程名或课件名称。');
  else if (filter === 'new' || current) placeholder = empty('clock', '没有新增课件', '扫描发现的新增课件会在这里显示。');
  else if (state.scan.status === 'working') placeholder = empty('scan', '正在扫描课程', '扫描完成后，课程和课件会显示在这里。');
  else if (state.history.length) placeholder = empty('book', '没有可查看的课程', '确认雨课堂中已加入课程后，再重新扫描。');
  else placeholder = empty('book', '课件库暂时为空', '点击「开始扫描」获取雨课堂中的课程。');

  $('course-list').innerHTML = groups.join('') || placeholder;
  syncSelection();
}

function checkState(input, keys) {
  const count = keys.filter((key) => selected.has(key)).length;
  input.checked = count > 0 && count === keys.length;
  input.indeterminate = count > 0 && count < keys.length;
}

function syncSelection() {
  const allVisible = visibleKeys();
  $('select-visible').disabled = !allVisible.length;
  checkState($('select-visible'), allVisible);
  for (const checkbox of document.querySelectorAll('[data-course]')) checkState(checkbox, visible.get(checkbox.dataset.course) ?? []);
  for (const checkbox of document.querySelectorAll('[data-lesson]')) checkbox.checked = selected.has(checkbox.dataset.lesson);
  $('selection-count').textContent = `已选 ${selected.size} 个课件`;
  $('clear-selection').hidden = !selected.size;
  $('download-button').disabled = !selected.size;
}

function renderJobs(waiting) {
  const jobs = [...state.jobs].sort((a, b) => priority(b) - priority(a) || b.time - a.time);
  $('jobs-active').textContent = waiting;
  $('jobs-complete').textContent = jobs.filter((job) => job.status === 'complete').length;
  $('jobs-issue').textContent = jobs.filter((job) => ['failed', 'partial'].includes(job.status)).length;
  $('jobs-summary').textContent = `${jobs.length} 个文件`;
  const markup = jobs.map((job) => {
    const status = Object.hasOwn(jobLabels, job.status) ? job.status : 'failed';
    const button = (action, label, style) => `<button class="button ${style} small" data-action="${action}" data-value="${escape(job.id)}">${label}</button>`;
    let controls = job.destination ? button('show-file', '定位文件', 'outline') : '';
    if (['failed', 'partial'].includes(status)) controls += button('retry', '重试', 'quiet');
    if (status === 'working') controls += button('pause', '暂停', 'outline');
    if (status === 'paused') controls += button('resume', '继续', 'outline');
    if (['working', 'paused'].includes(status)) controls += button('cancel', '取消', 'quiet');
    return `<div class="job-row"><span class="metric-icon ${status === 'complete' ? 'green' : 'blue'}">${icon('file')}</span>
      <div class="job-copy"><strong>${escape(job.lesson.title)}</strong><p></p>
      ${active(job) ? `<progress max="100" aria-label="${escape(job.lesson.title)}的导出进度"></progress>` : ''}</div>
      <span class="tag ${status}">${jobLabels[status]}</span>${controls ? `<div class="job-actions">${controls}</div>` : ''}</div>`;
  }).join('') || empty('download', '暂无下载任务', '在课件库勾选课件，然后点击「下载选中」。');
  const list = $('job-list');
  if (jobMarkup !== markup) {
    const focused = list.contains(document.activeElement) ? document.activeElement.dataset : null;
    list.innerHTML = markup;
    jobMarkup = markup;
    if (focused) {
      const buttons = [...list.querySelectorAll('button')].filter((button) => button.dataset.value === focused.value);
      (buttons.find((button) => button.dataset.action === focused.action) ?? buttons[0])?.focus({ preventScroll: true });
    }
  }
  for (const [index, job] of jobs.entries()) {
    const row = list.children[index];
    row.querySelector('p').textContent = [job.courseTitle, job.status === 'paused' ? '' : job.detail].filter(Boolean).join(' · ');
    if (active(job)) row.querySelector('progress').value = Number(job.progress) || 0;
  }
}

function renderHistory() {
  $('history-summary').textContent = `${state.history.length} 次扫描`;
  $('history-list').innerHTML = state.history.map((entry) => {
    const added = countLessons(entry.added);
    return `<div class="history-row"><span class="metric-icon green">${icon('clock')}</span>
      <div class="history-copy"><strong>${escape(timestamp.format(entry.time))}</strong>
      <p>已扫描 ${entry.courseCount} 门课程 · 新增 ${added} 个课件${entry.errors.length ? ` · ${entry.errors.length} 门读取失败` : ''}</p></div>
      ${added ? `<button class="button outline small" data-action="history-entry" data-value="${Number(entry.time)}">查看新增</button>` : ''}</div>`;
  }).join('') || empty('clock', '暂无扫描记录', '完成第一次扫描后，结果会在这里保存。');
}

function render() {
  if (!state) return;
  const labels = { connected: '雨课堂已连接', checking: '正在检查连接', 'signed-out': '登录雨课堂', unavailable: '重新连接雨课堂' };
  $('account-text').textContent = labels[state.account];
  $('account-dot').className = `account-dot ${state.account}`;
  const waiting = state.jobs.filter(active).length;
  $('nav-count').hidden = !waiting;
  $('nav-count').textContent = waiting;
  if (view === 'library') { renderScan(); renderCourses(); }
  if (view === 'downloads') renderJobs(waiting);
  if (view === 'history') renderHistory();
  if (view === 'settings') {
    $('directory-path').textContent = state.preferences.directory;
    $('directory-path').title = state.preferences.directory;
    $('reset-folder').hidden = !state.preferences.customDirectory;
    $('categorize').checked = state.preferences.categorize;
  }
}

function snapshot(data) {
  state = data;
  if (renderScheduled) return;
  renderScheduled = true;
  requestAnimationFrame(() => { renderScheduled = false; render(); });
}

function updateSelection(keys, checked) {
  for (const key of keys) checked ? selected.add(key) : selected.delete(key);
  syncSelection();
}

const actions = {
  view: showView,
  login: api.login,
  scan: api.scan,
  'open-folder': api.openFolder,
  'pick-folder': api.pickFolder,
  'reset-folder': api.resetFolder,
  'show-file': api.showFile,
  pause: api.pause,
  resume: api.resume,
  cancel: api.cancel,
  retry: api.retry,
  filter(value) {
    if (filter === value) return;
    filter = value;
    selected.clear();
    renderCourses();
  },
  expand(value) {
    if (expanded.has(value)) expanded.delete(value);
    else expanded.add(value);
    renderCourses();
    document.querySelector(`[data-action="expand"][data-value="${CSS.escape(value)}"]`)?.focus({ preventScroll: true });
  },
  'clear-selection'() { selected.clear(); syncSelection(); },
  'history-entry'(value) {
    historyTime = Number(value);
    filter = 'all';
    selected.clear();
    $('search').value = '';
    showView('library');
  },
  'clear-history-filter'() { historyTime = null; selected.clear(); renderCourses(); },
  async download() {
    if (!selected.size) return;
    $('download-button').disabled = true;
    try {
      const count = await api.download([...selected], historyTime);
      if (!count) return toast('所选课件已在下载队列中。');
      selected.clear();
      showView('downloads');
      toast(`已添加 ${count} 个下载任务`);
    } finally { syncSelection(); }
  }
};

document.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-action]');
  if (!button || !state) return;
  const action = actions[button.dataset.action];
  if (action) Promise.resolve().then(() => action(button.dataset.value)).catch(() => {
    toast(button.dataset.action === 'show-file' ? '文件可能已移动或删除。' : '操作失败，请稍后重试。');
  });
});
document.addEventListener('change', (event) => {
  const input = event.target;
  if (input.id === 'select-visible') updateSelection(visibleKeys(), input.checked);
  if (input.dataset.course) updateSelection(visible.get(input.dataset.course) ?? [], input.checked);
  if (input.dataset.lesson) updateSelection([input.dataset.lesson], input.checked);
  if (input.id === 'categorize') api.categorize(input.checked).catch(() => {
    input.checked = state.preferences.categorize;
    toast('无法保存设置。');
  });
});
$('search').addEventListener('input', () => { if (state) renderCourses(); });
api.onChange(snapshot);
api.state().then((initial) => { if (!state) snapshot(initial); }).catch(() => toast('无法加载课件库，请重新打开软件。'));
