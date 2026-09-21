const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // settings window
  getState: () => ipcRenderer.invoke('settings:get'),
  setSettings: (partial) => ipcRenderer.invoke('settings:set', partial),
  captureStart: () => ipcRenderer.invoke('shortcut:capture:start'),
  captureCancel: () => ipcRenderer.invoke('shortcut:capture:cancel'),
  onCaptureEvent: (fn) => ipcRenderer.on('shortcut:capture:event', (_e, ev) => fn(ev)),
  chordStart: () => ipcRenderer.invoke('chord:capture:start'),
  chordStop: () => ipcRenderer.invoke('chord:capture:stop'),
  onChordEvent: (fn) => ipcRenderer.on('chord:capture:event', (_e, ev) => fn(ev)),
  onState: (fn) => ipcRenderer.on('state', (_e, s) => fn(s)),
  onSettingsChanged: (fn) => ipcRenderer.on('settings-changed', (_e, p) => fn(p)),
  onTranscription: (fn) => ipcRenderer.on('transcription', (_e, t) => fn(t)),
  copyText: (text) => ipcRenderer.invoke('clipboard:write', text),
  clearHistory: () => ipcRenderer.invoke('history:clear'),
  requestPermission: () => ipcRenderer.invoke('platform:request-permission'),

  // overlay window
  onOverlayCmd: (fn) => ipcRenderer.on('overlay:cmd', (_e, c) => fn(c)),
  // The three beats of a drag: 'start', 'move', 'end'. Whether the pill is
  // taking clicks at all is main's business — it watches the pointer itself.
  overlayDrag: (phase) => ipcRenderer.send('overlay:drag', phase),
  sendAudio: (buffer, duration, cancelled, error) =>
    ipcRenderer.send('overlay:audio', { buffer, duration, cancelled, error }),
  sendPcm: (buffer) => ipcRenderer.send('overlay:pcm', buffer),
});
