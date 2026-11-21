/**
 * Tests for scripts/lib/doctor-mesh.js: the Mesh block of egc doctor, built
 * from the files of the home alone (mesh.json, machine.json, the status the
 * bridge keeps, team.json), never from the server or the network.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { buildMeshReport, printMeshReport } = require('../../scripts/lib/doctor-mesh');
const { writeTeamConfig } = require('../../scripts/lib/team-config');

const KEY = 'cd'.repeat(32);
const CENTRAL = 'wss://mesh.example.com:47470';
const MACHINE = { id: 'a1b2c3d4e5f60718a1b2c3d4e5f60718', label: 'desk', createdAt: '2026-11-21T10:00:00.000Z' };

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    return true;
  } catch (error) {
    console.log(`  ✗ ${name}`);
    console.log(`    ${error.message}`);
    return false;
  }
}

function withHome(fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-doctor-mesh-'));
  fs.mkdirSync(path.join(home, '.egc', 'mesh'), { recursive: true });
  try {
    return fn(home);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

function writeMesh(home, central = CENTRAL) {
  fs.writeFileSync(path.join(home, '.egc', 'mesh.json'), JSON.stringify({ central, updatedAt: '2026-11-21T10:00:00.000Z' }));
}

// The status as the bridge of this very process would leave it.
function writeBridge(home, overrides = {}) {
  const status = { pid: process.pid, machine: MACHINE, central: CENTRAL, connected: true, online: ['m2', 'm3'], updatedAt: new Date().toISOString(), ...overrides };
  fs.writeFileSync(path.join(home, '.egc', 'mesh', 'bridge.json'), JSON.stringify(status));
}

function withTeam(home) {
  writeTeamConfig({ backend: 'git', remote: 'https://example.com/team.git', branch: 'main', teamKey: KEY }, home);
}

function lines(report) {
  const out = [];
  printMeshReport(report, line => out.push(line));
  return out.join('\n');
}

function runTests() {
  console.log('\n=== Testing the Mesh block of egc doctor ===\n');
  const results = [
    test('no mesh configuration is one informational line and no warning', () => withHome(home => {
      const report = buildMeshReport(home);
      assert.strictEqual(report.configured, false);
      assert.strictEqual(report.warningCount, 0);
      assert.strictEqual(lines(report), '\nMesh: not configured (egc mesh connect <address> joins the central of your team; egc mesh serve starts one)');
    })),

    test('a mesh.json without a central, or with an address the mesh refuses, is one warning', () => withHome(home => {
      for (const content of ['{"central": ""}', '{"central": "http://mesh.example.com:47470"}', '{"central": "ws://user:pw@mesh.example.com"}', 'not json']) {
        fs.writeFileSync(path.join(home, '.egc', 'mesh.json'), content);
        const report = buildMeshReport(home);
        assert.strictEqual(report.unreadable, true, content);
        assert.strictEqual(report.warningCount, 1, content);
        assert.ok(lines(report).includes('Mesh: configuration unreadable (~/.egc/mesh.json)'), content);
        assert.ok(lines(report).includes('[WARNING] the mesh configuration at ~/.egc/mesh.json holds no address the mesh accepts'), content);
      }
      fs.writeFileSync(path.join(home, '.egc', 'mesh.json'), '{"central": "mesh.example.com"}');
      assert.strictEqual(buildMeshReport(home).central, 'ws://mesh.example.com:47470', 'a bare host is read as the runtime reads it');
    })),

    test('a central with no bridge running says so, names this machine from machine.json, and warns of nothing', () => withHome(home => {
      writeMesh(home);
      withTeam(home);
      fs.writeFileSync(path.join(home, '.egc', 'machine.json'), JSON.stringify(MACHINE));
      const report = buildMeshReport(home);
      assert.strictEqual(report.configured, true);
      assert.strictEqual(report.bridge.live, false);
      assert.strictEqual(report.warningCount, 0);
      const text = lines(report);
      assert.ok(text.includes(`Mesh: central ${CENTRAL}, this machine desk (a1b2c3d4)`), text);
      assert.ok(text.includes('Bridge: not running (starts with the next memory server)'), text);
      assert.ok(text.includes('Online: no other machine seen'), text);
      assert.ok(text.includes('Mesh summary: warnings=0'), text);
    })),

    test('a live bridge connected to the central shows its pid and the machines it sees', () => withHome(home => {
      writeMesh(home);
      withTeam(home);
      writeBridge(home);
      const report = buildMeshReport(home);
      assert.deepStrictEqual({ live: report.bridge.live, connected: report.bridge.connected, online: report.bridge.online }, { live: true, connected: true, online: 2 });
      assert.strictEqual(report.warningCount, 0);
      const text = lines(report);
      assert.ok(text.includes(`Bridge: connected (pid ${process.pid})`), text);
      assert.ok(text.includes('Online: 2 other machine(s)'), text);
      assert.ok(text.includes('this machine desk (a1b2c3d4)'), 'the identity comes with the status');
    })),

    test('a live bridge that is not connected is one warning that names the central', () => withHome(home => {
      writeMesh(home);
      withTeam(home);
      writeBridge(home, { connected: false, online: [] });
      const report = buildMeshReport(home);
      assert.strictEqual(report.warningCount, 1);
      const text = lines(report);
      assert.ok(text.includes(`Bridge: reconnecting (pid ${process.pid})`), text);
      assert.ok(text.includes(`[WARNING] the bridge is not connected to ${CENTRAL}`), text);
    })),

    test('a status older than two minutes, or of a process that is gone, is a bridge that is gone', () => withHome(home => {
      writeMesh(home);
      withTeam(home);
      writeBridge(home, { updatedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString() });
      assert.strictEqual(buildMeshReport(home).bridge.live, false, 'a stale status');
      writeBridge(home, { pid: 2 ** 22 - 7 });
      assert.strictEqual(buildMeshReport(home).bridge.live, false, 'a process that is gone');
      for (const pid of [0, -1, 1.5, '42']) {
        writeBridge(home, { pid });
        assert.strictEqual(buildMeshReport(home).bridge.live, false, `a pid of ${JSON.stringify(pid)} is no process`);
      }
      assert.strictEqual(buildMeshReport(home).warningCount, 0);
    })),

    test('a live bridge still on another central is in transition, with no warning', () => withHome(home => {
      writeMesh(home, 'wss://other.example.com:47470');
      withTeam(home);
      writeBridge(home);
      const report = buildMeshReport(home);
      assert.strictEqual(report.warningCount, 0);
      assert.ok(lines(report).includes('Bridge: moving to the new central'), lines(report));
    })),

    test('a central configured on a machine without a team is one warning that says what to run', () => withHome(home => {
      writeMesh(home);
      const report = buildMeshReport(home);
      assert.strictEqual(report.warningCount, 1);
      assert.ok(lines(report).includes('[WARNING] a central is configured and this machine has no team'), lines(report));
    })),
  ];

  const passed = results.filter(Boolean).length;
  const failed = results.length - passed;
  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  process.exitCode = failed > 0 ? 1 : 0;
}

runTests();
