'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('api', {
  transcribe: (opts) => ipcRenderer.invoke('transcribe', opts),
  openFolder: (folderPath) => ipcRenderer.invoke('openFolder', folderPath),
  openFilePicker: () => ipcRenderer.invoke('openFilePicker'),
  getPathForFile: (file) => webUtils.getPathForFile(file),
  readFile:   (filePath) => ipcRenderer.invoke('readFile', filePath),
  saveFile:   (opts) => ipcRenderer.invoke('saveFile', opts),
  exportPdf:  (opts) => ipcRenderer.invoke('exportPdf', opts),

  onProgress: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('progress', handler);
    return () => ipcRenderer.removeListener('progress', handler);
  },

  onTitle: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('title', handler);
    return () => ipcRenderer.removeListener('title', handler);
  },

  onDone: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('done', handler);
    return () => ipcRenderer.removeListener('done', handler);
  },

  onError: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('error', handler);
    return () => ipcRenderer.removeListener('error', handler);
  },
});
