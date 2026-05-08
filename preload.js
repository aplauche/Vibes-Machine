'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('vibes', {
  list: () => ipcRenderer.invoke('vibes:list'),
  save: (bytes, mime) => ipcRenderer.invoke('vibes:save', { bytes, mime }),
  delete: (name) => ipcRenderer.invoke('vibes:delete', { name }),
  reveal: (name) => ipcRenderer.invoke('vibes:reveal', { name }),
  settings: {
    get: () => ipcRenderer.invoke('vibes:settings:get'),
    pickDir: () => ipcRenderer.invoke('vibes:settings:pickDir'),
  },
  onChanged: (cb) => {
    const handler = () => cb();
    ipcRenderer.on('vibes:changed', handler);
    return () => ipcRenderer.off('vibes:changed', handler);
  },
});
