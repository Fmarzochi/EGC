const { createInstallTargetAdapter } = require('./helpers');

module.exports = createInstallTargetAdapter({
  id: 'amazonq-project',
  target: 'amazonq',
  kind: 'project',
  rootSegments: ['.amazonq', 'rules'],
  installStatePathSegments: ['egc-install-state.json'],
  nativeRootRelativePath: '.amazonq',
});
