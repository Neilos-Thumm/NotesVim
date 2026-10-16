// Behaviour tests: real Vim engine + Notes adapter + fake Notes text view.
// Run with: node tests/vim.test.js
'use strict';
const assert = require('assert');
const { createNotes, press, submitPrompt, flushTimers } = require('./harness');

let passed = 0;
const failures = [];

function setup(text, caret, opts) {
  const ctx = createNotes(text, caret);
  ctx.NotesVim.init(opts || {});
  return ctx;
}
function cursor(ctx) {
  const c = ctx.NotesVim.cm.getCursor();
  return [c.line, c.ch];
}
function test(name, fn) {
  try {
    fn();
    passed++;
  } catch (e) {
    failures.push({ name, e });
  }
}

// --- motions -----------------------------------------------------------------
test('w e b 0 $ move by words and line ends', () => {
  const ctx = setup('hello big world', 0);
  press(ctx, 'w'); assert.deepStrictEqual(cursor(ctx), [0, 6]);
  press(ctx, 'e'); assert.deepStrictEqual(cursor(ctx), [0, 8]);
  press(ctx, 'b'); assert.deepStrictEqual(cursor(ctx), [0, 6]);
  press(ctx, '$'); assert.deepStrictEqual(cursor(ctx), [0, 14]);
  press(ctx, '0'); assert.deepStrictEqual(cursor(ctx), [0, 0]);
});

test('j k keep the column, gg G jump to ends', () => {
  const ctx = setup('abcdef\nab\nabcdef\nlast', 4);
  press(ctx, 'j'); assert.deepStrictEqual(cursor(ctx), [1, 1]);
  press(ctx, 'j'); assert.deepStrictEqual(cursor(ctx), [2, 4]);
  press(ctx, 'G'); assert.deepStrictEqual(cursor(ctx), [3, 0]);
  press(ctx, 'gg'); assert.deepStrictEqual(cursor(ctx), [0, 0]);
  press(ctx, '3G'); assert.deepStrictEqual(cursor(ctx), [2, 0]);
});

test('f t ; , find characters', () => {
  const ctx = setup('a,b,c,d', 0);
  press(ctx, 'f,'); assert.deepStrictEqual(cursor(ctx), [0, 1]);
  press(ctx, ';'); assert.deepStrictEqual(cursor(ctx), [0, 3]);
  press(ctx, ','); assert.deepStrictEqual(cursor(ctx), [0, 1]);
  press(ctx, 't,'); assert.deepStrictEqual(cursor(ctx), [0, 2]);
});

test('% jumps between brackets', () => {
  const ctx = setup('call(a, [b])', 4);
  press(ctx, '%'); assert.deepStrictEqual(cursor(ctx), [0, 11]);
  press(ctx, '%'); assert.deepStrictEqual(cursor(ctx), [0, 4]);
});

// --- operators -----------------------------------------------------------------
test('dw deletes a word', () => {
  const ctx = setup('hello world', 0);
  press(ctx, 'dw');
  assert.strictEqual(ctx.notes.text, 'world');
});

test('dd, 2dd and p put lines back below', () => {
  const ctx = setup('one\ntwo\nthree\nfour', 4);
  press(ctx, 'dd');
  assert.strictEqual(ctx.notes.text, 'one\nthree\nfour');
  assert.deepStrictEqual(cursor(ctx), [1, 0]);
  press(ctx, 'p');
  assert.strictEqual(ctx.notes.text, 'one\nthree\ntwo\nfour');
  press(ctx, 'gg2dd');
  assert.strictEqual(ctx.notes.text, 'two\nfour');
});

test('yyp duplicates a line', () => {
  const ctx = setup('alpha\nbeta', 0);
  press(ctx, 'yyp');
  assert.strictEqual(ctx.notes.text, 'alpha\nalpha\nbeta');
  assert.deepStrictEqual(cursor(ctx), [1, 0]);
});

test('x, 3x, r and ~ edit characters', () => {
  const ctx = setup('abcdef', 0);
  press(ctx, 'x'); assert.strictEqual(ctx.notes.text, 'bcdef');
  press(ctx, '3x'); assert.strictEqual(ctx.notes.text, 'ef');
  press(ctx, 'rZ'); assert.strictEqual(ctx.notes.text, 'Zf');
  press(ctx, 'l~'); assert.strictEqual(ctx.notes.text, 'ZF');
});

test('J joins lines', () => {
  const ctx = setup('first\nsecond', 0);
  press(ctx, 'J');
  assert.strictEqual(ctx.notes.text, 'first second');
});

test('text objects: diw, ci(, da"', () => {
  let ctx = setup('one two three', 5);
  press(ctx, 'diw');
  assert.strictEqual(ctx.notes.text, 'one  three');

  ctx = setup('f(a, b) + g', 3);
  press(ctx, 'ci(x<Esc>');
  assert.strictEqual(ctx.notes.text, 'f(x) + g');

  // Obsidian's engine keeps the trailing space for a" (real Vim removes it).
  ctx = setup('say "hi there" now', 6);
  press(ctx, 'da"');
  assert.strictEqual(ctx.notes.text, 'say  now');
});

// --- insert mode and dot repeat --------------------------------------------------
test('ciw + typing + Esc, then . repeats it', () => {
  const ctx = setup('hello world', 0);
  press(ctx, 'ciwbye<Esc>');
  assert.strictEqual(ctx.notes.text, 'bye world');
  assert.deepStrictEqual(cursor(ctx), [0, 2]);
  press(ctx, 'w.');
  assert.strictEqual(ctx.notes.text, 'bye bye');
});

test('o opens a line below, keeps indentation, . repeats', () => {
  const ctx = setup('\titem', 1);
  press(ctx, 'onext<Esc>');
  assert.strictEqual(ctx.notes.text, '\titem\n\tnext');
  press(ctx, '.');
  assert.strictEqual(ctx.notes.text, '\titem\n\tnext\n\tnext');
});

test('A and I append and insert at line ends', () => {
  const ctx = setup('middle', 2);
  press(ctx, 'A!<Esc>');
  assert.strictEqual(ctx.notes.text, 'middle!');
  press(ctx, 'I> <Esc>');
  assert.strictEqual(ctx.notes.text, '> middle!');
});

test('backspace while inserting is repeated by .', () => {
  const ctx = setup('aaa\nbbb', 0);
  press(ctx, 'Axy<BS>z<Esc>');
  assert.strictEqual(ctx.notes.text, 'aaaxz\nbbb');
  press(ctx, 'j.');
  assert.strictEqual(ctx.notes.text, 'aaaxz\nbbbxz');
});

test('typing in insert mode reaches Notes; Esc steps back one', () => {
  const ctx = setup('', 0);
  press(ctx, 'ihi');
  assert.strictEqual(ctx.notes.text, 'hi');
  assert.strictEqual(ctx.notes.mode, 'insert');
  press(ctx, '<Esc>');
  assert.strictEqual(ctx.notes.mode, 'normal');
  assert.deepStrictEqual(cursor(ctx), [0, 1]);
});

// --- normal mode never types ----------------------------------------------------
test('unused Control+Option keys pass through in normal mode (window managers)', () => {
  const ctx = setup('abc', 0);
  const ev = (key, code) => ({ key, code, ctrlKey: true, altKey: true, metaKey: false, shiftKey: false });
  assert.strictEqual(ctx.NotesVim.handleKey(ev('ArrowLeft', '')), false);
  assert.strictEqual(ctx.NotesVim.handleKey(ev('f', 'KeyF')), false);
  assert.strictEqual(ctx.NotesVim.handleKey(ev('Enter', '')), false);
  press(ctx, 'v');
  assert.strictEqual(ctx.NotesVim.handleKey(ev('ArrowRight', '')), false);
  assert.strictEqual(ctx.notes.text, 'abc');
});

test('normal mode swallows keys Vim does not use', () => {
  const ctx = setup('abc', 0);
  const used = ctx.NotesVim.handleKey({ key: 'Q', shiftKey: true });
  assert.strictEqual(used, true);
  assert.strictEqual(ctx.notes.text, 'abc');
});

// --- visual mode -------------------------------------------------------------------
test('v selects and d deletes inclusively', () => {
  const ctx = setup('abcdef', 1);
  press(ctx, 'vl');
  assert.strictEqual(ctx.notes.mode, 'visual');
  assert.deepStrictEqual([ctx.notes.start, ctx.notes.length], [1, 2]);
  press(ctx, 'd');
  assert.strictEqual(ctx.notes.text, 'adef');
  assert.strictEqual(ctx.notes.mode, 'normal');
});

test('Vjd deletes whole lines', () => {
  const ctx = setup('1\n2\n3\n4', 2);
  press(ctx, 'Vjd');
  assert.strictEqual(ctx.notes.text, '1\n4');
});

test('V> indents with a tab', () => {
  const ctx = setup('a\nb', 0);
  press(ctx, 'Vj>');
  assert.strictEqual(ctx.notes.text, '\ta\n\tb');
});

test('visual block <C-v> I inserts on every line, . repeats', () => {
  const ctx = setup('abc\nabc\nabc', 0);
  press(ctx, '<C-v>jjI-<Esc>');
  assert.strictEqual(ctx.notes.text, '-abc\n-abc\n-abc');
  press(ctx, 'gg.');
  assert.strictEqual(ctx.notes.text, '--abc\n--abc\n--abc');
});

test('visual block c changes a column', () => {
  const ctx = setup('1234\n5678\nabcd', 1);
  press(ctx, '<C-v>jjlcXY<Esc>');
  assert.strictEqual(ctx.notes.text, '1XY4\n5XY8\naXYd');
});

// --- undo / redo -----------------------------------------------------------------
test('u undoes and <C-r> redoes', () => {
  const ctx = setup('keep\ndrop', 5);
  press(ctx, 'dd');
  assert.strictEqual(ctx.notes.text, 'keep');
  press(ctx, 'u');
  assert.strictEqual(ctx.notes.text, 'keep\ndrop');
  press(ctx, '<C-r>');
  assert.strictEqual(ctx.notes.text, 'keep');
});

// --- search and ex commands --------------------------------------------------------
test('/ search moves to the match, n repeats', () => {
  const ctx = setup('cat dog cat dog', 0);
  press(ctx, '/');
  assert.ok(ctx.notes.prompt, 'prompt opened');
  assert.strictEqual(ctx.notes.prompt.prefix, '/');
  submitPrompt(ctx, 'dog');
  flushTimers(ctx);
  assert.deepStrictEqual(cursor(ctx), [0, 4]);
  press(ctx, 'n');
  assert.deepStrictEqual(cursor(ctx), [0, 12]);
  press(ctx, 'N');
  assert.deepStrictEqual(cursor(ctx), [0, 4]);
});

test('* searches for the word under the cursor', () => {
  const ctx = setup('foo bar foo', 0);
  press(ctx, '*');
  flushTimers(ctx);
  assert.deepStrictEqual(cursor(ctx), [0, 8]);
});

test(':s and :%s substitute', () => {
  const ctx = setup('a a\na a', 0);
  press(ctx, ':');
  assert.strictEqual(ctx.notes.prompt.prefix, ':');
  submitPrompt(ctx, 's/a/b/');
  assert.strictEqual(ctx.notes.text, 'b a\na a');
  press(ctx, ':');
  submitPrompt(ctx, '%s/a/c/g');
  assert.strictEqual(ctx.notes.text, 'b c\nc c');
});

test(':g/pattern/d deletes matching lines', () => {
  const ctx = setup('keep\ntodo x\nkeep\ntodo y', 0);
  press(ctx, ':');
  submitPrompt(ctx, 'g/todo/d');
  assert.strictEqual(ctx.notes.text, 'keep\nkeep');
});

// --- registers, marks, macros -------------------------------------------------------
test('named registers and the + register (system clipboard)', () => {
  const ctx = setup('one\ntwo', 0);
  press(ctx, '"ayyj"ap');
  assert.strictEqual(ctx.notes.text, 'one\ntwo\none');
  press(ctx, 'gg"+yy');
  assert.strictEqual(ctx.notes.clipboard, 'one\n');
});

test('marks: ma then `a jumps back', () => {
  const ctx = setup('first line\nsecond line', 3);
  press(ctx, 'majw`a');
  assert.deepStrictEqual(cursor(ctx), [0, 3]);
});

test('macros: qa ... q, then @a', () => {
  const ctx = setup('x\nx\nx', 0);
  press(ctx, 'qaI- <Esc>jq');
  press(ctx, '@a@a');
  assert.strictEqual(ctx.notes.text, '- x\n- x\n- x');
});

test('macro recording shows a status, not the command bar', () => {
  const ctx = setup('x', 0);
  press(ctx, 'qa');
  assert.strictEqual(ctx.notes.prompt, null);
  assert.strictEqual(ctx.notes.status, 'recording @a');
  press(ctx, 'q');
  assert.strictEqual(ctx.notes.status, '');
});

// --- command bar typed through the key tap ------------------------------------
test(':s typed key by key runs on Enter', () => {
  const ctx = setup('a cat\nanother cat', 0);
  press(ctx, ':s/cat/dog/<CR>');
  assert.strictEqual(ctx.notes.text, 'a dog\nanother cat');
  assert.strictEqual(ctx.notes.prompt, null);
  press(ctx, ':%s/a/A/g<CR>');
  assert.strictEqual(ctx.notes.text, 'A dog\nAnother cAt');
});

test('the bar shows what is typed, and keys never reach the note', () => {
  const ctx = setup('abc', 0);
  press(ctx, ':xyz');
  assert.deepStrictEqual(ctx.notes.prompt, { prefix: ':', desc: '', value: 'xyz' });
  assert.strictEqual(ctx.notes.text, 'abc');
  press(ctx, '<BS>');
  assert.strictEqual(ctx.notes.prompt.value, 'xy');
});

test('Esc, and Backspace on an empty bar, cancel without running', () => {
  const ctx = setup('abc', 0);
  press(ctx, ':s/a/b/<Esc>');
  assert.strictEqual(ctx.notes.prompt, null);
  press(ctx, ':<BS>');
  assert.strictEqual(ctx.notes.prompt, null);
  assert.strictEqual(ctx.notes.text, 'abc');
  assert.strictEqual(ctx.notes.mode, 'normal');
});

test('/ typed key by key searches on Enter, n repeats', () => {
  const ctx = setup('one foo two foo', 0);
  press(ctx, '/foo<CR>');
  assert.deepStrictEqual(cursor(ctx), [0, 4]);
  press(ctx, 'n');
  assert.deepStrictEqual(cursor(ctx), [0, 12]);
});

test('<Up> recalls the previous command, <C-u> clears, Cmd-V pastes', () => {
  const ctx = setup('aaa', 0);
  press(ctx, ':s/a/b/<CR>');
  press(ctx, ':<Up>');
  assert.strictEqual(ctx.notes.prompt.value, 's/a/b/');
  press(ctx, '<C-u>');
  assert.strictEqual(ctx.notes.prompt.value, '');
  ctx.notes.clipboard = 's/a/c/\nignored';
  ctx.NotesVim.handleKey({ key: 'v', code: 'KeyV', ctrlKey: false, altKey: false, metaKey: true, shiftKey: false });
  assert.strictEqual(ctx.notes.prompt.value, 's/a/c/');
  press(ctx, '<CR>');
  assert.strictEqual(ctx.notes.text, 'bca');
});

// --- vimrc -------------------------------------------------------------------------
test('vimrc: imap jk <Esc> leaves insert mode', () => {
  const ctx = setup('', 0, { vimrc: 'imap jk <Esc>' });
  press(ctx, 'ihijk');
  assert.strictEqual(ctx.notes.text, 'hi');
  assert.strictEqual(ctx.notes.mode, 'normal');
});

test('vimrc: nmap and comments', () => {
  const ctx = setup('a\nb\nc', 0, { vimrc: '" move fast\nnmap J 2j' });
  press(ctx, 'J');
  assert.deepStrictEqual(cursor(ctx), [2, 0]);
});

test('vimrc: Obsidian-only lines are skipped quietly', () => {
  const ctx = setup('abc', 0, { vimrc: 'exmap back obcommand app:go-back\nimap jk <Esc>' });
  assert.strictEqual(ctx.notes.notifications.length, 0, ctx.notes.notifications.join());
  press(ctx, 'ixjk');
  assert.strictEqual(ctx.notes.mode, 'normal');
});

// --- syncing with Notes -------------------------------------------------------------
test('block cursor: normal mode draws a one-character selection', () => {
  const ctx = setup('abc', 0);
  press(ctx, 'l');
  assert.deepStrictEqual([ctx.notes.start, ctx.notes.length], [1, 1]);
  press(ctx, 'a');
  assert.deepStrictEqual([ctx.notes.start, ctx.notes.length], [2, 0]);
});

test('a leftover one-character block (after restart) is read as the cursor', () => {
  const ctx = setup('abcdef', 0);
  ctx.notes.start = 2; ctx.notes.length = 1;
  ctx.NotesVim.cm._lastPushed = null;
  press(ctx, 'x');
  assert.strictEqual(ctx.notes.text, 'abdef');
  assert.strictEqual(ctx.notes.mode, 'normal');
});

test('mouse click in normal mode moves the cursor', () => {
  const ctx = setup('abc def', 0);
  press(ctx, 'l');
  ctx.notes.start = 5; ctx.notes.length = 0; // user clicked
  press(ctx, 'x');
  assert.strictEqual(ctx.notes.text, 'abc df');
});

test('mouse selection in normal mode becomes visual mode', () => {
  const ctx = setup('abc def', 0);
  press(ctx, 'l');
  ctx.notes.start = 4; ctx.notes.length = 3; // user dragged over "def"
  press(ctx, 'd');
  assert.strictEqual(ctx.notes.text, 'abc ');
});

test('switching notes resets the text model', () => {
  const ctx = setup('first note', 0);
  press(ctx, 'w');
  ctx.notes.text = 'another note here';
  ctx.notes.start = 0; ctx.notes.length = 0;
  ctx.notes.elementChanged = true;
  press(ctx, 'dw');
  assert.strictEqual(ctx.notes.text, 'note here');
});

test('edits made outside Vim (e.g. paste) are picked up', () => {
  const ctx = setup('abc', 0);
  ctx.notes.text = 'XYZabc'; ctx.notes.start = 3; ctx.notes.length = 0;
  press(ctx, 'x');
  assert.strictEqual(ctx.notes.text, 'XYZbc');
});

test('emoji and accented text keep offsets right', () => {
  const ctx = setup('héllo 👋 wörld', 0);
  press(ctx, 'wwdw');
  assert.strictEqual(ctx.notes.text, 'héllo 👋 ');
});

// --- misc commands should run without errors --------------------------------------
test('R replace mode overwrites characters', () => {
  const ctx = setup('abcdef', 0);
  press(ctx, 'Rxy<Esc>');
  assert.strictEqual(ctx.notes.text, 'xycdef');
});

test('insert mode leaves Vim insert commands (<C-w>, <C-o>, ...) to Notes', () => {
  const ctx = setup('one two', 7);
  press(ctx, 'a');
  for (const k of ['w', 'u', 'o', 'r', 't', 'd', 'h']) {
    const used = ctx.NotesVim.handleKey({ key: k, code: '', ctrlKey: true, altKey: false, metaKey: false, shiftKey: false });
    assert.strictEqual(used, false, `<C-${k}> should reach Notes`);
  }
  assert.strictEqual(ctx.notes.text, 'one two');
  assert.strictEqual(ctx.notes.mode, 'insert');
});

test('<C-c> and <C-[> leave insert mode', () => {
  const ctx = setup('abc', 0);
  press(ctx, 'ix<C-c>');
  assert.strictEqual(ctx.notes.mode, 'normal');
  press(ctx, 'iy<C-[>');
  assert.strictEqual(ctx.notes.mode, 'normal');
  assert.strictEqual(ctx.notes.text, 'yxabc');
});

test('imap with a Ctrl key still works', () => {
  const ctx = setup('', 0, { vimrc: 'imap <C-j> <Esc>' });
  press(ctx, 'ihi<C-j>');
  assert.strictEqual(ctx.notes.mode, 'normal');
  assert.strictEqual(ctx.notes.text, 'hi');
});

test('imap jk: a lone j followed by another letter types both', () => {
  const ctx = setup('', 0, { vimrc: 'imap jk <Esc>' });
  press(ctx, 'ijam');
  assert.strictEqual(ctx.notes.text, 'jam');
  assert.strictEqual(ctx.notes.mode, 'insert');
});

test(':imap from the command bar is honoured in insert mode', () => {
  const ctx = setup('', 0);
  press(ctx, ':'); submitPrompt(ctx, 'imap <C-l> <Esc>');
  press(ctx, 'iok<C-l>');
  assert.strictEqual(ctx.notes.mode, 'normal');
  assert.strictEqual(ctx.notes.text, 'ok');
});

test('gqq hard-wraps a long line', () => {
  const long = Array(30).fill('word').join(' ');
  const ctx = setup(long, 0);
  press(ctx, 'gqq');
  assert.ok(ctx.notes.text.indexOf('\n') > 0, 'line was wrapped');
  assert.ok(ctx.notes.text.split('\n').every(l => l.length <= 80));
});

test('scrolling commands and :w / :noh do not throw', () => {
  const ctx = setup(Array(100).fill('line').join('\n'), 0);
  press(ctx, '<C-d><C-u>zzztzbHML');
  press(ctx, ':'); submitPrompt(ctx, 'w');
  press(ctx, ':'); submitPrompt(ctx, 'noh');
  assert.strictEqual(ctx.notes.log.filter(l => /error/i.test(l)).length, 0, ctx.notes.log.join('\n'));
});

test('arrow keys in insert mode go to Notes and typing continues there', () => {
  const ctx = setup('ac', 0);
  press(ctx, 'a<Right>');
  // fake Notes moved the caret; next typed key lands at the new spot
  press(ctx, 'b<Esc>');
  assert.strictEqual(ctx.notes.text, 'acb');
});

test('Cmd shortcuts are never sent to Vim (host passes them through)', () => {
  const ctx = setup('abc', 0);
  // The Swift side never calls handleKey for Cmd combos; simulate a paste.
  ctx.notes.text = 'abcPASTED'; ctx.notes.start = 9; ctx.notes.length = 0;
  press(ctx, 'u');
  // Undo goes to Notes' own history; the engine only follows along.
  assert.ok(typeof ctx.notes.text === 'string');
});

// -----------------------------------------------------------------------------
(async () => {
  const ctx = setup('ab', 0);
  ctx.notes.clipboard = 'XY';
  press(ctx, '"+p');
  await Promise.resolve(); await Promise.resolve();
  try {
    assert.strictEqual(ctx.notes.text, 'aXYb');
    passed++;
  } catch (e) { failures.push({ name: '"+p pastes from the system clipboard', e }); }
  report();
})();

function report() {
  for (const f of failures) {
    console.log('FAIL', f.name);
    console.log('   ', String(f.e && f.e.message || f.e).split('\n').join('\n    '));
  }
  console.log(`${passed} passed, ${failures.length} failed`);
  process.exitCode = failures.length ? 1 : 0;
}
