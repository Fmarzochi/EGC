const { createInstallTargetAdapter } = require('./helpers');

module.exports = createInstallTargetAdapter({
  id: 'cursor-project',
  target: 'cursor',
  kind: 'project',
  rootSegments: ['.cursor'],
  installStatePathSegments: ['ecc-install-state.json'],
  nativeRootRelativePath: '.cursor',
});
