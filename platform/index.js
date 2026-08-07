// Per-OS implementations of the few things this app cannot do portably.
//
// Most of the pipeline already runs anywhere: uiohook-napi ships prebuilt
// binaries for all three platforms, the mic capture and tones are Web Audio,
// and the ASR sidecar is plain Python. What is left needs an OS-specific
// answer, and it is only this:
//
//   pythonPath   the virtualenv puts the interpreter in a different place
//   paste        synthesising Ctrl+V / Cmd+V into someone else's window
//   ducking      turning other apps down uses a different audio stack
//   autostart    login items are a registry key, a plist, or a .desktop file
//
// Adding a platform means adding one file here and nothing else. Each adapter
// exports the same shape; `capabilities()` is how the UI asks what is missing
// on this machine rather than assuming everything works.

const SUPPORTED = new Set(['win32', 'darwin', 'linux']);

// Other Unixes (FreeBSD, OpenBSD) use the same tools as Linux — X11, PulseAudio
// or PipeWire, XDG autostart — so they get that adapter. Untested, not refused.
const key = SUPPORTED.has(process.platform) ? process.platform : 'linux';

const impl = require(`./${key}`);

module.exports = impl;
module.exports.untested = !SUPPORTED.has(process.platform);
