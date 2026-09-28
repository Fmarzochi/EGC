'use strict';
/**
 * The files and directories where common command-line tools keep a token,
 * a password or a private key are protected paths, read or written; their
 * non-secret neighbors (a tool's settings, caches, downloaded packages) stay
 * free.
 *
 * Run with: node tests/egc-guardian-credential-stores.test.js
 */
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const buildPath = path.join(__dirname, '..', 'mcp', 'servers', 'egc-guardian', 'build', 'validator.js');
if (!fs.existsSync(buildPath)) {
  console.log('[SKIP] build not found. Run npm run build in mcp/servers/egc-guardian first.');
  process.exit(0);
}
const { validateCommand, isProtectedPath, isReadDeniedPath, buildDeniedPaths } = require(buildPath);

let passed = 0;
let failed = 0;
function run(name, fn) {
  try {
    fn();
    console.log(`  PASS ${name}`);
    passed++;
  } catch (err) {
    console.log(`  FAIL ${name}`);
    console.log(`    ${err.message}`);
    failed++;
  }
}

const home = os.homedir();
const inHome = relative => path.join(home, ...relative.split('/'));

console.log('\n=== Credential stores are protected paths ===\n');

const stores = [
  '.netrc', '_netrc', '.git-credentials', '.config/git/credentials', '.config/gh/hosts.yml', '.config/hub',
  '.docker/config.json', '.kube/config', '.pgpass', '.my.cnf', '.mylogin.cnf', '.yarnrc.yml',
  '.config/gcloud/credentials.db', '.config/gcloud/application_default_credentials.json', '.azure/msal_token_cache.json',
  '.terraform.d/credentials.tfrc.json', '.vault-token', '.gem/credentials', '.cargo/credentials.toml', '.cargo/credentials',
  '.m2/settings.xml', '.m2/settings-security.xml', '.gradle/gradle.properties', '.s3cfg', '.boto', '.databrickscfg',
  '.config/rclone/rclone.conf', '.password-store/web/site.gpg', '.local/share/keyrings/login.keyring',
  '.config/op/config', '.config/doctl/config.yaml', '.fly/config.yml', '.config/netlify/config.json',
  '.local/share/com.vercel.cli/auth.json', '.config/configstore/firebase-tools.json', '.cache/huggingface/token',
  '.huggingface/token', '.config/composer/auth.json', '.composer/auth.json', '.kaggle/kaggle.json', '.oci/config',
  '.pulumi/credentials.json', '.config/ngrok/ngrok.yml', '.config/stripe/config.toml', '.config/sops/age/keys.txt',
  '.supabase/access-token', '.railway/config.json', '.mozilla/firefox/x.default/logins.json',
  '.config/google-chrome/Default/Login Data', '.config/chromium/Default/Cookies',
  '.config/BraveSoftware/Brave-Browser/Default/Login Data', '.config/microsoft-edge/Default/Login Data',
  'Library/Keychains/login.keychain-db', 'Library/Application Support/Google/Chrome/Default/Login Data',
  'Library/Application Support/Firefox/Profiles/x.default/logins.json',
  'Library/Application Support/BraveSoftware/Brave-Browser/Default/Login Data',
  'Library/Application Support/Microsoft Edge/Default/Login Data', 'Library/Application Support/com.vercel.cli/auth.json',
  'Library/Application Support/doctl/config.yaml',
];
for (const store of stores) {
  run(`~/${store} is protected, read or written`, () => {
    assert.strictEqual(isReadDeniedPath(inHome(store)), true, `read of ~/${store}`);
    assert.strictEqual(isProtectedPath(inHome(store)), true, `write of ~/${store}`);
  });
}

run('a command that reads one is refused', () => {
  for (const command of ['cat ~/.netrc', 'cat ~/.config/gh/hosts.yml', 'head ~/.git-credentials', 'grep token ~/.docker/config.json']) {
    const v = validateCommand(command);
    assert.strictEqual(v.allowed, false, `${command}: ${v.reason}`);
  }
});

const neighbors = [
  '.config/gh/config.yml', '.docker/daemon.json', '.kube/cache/discovery/x.json', '.cargo/config.toml',
  '.cargo/registry/index/x', '.m2/repository/org/x.jar', '.gradle/caches/x', '.gem/specs/x', '.config/git/ignore',
  '.config/git/config', '.cache/huggingface/hub/models--x/config.json', '.config/rclone/other.txt',
];
for (const neighbor of neighbors) {
  run(`~/${neighbor} stays readable`, () => {
    assert.strictEqual(isReadDeniedPath(inHome(neighbor)), false, `read of ~/${neighbor}`);
  });
}
run('a project .yarnrc.yml, .netrc-like names and a .kube folder in a project stay free', () => {
  for (const relative of ['.yarnrc.yml', 'docs/netrc.md', 'k8s/.kube/config.example']) {
    assert.strictEqual(isReadDeniedPath(path.join(process.cwd(), relative)), false, relative);
  }
});

run('on Windows the browser profiles and the roaming settings are found under the profile when LOCALAPPDATA or APPDATA is unset', () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  const saved = { LOCALAPPDATA: process.env.LOCALAPPDATA, APPDATA: process.env.APPDATA, USERPROFILE: process.env.USERPROFILE };
  const profile = path.join(os.tmpdir(), 'egc-profile');
  try {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    delete process.env.LOCALAPPDATA;
    delete process.env.APPDATA;
    process.env.USERPROFILE = profile;
    const denied = buildDeniedPaths();
    for (const store of ['AppData/Local/Google/Chrome/User Data', 'AppData/Local/Microsoft/Edge/User Data', 'AppData/Local/BraveSoftware/Brave-Browser/User Data', 'AppData/Roaming']) {
      assert.ok(denied.includes(path.join(profile, ...store.split('/'))), `${store} under the profile, got ${denied.join(', ')}`);
    }
    process.env.LOCALAPPDATA = path.join(profile, 'Local');
    process.env.APPDATA = path.join(profile, 'Roaming');
    const set = buildDeniedPaths();
    assert.ok(set.includes(path.join(profile, 'Local', 'Google', 'Chrome', 'User Data')), 'LOCALAPPDATA when it is set');
    assert.ok(set.includes(path.join(profile, 'Roaming')), 'APPDATA when it is set');
  } finally {
    Object.defineProperty(process, 'platform', platform);
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

run('on Windows the etc that Git for Windows reads as /etc is denied in both of its install places', () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  const saved = { LOCALAPPDATA: process.env.LOCALAPPDATA, USERPROFILE: process.env.USERPROFILE, ProgramFiles: process.env.ProgramFiles };
  const profile = path.join(os.tmpdir(), 'egc-profile');
  try {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    delete process.env.LOCALAPPDATA;
    process.env.USERPROFILE = profile;
    process.env.ProgramFiles = path.join(profile, 'Program Files');
    const denied = buildDeniedPaths();
    assert.ok(denied.includes(path.join(profile, 'Program Files', 'Git', 'etc')), `the machine-wide install, got ${denied.join(', ')}`);
    assert.ok(denied.includes(path.join(profile, 'AppData', 'Local', 'Programs', 'Git', 'etc')), `the per-user install, got ${denied.join(', ')}`);
  } finally {
    Object.defineProperty(process, 'platform', platform);
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
