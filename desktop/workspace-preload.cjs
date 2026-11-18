'use strict';

const { contextBridge, ipcRenderer } = require('electron');
const invoke = (name) => (...args) => ipcRenderer.invoke(`workspace:${name}`, ...args);

contextBridge.exposeInMainWorld('workspace', {
  state: invoke('state'),
  onChange(callback) { ipcRenderer.on('workspace:change', (_event, data) => callback(data)); },
  login: invoke('login'),
  scan: invoke('scan'),
  download: invoke('download'),
  pause: invoke('pause'),
  resume: invoke('resume'),
  cancel: invoke('cancel'),
  retry: invoke('retry'),
  showFile: invoke('show-file'),
  openFolder: invoke('open-folder'),
  pickFolder: invoke('pick-folder'),
  resetFolder: invoke('reset-folder'),
  categorize: invoke('categorize')
});
