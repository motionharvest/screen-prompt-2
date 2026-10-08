// Turns a "Run a command" target and the spoken query into the argv to spawn.
//
// Two ways, chosen per platform:
//
//   shellArgv   macOS and Linux. The target is a /bin/sh script, so `&&`,
//               pipes, `~` and quotes work as they do in a terminal. The query
//               is never pasted into that script: it travels as the shell's
//               first positional parameter, and every %s becomes a reference
//               to it. The shell expands a parameter after it has parsed the
//               script, so an apostrophe, `&&` or `$(...)` in what you said is
//               only ever text. Each %s is written to suit the quoting it sits
//               in, so `say %s`, `say "about %s"` and `say 'about %s'` all
//               receive the query as the same, unsplit text.
//
//   splitArgs   Windows. cmd.exe expands variables before it parses, so it has
//               no equivalent of a parameter that stays text; the target is
//               split on spaces and spawned directly instead.

// Quote-aware split, so a command target can name a path with spaces.
function splitArgs(line) {
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(line)) !== null) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

function splitArgv(target, query) {
  return splitArgs(target).map((arg) => arg.replace(/%s/g, query));
}

// Inside double quotes the reference needs no quotes of its own; inside single
// quotes nothing expands, so the quote is closed, the parameter inserted in
// double quotes, and the quote reopened.
const REF = { plain: '"${1}"', double: '${1}', single: `'"\${1}"'` };

function shellScript(target) {
  let out = '';
  let state = 'plain';
  for (let i = 0; i < target.length; i++) {
    const c = target[i];
    if (c === '%' && target[i + 1] === 's') {
      out += REF[state];
      i++;
      continue;
    }
    out += c;
    if (state === 'single') {
      if (c === "'") state = 'plain';
    } else if (c === '\\' && i + 1 < target.length) {
      out += target[++i];           // an escaped character never changes state
    } else if (c === '"') {
      state = state === 'double' ? 'plain' : 'double';
    } else if (c === "'" && state === 'plain') {
      state = 'single';
    }
  }
  return out;
}

// `screen-prompt` is $0, the name the shell uses in its own error messages.
function shellArgv(target, query) {
  return ['/bin/sh', '-c', shellScript(target), 'screen-prompt', query];
}

module.exports = { splitArgs, splitArgv, shellScript, shellArgv };
