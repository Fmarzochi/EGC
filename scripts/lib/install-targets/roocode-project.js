const { createInstallTargetAdapter } = require('./helpers');

module.exports = createInstallTargetAdapter({
  id: 'roocode-project',
  target: 'roocode',
  kind: 'project',
  rootSegments: ['.roo', 'rules'],
  installStatePathSegments: ['egc-install-state.json'],
  nativeRootRelativePath: '.roo',
});
