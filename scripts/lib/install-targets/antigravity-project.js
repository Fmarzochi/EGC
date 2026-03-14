const { createInstallTargetAdapter } = require('./helpers');

module.exports = createInstallTargetAdapter({
  id: 'antigravity-project',
  target: 'antigravity',
  kind: 'project',
  rootSegments: ['.agent'],
  installStatePathSegments: ['ecc-install-state.json'],
});
