const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // settings window
  getState: () => ipcRenderer.invoke('settings:get'),
  setSettings: (partial) => ipcRenderer.invoke('settings:set', partial),
  captureStart: () => ipcRenderer.invoke('shortcut:capture:start'),
  captureCancel: () => ipcRenderer.invoke('shortcut:capture:cancel'),
  onCaptureEvent: (fn) => ipcRenderer.on('shortcut:capture:event', (_e, ev) => fn(ev)),
  onState: (fn) => ipcRenderer.on('state', (_e, s) => fn(s)),
  onTranscription: (fn) => ipcRenderer.on('transcription', (_e, t) => fn(t)),
  copyText: (text) => ipcRenderer.invoke('clipboard:write', text),
  requestPermission: () => ipcRenderer.invoke('platform:request-permission'),

  // overlay window
  onOverlayCmd: (fn) => ipcRenderer.on('overlay:cmd', (_e, c) => fn(c)),
  sendAudio: (buffer, duration, cancelled, error) =>
    ipcRenderer.send('overlay:audio', { buffer, duration, cancelled, error }),
});
