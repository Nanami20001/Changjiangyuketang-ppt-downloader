'use strict';

const { app, BrowserWindow, dialog, ipcMain, Menu, session, shell } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { connection, ORIGIN, PARTITION } = require('./services/classroom.cjs');
const { createDownloadQueue } = require('./services/download-queue.cjs');
const { exportLesson } = require('./services/downloads.cjs');
const { openLibrary, scanResult } = require('./services/library.cjs');

const isolated = { sandbox: true, nodeIntegration: false, contextIsolation: true };

function isLoginPage(address) {
  const url = URL.parse(address);
  return url?.protocol === 'https:' && !url.port && (
    url.hostname === 'yuketang.cn' || url.hostname.endsWith('.yuketang.cn') || url.hostname === 'open.weixin.qq.com'
  );
}

function restrictLogin(contents) {
  const check = (event) => {
    if (event.isMainFrame && !isLoginPage(event.url)) event.preventDefault();
  };
  contents.on('will-navigate', check);
  contents.on('will-redirect', check);
  contents.setWindowOpenHandler(({ url }) => isLoginPage(url)
    ? { action: 'allow', overrideBrowserWindowOptions: { webPreferences: isolated } }
    : { action: 'deny' });
  contents.on('did-create-window', (popup) => restrictLogin(popup.webContents));
}

function createWorkspace() {
  Menu.setApplicationMenu(null);
  const window = new BrowserWindow({
    width: 1200, height: 850, minWidth: 860, minHeight: 640,
    title: '长江雨课堂下载器', backgroundColor: '#f4f6f2',
    webPreferences: { ...isolated, preload: path.join(__dirname, 'workspace-preload.cjs') }
  });
  const contents = window.webContents;
  const browserSession = session.fromPartition(PARTITION);
  browserSession.setPermissionRequestHandler((_contents, _permission, respond) => respond(false));
  browserSession.setPermissionCheckHandler(() => false);
  browserSession.setUserAgent(browserSession.getUserAgent().replace(/\sElectron\/[^ ]+/g, ''));
  const api = connection(browserSession);
  const { data, save, update } = openLibrary(app.getPath('userData'));
  let account = 'checking';
  let scan = { status: 'idle' };
  let loginWindow;
  let loginCheck = 0;

  function preferences() {
    const customDirectory = typeof data.directory === 'string' && path.isAbsolute(data.directory);
    return {
      directory: customDirectory ? data.directory : app.getPath('downloads'),
      categorize: data.categorize, customDirectory
    };
  }

  function snapshot() {
    return { account, scan, courses: data.courses, history: data.history, jobs: data.jobs, preferences: preferences() };
  }

  function notify() {
    if (!contents.isDestroyed()) contents.send('workspace:change', snapshot());
  }

  function changeAccount(value) {
    account = value;
    notify();
  }

  async function verifyLogin() {
    const check = ++loginCheck;
    let status = 'signed-out';
    try {
      const cookies = await browserSession.cookies.get({ url: ORIGIN, name: 'sessionid' });
      if (cookies.length) {
        await api.courses();
        status = 'connected';
      }
    } catch (error) {
      status = error.code === 'LOGIN_REQUIRED' ? 'signed-out' : 'unavailable';
    }
    if (check !== loginCheck) return;
    changeAccount(status);
    if (status === 'connected' && loginWindow && !loginWindow.isDestroyed()) loginWindow.close();
  }

  function showLogin() {
    if (loginWindow && !loginWindow.isDestroyed()) {
      loginWindow.focus();
      return;
    }
    loginWindow = new BrowserWindow({
      parent: window, modal: true, width: 940, height: 690, minWidth: 670, minHeight: 500,
      title: '登录长江雨课堂', backgroundColor: '#ffffff', webPreferences: { ...isolated, session: browserSession }
    });
    restrictLogin(loginWindow.webContents);
    loginWindow.on('closed', () => { loginWindow = null; });
    loginWindow.loadURL(ORIGIN).catch((error) => {
      if (error.code !== 'ERR_ABORTED' && loginWindow && !loginWindow.isDestroyed()) {
        loginWindow.close();
        changeAccount('unavailable');
      }
    });
  }

  browserSession.cookies.on('changed', (_event, cookie) => {
    if (cookie.name === 'sessionid' && cookie.domain.endsWith('yuketang.cn')) void verifyLogin();
  });

  async function scanCourses() {
    if (scan.status === 'working') return;
    ++loginCheck;
    scan = { status: 'working', done: 0, total: 0, detail: '正在获取课程列表' };
    notify();
    try {
      const courses = await api.courses();
      account = 'connected';
      const successful = [];
      const errors = [];
      for (const [index, course] of courses.entries()) {
        scan = { status: 'working', done: index, total: courses.length, detail: course.title };
        notify();
        try {
          const lessons = await api.lessons(course);
          successful.push({ ...course, lessons });
        } catch (error) {
          if (error.code === 'LOGIN_REQUIRED') throw error;
          errors.push(course.title);
        }
        if (index < courses.length - 1) await delay(360);
      }
      const result = scanResult(data.courses, successful);
      const record = { time: Date.now(), courseCount: successful.length, added: result.added, errors };
      try { update({ courses: result.courses, history: [record, ...data.history].slice(0, 100) }); }
      catch (error) {
        console.error('保存扫描历史失败', error);
        throw new Error('无法保存扫描记录，请检查磁盘空间和权限。');
      }
      scan = { status: errors.length ? 'partial' : 'complete', done: courses.length, total: courses.length, skipped: errors.length };
    } catch (error) {
      if (error.code === 'LOGIN_REQUIRED') account = 'signed-out';
      scan = { status: 'failed', detail: error.message };
    }
    notify();
  }

  const queue = createDownloadQueue({
    data, save, onChange: notify,
    runExport: (job, progress, control) => exportLesson(api, job, preferences(), progress, control),
    onLoginRequired: () => { account = 'signed-out'; }
  });

  function updatePreferences(changes) {
    update(changes);
    notify();
  }

  function handle(name, callback) {
    ipcMain.handle(`workspace:${name}`, (event, ...args) => {
      if (event.sender !== contents || event.senderFrame !== contents.mainFrame) throw new Error('操作来源无效');
      return callback(...args);
    });
  }

  handle('state', snapshot);
  handle('login', showLogin);
  handle('scan', () => { void scanCourses(); });
  handle('download', queue.enqueue);
  handle('pause', queue.pause);
  handle('resume', queue.resume);
  handle('cancel', queue.cancel);
  handle('retry', queue.retry);
  handle('show-file', async (id) => {
    const job = data.jobs.find((entry) => entry.id === id);
    if (!job?.destination) return;
    await fs.access(job.destination);
    shell.showItemInFolder(job.destination);
  });
  handle('open-folder', async () => {
    const { directory } = preferences();
    await fs.mkdir(directory, { recursive: true });
    const message = await shell.openPath(directory);
    if (message) throw new Error('无法打开保存位置。');
  });
  handle('pick-folder', async () => {
    const selected = await dialog.showOpenDialog(window, {
      title: '选择课件保存位置', defaultPath: preferences().directory, properties: ['openDirectory', 'createDirectory']
    });
    if (!selected.canceled && selected.filePaths[0]) updatePreferences({ directory: selected.filePaths[0] });
  });
  handle('reset-folder', () => updatePreferences({ directory: null }));
  handle('categorize', (value) => updatePreferences({ categorize: value === true }));

  contents.on('will-navigate', (event) => event.preventDefault());
  contents.on('will-redirect', (event) => event.preventDefault());
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  void window.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  void verifyLogin();
  return window;
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  let workspace;
  app.setAppUserModelId('io.rainclassroom.downloader');
  app.whenReady().then(() => { workspace = createWorkspace(); });
  app.on('second-instance', () => {
    if (!workspace || workspace.isDestroyed()) return;
    if (workspace.isMinimized()) workspace.restore();
    workspace.focus();
  });
  app.on('window-all-closed', () => app.quit());
}
