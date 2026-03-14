'use strict';

const fs = require('fs');
const path = require('path');

const { collectSessionSnapshot } = require('../orchestration-session');
const { normalizeDmuxSnapshot } = require('./canonical-session');

function isPlanFileTarget(target, cwd) {
  if (typeof target !== 'string' || target.length === 0) {
    return false;
  }

  const absoluteTarget = path.resolve(cwd, target);
  return fs.existsSync(absoluteTarget)
    && fs.statSync(absoluteTarget).isFile()
    && path.extname(absoluteTarget) === '.json';
}

function isSessionNameTarget(target, cwd) {
  if (typeof target !== 'string' || target.length === 0) {
    return false;
  }

  const coordinationDir = path.resolve(cwd, '.claude', 'orchestration', target);
  return fs.existsSync(coordinationDir) && fs.statSync(coordinationDir).isDirectory();
}

function buildSourceTarget(target, cwd) {
  if (isPlanFileTarget(target, cwd)) {
    return {
      type: 'plan',
      value: path.resolve(cwd, target)
    };
  }

  return {
    type: 'session',
    value: target
  };
}

function createDmuxTmuxAdapter(options = {}) {
  const collectSessionSnapshotImpl = options.collectSessionSnapshotImpl || collectSessionSnapshot;

  return {
    id: 'dmux-tmux',
    canOpen(target, context = {}) {
      if (context.adapterId && context.adapterId !== 'dmux-tmux') {
        return false;
      }

      if (context.adapterId === 'dmux-tmux') {
        return true;
      }

      const cwd = context.cwd || process.cwd();
      return isPlanFileTarget(target, cwd) || isSessionNameTarget(target, cwd);
    },
    open(target, context = {}) {
      const cwd = context.cwd || process.cwd();

      return {
        adapterId: 'dmux-tmux',
        getSnapshot() {
          const snapshot = collectSessionSnapshotImpl(target, cwd);
          return normalizeDmuxSnapshot(snapshot, buildSourceTarget(target, cwd));
        }
      };
    }
  };
}

module.exports = {
  createDmuxTmuxAdapter,
  isPlanFileTarget,
  isSessionNameTarget
};
