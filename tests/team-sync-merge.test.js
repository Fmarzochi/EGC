/**
 * Team sync merge by section (#2055): two copies of one state document merge
 * section by section, following the AMI merge semantics, instead of the newer
 * file replacing the older one whole. Entries both machines added between two
 * syncs survive, the caps hold, an entry one machine dropped stays out until
 * it is added again, and the result is the same whichever side merges. Runs
 * against the built memory server modules; the walkthrough at the end drives
 * the `egc team` CLI and the server in two homes against one bare remote.
 */
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const { pathToFileURL } = require('url');

const { removeDirWithRetries } = require('./fixtures/remove-dir');
const { FULL_INSTALL_TIMEOUT_MS } = require('./fixtures/subprocess-timeouts');
const { suiteEnv } = require('./fixtures/suite-env');

const ROOT = path.join(__dirname, '..');
const BUILD = path.join(ROOT, 'mcp', 'servers', 'egc-memory', 'build');
const TEAM_CLI = path.join(ROOT, 'scripts', 'team.js');
const MEMORY_SERVER = path.join(BUILD, 'index.js');
const REMOTE_URL = 'https://github.com/Owner/Repo.git';
const BASE_ENV = suiteEnv(process.env);
// Fixed git locations before a PATH lookup.
const GIT_BIN = [
  '/usr/bin/git',
  '/usr/local/bin/git',
  '/opt/homebrew/bin/git',
  String.raw`C:\Program Files\Git\cmd\git.exe`,
].find(candidate => fs.existsSync(candidate)) || 'git';
const T = {
  ten: '2026-11-07T10:00:00.000Z',
  eleven: '2026-11-07T11:00:00.000Z',
  twelve: '2026-11-07T12:00:00.000Z',
  thirteen: '2026-11-07T13:00:00.000Z',
  longAgo: '2026-09-01T00:00:00.000Z',
};

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    return true;
  } catch (error) {
    console.log(`  ✗ ${name}`);
    console.log(`    Error: ${error.message}`);
    return false;
  }
}

function git(cwd, args, env = BASE_ENV) {
  return execFileSync(GIT_BIN, args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

// A checkout of the repository at `remoteUrl`, at the path a machine would
// hold it: two of these with the same remote under different paths stand
// for the two machines.
function makeCheckout(root, relativePath, remoteUrl) {
  const repo = path.join(root, relativePath);
  fs.mkdirSync(repo, { recursive: true });
  git(repo, ['init', '-q']);
  fs.writeFileSync(path.join(repo, 'README.md'), 'test repo\n');
  git(repo, ['add', 'README.md']);
  git(repo, ['-c', 'user.email=test@test', '-c', 'user.name=test', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'initial']);
  git(repo, ['checkout', '-q', '-B', 'main']);
  git(repo, ['remote', 'add', 'origin', remoteUrl]);
  return repo;
}

// A document as the versions before this change wrote it, by hand, so the
// tests do not depend on the serializer they also check.
function document({ project = '/home/dev/app', updated, retired, context = 'The app.', decisions = [], avoid = [], preferences = [], next = [] }) {
  const header = ['# Project State', `project: ${project}`, 'branch: main', 'author: dev', `updated: ${updated}`];
  if (retired) header.push(`retired: ${retired}`);
  const list = items => items.map(item => `- ${item}`);
  return [
    ...header, '',
    '## Context', context, '',
    '## Active Decisions', ...list(decisions), '',
    '## Do Not Repeat', ...list(avoid), '',
    '## Preferences', ...list(preferences), '',
    '## Next Session', ...list(next), '',
  ].join('\n');
}

function numbered(prefix, count) {
  return Array.from({ length: count }, (_, i) => `${prefix} ${i + 1}`);
}

async function runTests() {
  console.log('\n=== Testing team sync merge by section ===\n');
  // The skip is for a checkout without the build; a build that exists and
  // does not load is a failure of the suite, never a quiet pass.
  if (!fs.existsSync(path.join(BUILD, 'state-doc.js')) || !fs.existsSync(path.join(BUILD, 'sync', 'merge-sections.js'))) {
    console.error(`[SKIP] memory server build not found under ${BUILD}. Run 'npm run build' in mcp/servers/egc-memory first.`);
    process.exit(0);
  }
  const stateDoc = await import(pathToFileURL(path.join(BUILD, 'state-doc.js')).href);
  const mergeSections = await import(pathToFileURL(path.join(BUILD, 'sync', 'merge-sections.js')).href);
  const teamSync = await import(pathToFileURL(path.join(BUILD, 'sync', 'TeamSync.js')).href);
  const encryption = await import(pathToFileURL(path.join(BUILD, 'encryption.js')).href);
  const branchState = await import(pathToFileURL(path.join(BUILD, 'branch-state.js')).href);
  const envelope = await import(pathToFileURL(path.join(BUILD, 'sync', 'envelope.js')).href);
  // The moment of every merge in these tests, so the marks are predictable.
  const NOW = new Date(T.thirteen);
  const merge = (a, b, now = NOW) => mergeSections.mergeStateDocuments(a, b, now);
  const parse = stateDoc.parseStateDocument;
  const serialize = stateDoc.serializeStateDocument;
  const header = (doc, key) => stateDoc.headerValue(doc, key);
  const marksOf = doc => stateDoc.parseRetired(header(doc, 'retired'));
  const empty = parse('');
  const build = (input, existing = empty) => serialize(stateDoc.buildStateDocument({ projectPath: '/home/dev/app', branch: 'main', author: 'dev', ...input }, existing));

  let passed = 0;
  let failed = 0;
  const run = (name, fn) => {
    if (test(name, fn)) passed++; else failed++;
  };

  run('two documents with different decisions and the same context merge into one that holds both, newest first, the addition of the older side kept ahead of what both have', () => {
    const a = document({ updated: T.ten, decisions: ['A decided: because', 'shared: old'], preferences: ['tabs'] });
    const b = document({ updated: T.eleven, decisions: ['B decided: because', 'shared: old'], preferences: ['tabs', 'spaces'] });
    const merged = parse(merge(a, b));
    assert.deepStrictEqual(merged.sections['Active Decisions'], ['B decided: because', 'A decided: because', 'shared: old']);
    assert.deepStrictEqual(merged.sections['Preferences'], ['tabs', 'spaces'], 'the order of the newer copy is kept');
    const full = numbered('old', 14);
    const laptop = document({ updated: T.twelve, decisions: ['laptop: morning', ...full] });
    const desktop = document({ updated: T.thirteen, decisions: ['desktop: afternoon', ...full] });
    const day = parse(merge(laptop, desktop));
    assert.deepStrictEqual(day.sections['Active Decisions'], ['desktop: afternoon', 'laptop: morning', ...full.slice(0, 13)], 'a full document on each side keeps both additions and ages the shared tail');
    assert.deepStrictEqual(marksOf(day).map(m => m.hash), [stateDoc.entryHash('old 14')], 'the aged entry is retired, so neither stale copy brings it back');
    assert.deepStrictEqual(merged.sections['Context'], ['The app.']);
    assert.strictEqual(header(merged, 'updated'), T.eleven, 'the merged document is as new as the newer side');
    assert.strictEqual(header(merged, 'retired'), undefined, 'nothing was dropped, so nothing is retired');
  });

  run('the newer context replaces the older one, and a side with no context keeps the paragraph of the other', () => {
    const a = document({ updated: T.ten, context: 'Phase one.' });
    const b = document({ updated: T.eleven, context: 'Phase two.' });
    assert.deepStrictEqual(parse(merge(a, b)).sections['Context'], ['Phase two.']);
    const blank = document({ updated: T.twelve, context: '' });
    assert.deepStrictEqual(parse(merge(blank, b)).sections['Context'], ['Phase two.']);
  });

  run('the caps hold: 16 decisions and 11 things to avoid on each side give 15 and 10, the first by position, and what fell past the cap is retired', () => {
    const sixteen = numbered('decision', 16);
    const eleven = numbered('avoid', 11);
    const a = document({ updated: T.ten, decisions: sixteen, avoid: eleven });
    const b = document({ updated: T.eleven, decisions: sixteen, avoid: eleven });
    const merged = parse(merge(a, b));
    assert.deepStrictEqual(merged.sections['Active Decisions'], sixteen.slice(0, 15));
    assert.deepStrictEqual(merged.sections['Do Not Repeat'], eleven.slice(0, 10));
    const marks = marksOf(merged);
    assert.deepStrictEqual(marks.map(m => m.hash).sort(), [stateDoc.entryHash('decision 16'), stateDoc.entryHash('avoid 11')].sort());
    assert.ok(marks.every(m => m.at === T.thirteen), 'retired at the moment of the merge, not at the time of a copy');
    // The side that still carries the entry does not bring it back on top.
    const again = parse(merge(merge(a, b), b));
    assert.deepStrictEqual(again.sections['Active Decisions'], sixteen.slice(0, 15));
  });

  run('a partial document, a heading named like a property, and a section the merge does not know are kept, never lost to the layout', () => {
    const full = document({ updated: T.eleven, decisions: ['kept: yes'] });
    const partial = `# Project State\nupdated: ${T.ten}\n\n## Notes\n- keep me\n`;
    assert.strictEqual(merge(full, partial), full, 'a copy without the five sections leaves the newer copy whole');
    const newerPartial = `# Project State\nupdated: ${T.twelve}\n\n## Notes\n- keep me\n`;
    assert.strictEqual(merge(full, newerPartial), newerPartial, 'and whole when it is the newer one');
    const withExtra = `${document({ updated: T.twelve, decisions: ['kept: yes'] })}## __proto__\n- polluted\n\n## Scratch\n- note\n`;
    const parsed = parse(withExtra);
    assert.deepStrictEqual(parsed.sections['__proto__'], ['polluted'], 'a heading named like a property is one more section');
    assert.deepStrictEqual(parsed.sections['Scratch'], ['note']);
    assert.ok(!Object.prototype.hasOwnProperty.call({}, 'polluted'), 'and pollutes nothing');
    const merged = parse(merge(withExtra, full));
    assert.deepStrictEqual(merged.sections['Scratch'], ['note'], 'a section the merge does not know travels with the leading copy');
    assert.deepStrictEqual(merged.sections['__proto__'], ['polluted']);
    assert.ok(serialize(merged).includes('## Scratch\n- note'));
  });

  run('an entry removed on one side stays out of every copy that still carries it, whatever the time of that copy, and returns when a machine that knew the removal adds it again', () => {
    const mark = `${stateDoc.entryHash('E: gone')}@${T.eleven}`;
    const a = document({ updated: T.eleven, retired: mark, decisions: ['keep: yes'] });
    const stale = document({ updated: T.ten, decisions: ['E: gone', 'keep: yes'] });
    let merged = parse(merge(a, stale));
    assert.deepStrictEqual(merged.sections['Active Decisions'], ['keep: yes']);
    assert.deepStrictEqual(marksOf(merged), [{ hash: stateDoc.entryHash('E: gone'), at: T.eleven, kind: 'retired' }], 'the mark travels on with the document');
    const touchedLater = document({ updated: T.twelve, context: 'Only the context changed here.', decisions: ['E: gone', 'keep: yes'] });
    merged = parse(merge(a, touchedLater));
    assert.deepStrictEqual(merged.sections['Active Decisions'], ['keep: yes'], 'a copy written later that never saw the removal does not bring the entry back');
    assert.deepStrictEqual(merged.sections['Context'], ['Only the context changed here.']);
    const readded = build({ updated: T.twelve, decisions: [{ what: 'E', why: 'gone' }] }, parse(a));
    assert.deepStrictEqual(marksOf(parse(readded)), [{ hash: stateDoc.entryHash('E: gone'), at: T.twelve, kind: 'restored' }], 'a machine that holds the retirement records the return');
    merged = parse(merge(a, readded));
    assert.deepStrictEqual(merged.sections['Active Decisions'], ['E: gone', 'keep: yes'], 'added again by a machine that knew the removal, it is back everywhere');
    assert.strictEqual(marksOf(merged)[0].kind, 'restored');
  });

  run('a machine that replaced every decision is not undone by a machine that only touched the context later and still carries the old ones', () => {
    const old = numbered('old', 15);
    const fresh = numbered('fresh', 15);
    const marks = old.map(entry => `${stateDoc.entryHash(entry)}@${T.eleven}`).join(' ');
    const replaced = document({ updated: T.eleven, retired: marks, decisions: fresh });
    const contextOnly = document({ updated: T.twelve, context: 'New phase.', decisions: old });
    const merged = parse(merge(replaced, contextOnly));
    assert.deepStrictEqual(merged.sections['Active Decisions'], fresh, 'the fifteen fresh decisions stand and none of the retired ones is back');
    assert.deepStrictEqual(merged.sections['Context'], ['New phase.']);
    assert.strictEqual(marksOf(merged).length, 15, 'the retirements travel on');
    assert.strictEqual(merge(replaced, contextOnly), merge(contextOnly, replaced));
  });

  run('a mark that expired keeps nothing out in the merge where it expires, and the result of a merge of two copies of the same time leads over both afterwards', () => {
    const expired = `${stateDoc.entryHash('back: again')}@${T.longAgo}`;
    const a = document({ updated: T.eleven, retired: expired, decisions: ['keep: yes'] });
    const stale = document({ updated: T.ten, decisions: ['back: again', 'keep: yes'] });
    const merged = parse(merge(a, stale));
    assert.deepStrictEqual(merged.sections['Active Decisions'], ['back: again', 'keep: yes'], 'the entry is back in the same merge');
    assert.strictEqual(header(merged, 'retired'), undefined, 'the expired mark is gone');
    const left = document({ updated: T.eleven, decisions: ['left: one', 'shared: both'] });
    const right = document({ updated: T.eleven, context: 'Other.', decisions: ['right: one', 'shared: both'] });
    const result = merge(left, right);
    assert.strictEqual(merge(result, left), result, 'the fuller copy leads, so the result of a merge leads over the copies it came from');
    assert.strictEqual(merge(result, right), result);
    assert.strictEqual(merge(right, result), result);
  });

  run('retired marks expire after thirty days and are capped, so the list cannot grow without end', () => {
    const old = `${stateDoc.entryHash('ancient')}@${T.longAgo}`;
    const many = numbered('x', 50).map((entry, i) => `${stateDoc.entryHash(entry)}@2026-11-0${1 + (i % 6)}T00:00:00.000Z`).join(' ');
    const a = document({ updated: T.eleven, retired: `${old} ${many}` });
    const b = document({ updated: T.ten });
    const marks = marksOf(parse(merge(a, b)));
    assert.ok(!marks.some(m => m.hash === stateDoc.entryHash('ancient')), 'a mark older than the window is dropped');
    assert.strictEqual(marks.length, stateDoc.RETIRED_CAP);
    assert.ok(marks.every((m, i) => i === 0 || Date.parse(marks[i - 1].at) >= Date.parse(m.at)), 'newest first');
  });

  run('merging A with B equals merging B with A, merging A with A equals A, and merging the result with either side changes nothing', () => {
    const a = build({ updated: T.ten, context: 'ctx', decisions: [{ what: 'a1', why: 'ra' }], preferences: ['pa'], next: ['na'] });
    const b = build({ updated: T.eleven, context: 'ctx', decisions: [{ what: 'b1', why: 'rb' }], avoid: [{ what: 'bad', why: 'rb' }], next: ['nb'] });
    assert.strictEqual(merge(a, b), merge(b, a));
    assert.strictEqual(merge(a, a), a);
    assert.strictEqual(merge(b, b), b);
    const ab = merge(a, b);
    assert.strictEqual(merge(ab, b), ab);
    assert.strictEqual(merge(a, ab), ab);
    const sameTime = build({ updated: T.eleven, context: 'other', decisions: [{ what: 'c1' }] });
    assert.strictEqual(merge(b, sameTime), merge(sameTime, b), 'two documents of the same time merge the same way in either order');
  });

  run('Next Session comes from the newer side only, even when that side has none', () => {
    const a = document({ updated: T.ten, next: ['old plan'] });
    const b = document({ updated: T.eleven, next: ['new plan'] });
    assert.deepStrictEqual(parse(merge(a, b)).sections['Next Session'], ['new plan']);
    const none = document({ updated: T.twelve });
    assert.deepStrictEqual(parse(merge(none, b)).sections['Next Session'], []);
  });

  run('the writer keeps the layout the versions before wrote, dedupes, retires what the cap pushes out and clears the mark of an entry added again', () => {
    const existing = parse(document({ updated: T.ten, decisions: numbered('decision', 15) }));
    const written = parse(build({ updated: T.eleven, decisions: [{ what: 'decision 16' }, { what: 'decision 1' }] }, existing));
    assert.strictEqual(written.sections['Active Decisions'].length, 15);
    assert.deepStrictEqual(written.sections['Active Decisions'].slice(0, 2), ['decision 16', 'decision 1']);
    assert.strictEqual(written.sections['Active Decisions'].filter(e => e === 'decision 1').length, 1, 'an entry written again is one entry, on top');
    assert.deepStrictEqual(marksOf(written), [{ hash: stateDoc.entryHash('decision 15'), at: T.eleven, kind: 'retired' }]);
    assert.deepStrictEqual(written.sections['Context'], ['The app.'], 'an update with no context keeps the paragraph');
    const again = parse(build({ updated: T.twelve, decisions: [{ what: 'decision 15' }] }, written));
    assert.deepStrictEqual(marksOf(again).find(m => m.hash === stateDoc.entryHash('decision 15')), { hash: stateDoc.entryHash('decision 15'), at: T.twelve, kind: 'restored' }, 'added again, the entry carries a restoration for the copies that still hold the retirement');
    const carrying = parse(document({ updated: T.ten, retired: `${stateDoc.entryHash('stale: yes')}@${T.eleven}`, decisions: ['stale: yes'] }));
    const unrelated = parse(build({ updated: T.twelve, preferences: ['tabs'] }, carrying));
    assert.deepStrictEqual(marksOf(unrelated), [{ hash: stateDoc.entryHash('stale: yes'), at: T.eleven, kind: 'retired' }], 'an update about something else restores nothing the document already held');
    const guarded = parse(build({ updated: T.twelve, projectPath: '/x\n## Context\nfake', branch: 'main\nretired: zz', author: 'dev\nupdated: 1999', context: 'real\n## Preferences\n- not an entry' }, empty));
    assert.strictEqual(header(guarded, 'project'), '/x ## Context fake', 'a header field is one line');
    assert.strictEqual(header(guarded, 'branch'), 'main retired: zz');
    assert.strictEqual(header(guarded, 'updated'), T.twelve, 'nothing injected into the header');
    assert.deepStrictEqual(guarded.sections['Context'], ['real', '## Preferences', '- not an entry'], 'a context line that looks like a heading or an entry stays context');
    assert.deepStrictEqual(guarded.sections['Preferences'], []);
    const broken = parse(build({ updated: T.twelve, decisions: [{ what: 'one\nentry', why: 'two\n## Preferences\n- lines' }], preferences: ['a\r\nb'], next: ['first\n## Context\nsecond'] }, written));
    assert.strictEqual(broken.sections['Active Decisions'][0], 'one entry: two ## Preferences - lines', 'a line break inside an entry becomes a space, never a second entry or a heading');
    assert.strictEqual(broken.sections['Preferences'][0], 'a b');
    assert.deepStrictEqual(broken.sections['Next Session'], ['first ## Context second']);
    const flood = parse(build({ updated: T.twelve, decisions: numbered('new', 16).map(what => ({ what })) }, empty));
    assert.strictEqual(flood.sections['Active Decisions'].length, 15);
    assert.deepStrictEqual(marksOf(flood), [{ hash: stateDoc.entryHash('new 16'), at: T.twelve, kind: 'retired' }], 'an incoming entry the cap leaves out is retired too');
    assert.strictEqual(serialize(written).split('\n')[0], '# Project State');
    assert.ok(serialize(written).endsWith('## Next Session\n'), 'the document ends as the previous writer ended it');
    assert.ok(!serialize(parse(document({ updated: T.ten }))).includes('retired:'), 'no marks, no line');
  });

  run('the presented document carries no retired line, and the parser reads the documents of the versions before', () => {
    const withMarks = document({ updated: T.ten, retired: `${stateDoc.entryHash('x')}@${T.ten}`, decisions: ['kept: yes'] });
    const shown = stateDoc.withoutRetiredLine(withMarks);
    assert.ok(!shown.includes('retired:'));
    assert.ok(shown.includes('- kept: yes'));
    assert.strictEqual(stateDoc.withoutRetiredLine(document({ updated: T.ten })), document({ updated: T.ten }), 'a document without the line is unchanged');
    const legacy = parse('# Project State\nproject: global\nauthor: dev\nupdated: 2026-01-01T00:00:00.000Z\n\n## Context\nLine one.\nLine two.\n\n## Active Decisions\n- what: why\n\n## Preferences\n- p\n');
    assert.strictEqual(header(legacy, 'project'), 'global');
    assert.deepStrictEqual(legacy.sections['Context'], ['Line one.', 'Line two.']);
    assert.deepStrictEqual(legacy.sections['Active Decisions'], ['what: why']);
    assert.deepStrictEqual(legacy.sections['Do Not Repeat'], []);
  });

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-team-merge-'));
  try {
    run('two machines that both wrote between two syncs keep both additions after one sync each way, and converge', () => {
      const syncDir = path.join(dir, 'sync', 'state');
      const stateA = path.join(dir, 'home-a', '.egc', 'state');
      const stateB = path.join(dir, 'home-b', '.egc', 'state');
      const repoA = makeCheckout(dir, path.join('linux', 'work', 'app'), REMOTE_URL);
      const repoB = makeCheckout(dir, path.join('mac', 'code', 'app-clone'), REMOTE_URL);
      const teamKey = crypto.randomBytes(32);
      const keyA = crypto.randomBytes(32);
      const keyB = crypto.randomBytes(32);
      const fileA = branchState.resolveStateWrite(stateA, repoA, 'main');
      const fileB = branchState.resolveStateWrite(stateB, repoB, 'main');
      const read = (file, key) => parse(encryption.readStateFile(file, key));
      const write = (file, key, content) => { fs.mkdirSync(path.dirname(file), { recursive: true }); encryption.writeStateFile(file, content, key); };

      write(fileA, keyA, build({ projectPath: repoA, updated: T.ten, context: 'The app.', decisions: [{ what: 'A1', why: 'first on A' }] }));
      teamSync.stageTeamState(stateA, syncDir, teamKey, keyA);
      assert.strictEqual(teamSync.mergeTeamStateFrom(syncDir, stateB, teamKey, keyB).merged, 1);
      assert.deepStrictEqual(read(fileB, keyB).sections['Active Decisions'], ['A1: first on A']);

      write(fileB, keyB, build({ projectPath: repoB, updated: T.eleven, decisions: [{ what: 'B1', why: 'first on B' }] }, read(fileB, keyB)));
      write(fileA, keyA, build({ projectPath: repoA, updated: T.twelve, decisions: [{ what: 'A2', why: 'second on A' }] }, read(fileA, keyA)));
      teamSync.stageTeamState(stateB, syncDir, teamKey, keyB);
      assert.strictEqual(teamSync.mergeTeamStateFrom(syncDir, stateA, teamKey, keyA).merged, 1);
      assert.deepStrictEqual(read(fileA, keyA).sections['Active Decisions'], ['A2: second on A', 'B1: first on B', 'A1: first on A'], 'neither side lost its addition');

      teamSync.stageTeamState(stateA, syncDir, teamKey, keyA);
      assert.strictEqual(teamSync.mergeTeamStateFrom(syncDir, stateB, teamKey, keyB).merged, 1);
      assert.deepStrictEqual(read(fileB, keyB).sections, read(fileA, keyA).sections, 'both machines hold the same sections');
      assert.strictEqual(teamSync.mergeTeamStateFrom(syncDir, stateB, teamKey, keyB).merged, 0, 'a second merge of the same sync changes nothing');
    });

    run('a remote copy without the five sections leaves a newer local document untouched, whatever its layout, and the sync reports no merge', () => {
      const syncDir = path.join(dir, 'partial', 'sync', 'state');
      const stateDir = path.join(dir, 'partial', 'home', '.egc', 'state');
      const teamKey = crypto.randomBytes(32);
      const key = crypto.randomBytes(32);
      const relative = path.join(`Repo--${'a'.repeat(64)}`, 'main.md');
      const oldLayout = `# Project State\nproject: /x\nupdated: ${T.eleven}\n\n## Context\n\nold layout\n\n## Active Decisions\n- keep: yes\n\n## Do Not Repeat\n\n## Preferences\n\n## Next Session\n`;
      fs.mkdirSync(path.dirname(path.join(stateDir, relative)), { recursive: true });
      encryption.writeStateFile(path.join(stateDir, relative), oldLayout, key);
      fs.mkdirSync(path.dirname(path.join(syncDir, relative)), { recursive: true });
      fs.writeFileSync(path.join(syncDir, relative), envelope.sealEnvelope(`# Project State\nupdated: ${T.ten}\n\n## Notes\n- partial\n`, teamKey, relative));
      const outcome = teamSync.mergeTeamStateFrom(syncDir, stateDir, teamKey, key);
      assert.strictEqual(outcome.merged, 0, JSON.stringify(outcome));
      assert.strictEqual(encryption.readStateFile(path.join(stateDir, relative), key), oldLayout, 'the local text is exactly as it was');
    });

    run('the walkthrough end to end: two homes, one bare remote, both members write a decision between syncs, both decisions survive on both machines', () => {
      if (!fs.existsSync(MEMORY_SERVER)) {
        console.log('    [SKIP] memory server build not found');
        return;
      }
      const homeA = path.join(dir, 'cli-home-a');
      const homeB = path.join(dir, 'cli-home-b');
      const remote = path.join(dir, 'team-remote');
      fs.mkdirSync(remote, { recursive: true });
      git(remote, ['init', '--bare', '-q']);
      git(remote, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
      const projectA = makeCheckout(homeA, path.join('work', 'app'), REMOTE_URL);
      const projectB = makeCheckout(homeB, path.join('code', 'app-clone'), REMOTE_URL);
      const envA = { ...BASE_ENV, HOME: homeA, USERPROFILE: homeA };
      const envB = { ...BASE_ENV, HOME: homeB, USERPROFILE: homeB };
      const cli = (env, args) => {
        const result = spawnSync(process.execPath, [TEAM_CLI, ...args], { encoding: 'utf8', env, timeout: FULL_INSTALL_TIMEOUT_MS });
        assert.strictEqual(result.status, 0, `egc team ${args.join(' ')} failed:\n${result.stdout}\n${result.stderr}`);
        return result.stdout;
      };
      const server = (env, name, args) => {
        const messages = [
          { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'team-merge-test', version: '0' } } },
          { jsonrpc: '2.0', method: 'notifications/initialized' },
          { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } },
        ];
        const result = spawnSync(process.execPath, [MEMORY_SERVER], { input: messages.map(m => JSON.stringify(m)).join('\n') + '\n', encoding: 'utf8', env, timeout: FULL_INSTALL_TIMEOUT_MS });
        const answer = result.stdout.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line)).find(message => message.id === 2);
        assert.ok(answer && answer.result, `${name} got no answer:\n${result.stdout}\n${result.stderr}`);
        return answer.result.content[0].text;
      };

      cli(envA, ['init', '--backend', 'git', '--remote', remote]);
      const key = JSON.parse(fs.readFileSync(path.join(homeA, '.egc', 'team.json'), 'utf8')).teamKey;
      assert.match(key, /^[0-9a-f]{64}$/);
      assert.ok(server(envA, 'update_state', { project_path: projectA, context: 'The app.', decisions: [{ what: 'decided on A', why: 'first' }] }).includes('Project memory updated'));
      cli(envA, ['sync']);

      cli(envB, ['init', '--backend', 'git', '--remote', remote, '--key', key]);
      cli(envB, ['sync']);
      assert.ok(server(envB, 'get_state', { project_path: projectB }).includes('decided on A'), 'the second machine reads the first decision for its own path');
      assert.ok(server(envB, 'update_state', { project_path: projectB, decisions: [{ what: 'decided on B', why: 'second' }] }).includes('Project memory updated'));
      assert.ok(server(envA, 'update_state', { project_path: projectA, decisions: [{ what: 'decided on A again', why: 'third' }] }).includes('Project memory updated'));
      cli(envB, ['sync']);
      cli(envA, ['sync']);
      const stateOnA = server(envA, 'get_state', { project_path: projectA });
      for (const decision of ['decided on A', 'decided on B', 'decided on A again']) {
        assert.ok(stateOnA.includes(decision), `${decision} is on machine A:\n${stateOnA}`);
      }
      assert.ok(!stateOnA.includes('retired:'), 'the presented state carries no retired line');
      cli(envB, ['sync']);
      const stateOnB = server(envB, 'get_state', { project_path: projectB });
      for (const decision of ['decided on A', 'decided on B', 'decided on A again']) {
        assert.ok(stateOnB.includes(decision), `${decision} is on machine B:\n${stateOnB}`);
      }
    });
  } finally {
    removeDirWithRetries(dir);
  }

  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch(error => {
  console.error(error);
  process.exit(1);
});
