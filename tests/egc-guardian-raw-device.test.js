'use strict';
/**
 * A disk or memory device is a protected path: reading one reads every file
 * on the disk, secrets included, and writing one overwrites them. The
 * character devices commands read and write every day (null, zero, random,
 * urandom, tty, the stdin and fd links) stay free.
 *
 * Run with: node tests/egc-guardian-raw-device.test.js
 */
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const buildPath = path.join(__dirname, '..', 'mcp', 'servers', 'egc-guardian', 'build', 'validator.js');
if (!fs.existsSync(buildPath)) {
  console.log('[SKIP] build not found. Run npm run build in mcp/servers/egc-guardian first.');
  process.exit(0);
}
const { validateCommand, isProtectedPath } = require(buildPath);

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

const denied = command => run(`${command} is denied`, () => {
  const v = validateCommand(command);
  assert.strictEqual(v.allowed, false, `${command} should be denied, got: ${v.reason}`);
  assert.ok(v.advisory !== true, `${command} must be a hard denial, got the advisory: ${v.reason}`);
});
const allowed = command => run(`${command} stays allowed`, () => {
  const v = validateCommand(command);
  assert.ok(v.allowed || v.advisory === true, `${command} must not be hard denied, got: ${v.reason}`);
});

console.log('\n=== Disk and memory devices are protected paths ===\n');

console.log('reading a disk or memory device:');
for (const device of [
  '/dev/sda', '/dev/sdb2', '/dev/hda', '/dev/vda', '/dev/xvda1', '/dev/nvme0n1', '/dev/nvme0n1p1',
  '/dev/mmcblk0', '/dev/mmcblk0p1', '/dev/dm-0', '/dev/md0', '/dev/loop0', '/dev/sr0', '/dev/nbd0',
  '/dev/zram0', '/dev/fd0', '/dev/mem', '/dev/kmem', '/dev/port', '/dev/disk/by-id/ata-X',
  '/dev/disk/by-uuid/1234', '/dev/mapper/root', '/dev/block/8:0', '/dev/disk0', '/dev/rdisk2s1',
  '/proc/kcore', '/proc/self/mem', '/proc/1234/mem', '/proc/1234/task/5678/mem',
]) {
  denied(`cat ${device}`);
}
denied('head -c 10 /dev/sda');
denied('strings /dev/mem');
denied('xxd /dev/kmem');
denied('hexdump -C /dev/sda1');
denied('base64 /dev/sda');
denied('cp /dev/sda disk.img');
denied('cat < /dev/sda');
denied('echo x > /dev/sda');

console.log('\nthe character devices commands use every day:');
allowed('cat /dev/null');
allowed('head -c 4 /dev/zero');
allowed('head -c 10 /dev/urandom');
allowed('head -c 10 /dev/random');
allowed('cat /dev/stdin');
allowed('cat /dev/fd/0');
allowed('cat /dev/tty');
allowed('echo x > /dev/null');
allowed('echo x > /dev/stderr');
allowed('ls /dev');
allowed('ls /dev/disk/by-id');
allowed('cat /dev/shm/cache');
allowed('cat dev/sda');
allowed('cat /proc/self/status');
allowed('cat /proc/meminfo');
allowed('cat /proc/self/maps');
allowed('cat /proc/self/mem.txt');
allowed('cat /dev/memory_note');

console.log('\nthe Windows device namespace:');
run('\\\\.\\PhysicalDrive0 and \\\\.\\C: are protected', () => {
  for (const device of ['\\\\.\\PhysicalDrive0', '\\\\.\\C:', '\\\\?\\GLOBALROOT\\Device\\Harddisk0\\Partition0']) {
    assert.strictEqual(isProtectedPath(device), process.platform === 'win32', device);
  }
});

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
