'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('vibes', {
  // folderId is a linked folder's id, or 'all' for the merged view.
  list: (folderId) => ipcRenderer.invoke('vibes:list', { folderId }),
  save: (bytes, mime, folderId) => ipcRenderer.invoke('vibes:save', { bytes, mime, folderId }),
  delete: (folderId, name) => ipcRenderer.invoke('vibes:delete', { folderId, name }),
  reveal: (folderId, name) => ipcRenderer.invoke('vibes:reveal', { folderId, name }),
  folders: {
    list: () => ipcRenderer.invoke('vibes:folders:list'),
    add: () => ipcRenderer.invoke('vibes:folders:add'),
    remove: (id) => ipcRenderer.invoke('vibes:folders:remove', { id }),
    setActive: (id) => ipcRenderer.invoke('vibes:folders:setActive', { id }),
  },
  collection: {
    // items: [{ folderId, name }]. Opens a save dialog, copies, links the result.
    createFolder: (items) => ipcRenderer.invoke('vibes:collection:createFolder', { items }),
    // Copies into an already-linked folder. No folder is created.
    copyTo: (items, folderId) =>
      ipcRenderer.invoke('vibes:collection:copyTo', { items, folderId }),
  },
  onChanged: (cb) => {
    const handler = () => cb();
    ipcRenderer.on('vibes:changed', handler);
    return () => ipcRenderer.off('vibes:changed', handler);
  },
});
