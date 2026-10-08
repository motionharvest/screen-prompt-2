const assert = require('assert');
const { spawnSync } = require('child_process');
const { splitArgs, splitArgv, shellArgv } = require('./command');

let failed = 0;
const check = (label, fn) => {
  try { fn(); }
  catch (err) {
    failed++;
    console.error(`FAIL  ${label}`);
    console.error(`      ${err.message}`);
  }
};

// Runs the target through the real shell. `p` prints each argument it receives
// on its own line between brackets, so splitting would show. Its format lives
// in $FMT because a %s written in a target is the query.
const run = (target, query) => {
  const argv = shellArgv(`p() { printf "$FMT" "$@"; }; ${target}`, query);
  const out = spawnSync(argv[0], argv.slice(1),
    { encoding: 'utf8', env: { ...process.env, FMT: '[%s]\\n' } });
  return out.stdout;
};

const NASTY = `it's "fine" && rm -rf ~ ; $(whoami) \`id\` $HOME * \\`;

check('splitting keeps quoted words together', () => {
  assert.deepStrictEqual(splitArgs('"C:\\Program Files\\a.exe" -x %s'),
    ['C:\\Program Files\\a.exe', '-x', '%s']);
});

check('a split target gets the query as one argument', () => {
  assert.deepStrictEqual(splitArgv('notepad.exe %s', 'capital of Indiana'),
    ['notepad.exe', 'capital of Indiana']);
});

if (process.platform !== 'win32') {
  check('a bare %s is one argument, however many words', () => {
    assert.strictEqual(run("p %s", 'capital of Indiana'),
      '[capital of Indiana]\n');
  });

  check('%s inside double quotes joins the surrounding text', () => {
    assert.strictEqual(run(`p "answer: %s."`, 'two words'),
      '[answer: two words.]\n');
  });

  check('%s inside single quotes still becomes the query', () => {
    assert.strictEqual(run("echo 'about %s here'", 'two words'),
      'about two words here\n');
  });

  check('&& runs the second command after the first', () => {
    assert.strictEqual(run('echo one %s && echo two', 'x'), 'one x\ntwo\n');
  });

  check('nothing in the query is read as shell, in any quoting', () => {
    const want = `[${NASTY}]\n`;
    assert.strictEqual(run("p %s", NASTY), want);
    assert.strictEqual(run(`p "%s"`, NASTY), want);
    assert.strictEqual(run(`p '%s'`, NASTY), want);
  });

  check('an escaped quote does not change what %s sits in', () => {
    assert.strictEqual(run(`echo "say \\"%s\\""`, 'hi'), 'say "hi"\n');
  });

  check('a target without %s still runs', () => {
    assert.strictEqual(run('echo plain', 'ignored'), 'plain\n');
  });
}

if (failed) {
  console.error(`\n${failed} command test(s) failed`);
  process.exit(1);
}
console.log('command: all tests passed');
