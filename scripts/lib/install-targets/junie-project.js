const { createInstallTargetAdapter } = require('./helpers');

module.exports = createInstallTargetAdapter({
  id: 'junie-project',
  target: 'junie',
  kind: 'project',
  rootSegments: ['.junie'],
  installStatePathSegments: ['egc-install-state.json'],
  nativeRootRelativePath: '.junie',
});