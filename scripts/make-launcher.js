// Builds "Screen Prompt 2.exe", the double-click launcher, from
// launcher/launcher.cs. Windows only — everywhere else the shell script and
// the .desktop entry already cover starting the app.
//
// The compiler is the C# one that ships with the .NET Framework, present on
// every Windows since 8. That is the whole toolchain: no npm dependency, no
// SDK to install, and a real .exe at the end rather than a .vbs or a .bat with
// a console window attached to it.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SOURCE = path.join(ROOT, 'launcher', 'launcher.cs');
const ICON_PNG = path.join(ROOT, 'assets', 'icon.png');
const ICON_ICO = path.join(ROOT, 'launcher', 'icon.ico');
const OUT = path.join(ROOT, 'Screen Prompt 2.exe');

// Run from WSL as well as from Windows: the checkout is often the same one,
// and having to switch terminals to rebuild a launcher would be silly. Only
// the paths differ — the compiler invoked is the Windows one either way.
const WSL = process.platform === 'linux' && /microsoft/i.test(os.release());

if (process.platform !== 'win32' && !WSL) {
  console.error('The launcher is a Windows executable; nothing to build here.');
  process.exit(0);
}

const CSC = WSL
  ? '/mnt/c/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe'
  : path.join(process.env.WINDIR || 'C:\\Windows',
    'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');

if (!fs.existsSync(CSC)) {
  console.error(`No C# compiler at ${CSC}.`);
  console.error('It ships with the .NET Framework — turn "\.NET Framework 3.5/4.x"');
  console.error('on in Windows Features, or build the launcher on another machine.');
  process.exit(1);
}

// csc is a Windows program, so every path handed to it has to be a Windows
// path even when this script is the Linux node reading the same files.
function winPath(p) {
  if (!WSL) return p;
  return execFileSync('wslpath', ['-w', p], { encoding: 'utf8' }).trim();
}

// ---------------------------------------------------------------- the icon --

// A .ico is a directory of images, and since Vista an entry may simply be a
// PNG stored whole. So the app icon needs no conversion and no image library:
// it is copied in behind a 22-byte header.
function pngToIco(png) {
  if (png.readUInt32BE(0) !== 0x89504e47) {
    throw new Error(`${ICON_PNG} is not a PNG.`);
  }
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);

  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);          // reserved
  header.writeUInt16LE(1, 2);          // 1 = icon, 2 = cursor
  header.writeUInt16LE(1, 4);          // one image in the directory

  const entry = Buffer.alloc(16);
  entry.writeUInt8(width % 256, 0);    // 256 is stored as 0: one byte each
  entry.writeUInt8(height % 256, 1);
  entry.writeUInt8(0, 2);              // palette size, 0 for a true-colour image
  entry.writeUInt8(0, 3);              // reserved
  entry.writeUInt16LE(1, 4);           // colour planes
  entry.writeUInt16LE(32, 6);          // bits per pixel
  entry.writeUInt32LE(png.length, 8);
  entry.writeUInt32LE(header.length + entry.length, 12);  // where the PNG starts

  return Buffer.concat([header, entry, png]);
}

const args = ['/nologo', '/target:winexe', '/optimize+',
  '/reference:System.Windows.Forms.dll'];

if (fs.existsSync(ICON_PNG)) {
  fs.writeFileSync(ICON_ICO, pngToIco(fs.readFileSync(ICON_PNG)));
  args.push(`/win32icon:${winPath(ICON_ICO)}`);
} else {
  console.warn(`No ${ICON_PNG}; building without an icon.`);
}

// ----------------------------------------------------------- the compile --

// Overwriting a running exe fails with a sharing violation, and the launcher
// exits in milliseconds, so this only ever bites someone who double-clicked at
// the exact wrong moment. Say so plainly rather than dumping a CS2012 at them.
args.push(`/out:${winPath(OUT)}`, winPath(SOURCE));

try {
  execFileSync(CSC, args, { stdio: 'inherit' });
} catch (err) {
  console.error('\nCompiling the launcher failed.');
  if (fs.existsSync(OUT)) {
    console.error(`If "${path.basename(OUT)}" is open or running, close it and try again.`);
  }
  process.exit(1);
}

console.log(`\nBuilt ${OUT}`);
console.log('Double-click it to start the app; it lives in the tray from there.');
console.log('Right-click → Pin to taskbar / Send to → Desktop for a shortcut.');
