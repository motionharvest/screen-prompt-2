// Fills a keyword target's placeholders, and turns a "Run a command" target
// into the argv to spawn.
//
// Two placeholders, read in a single pass so a value that happens to contain
// one is never filled again:
//
//   %s   the query: the part of the sentence the action acts on, as chosen by
//        the intent model ("capital of Indiana")
//   %t   the transcript: the whole sentence exactly as it was said, with no
//        model choosing which words count
//
// A command is built one of two ways, chosen per platform:
//
//   shellArgv   macOS and Linux. The target is a /bin/sh script, so `&&`,
//               pipes, `~` and quotes work as they do in a terminal. The query
//               is never pasted into that script: it travels as the shell's
//               first positional parameter (the transcript as the second),
//               and every placeholder becomes a reference to it. The shell expands a parameter after it has parsed the
//               script, so an apostrophe, `&&` or `$(...)` in what you said is
//               only ever text. Each reference is written to suit the quoting
//               it sits in, so `say %s`, `say "about %s"` and `say 'about %s'` all
//               receive the query as the same, unsplit text.
//
//   splitArgs   Windows. cmd.exe expands variables before it parses, so it has
//               no equivalent of a parameter that stays text; the target is
//               split on spaces and spawned directly instead.

const PLACEHOLDER = /%([st])/g;

function fill(template, values) {
  return template.replace(PLACEHOLDER, (_, k) => values[k]);
}

function hasPlaceholder(template) {
  return /%[st]/.test(template);
}

// Quote-aware split, so a command target can name a path with spaces.
function splitArgs(line) {
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(line)) !== null) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

function splitArgv(target, query, transcript) {
  return splitArgs(target).map((arg) => fill(arg, { s: query, t: transcript }));
}

// Inside double quotes the reference needs no quotes of its own; inside single
// quotes nothing expands, so the quote is closed, the parameter inserted in
// double quotes, and the quote reopened.
const PARAM = { s: 1, t: 2 };
const REF = {
  plain: (n) => `"\${${n}}"`,
  double: (n) => `\${${n}}`,
  single: (n) => `'"\${${n}}"'`,
};

function shellScript(target) {
  let out = '';
  let state = 'plain';
  for (let i = 0; i < target.length; i++) {
    const c = target[i];
    if (c === '%' && PARAM[target[i + 1]]) {
      out += REF[state](PARAM[target[i + 1]]);
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
function shellArgv(target, query, transcript) {
  return ['/bin/sh', '-c', shellScript(target), 'screen-prompt', query, transcript];
}

module.exports = { fill, hasPlaceholder, splitArgs, splitArgv, shellScript, shellArgv };
