const { createInstallTargetAdapter } = require('./helpers');

module.exports = createInstallTargetAdapter({
  id: 'trae-project',
  target: 'trae',
  kind: 'project',
  rootSegments: ['.trae'],
  installStatePathSegments: ['egc-install-state.json'],
  nativeRootRelativePath: '.trae',
});
