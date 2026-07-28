const { createInstallTargetAdapter } = require('./helpers');

module.exports = createInstallTargetAdapter({
  id: 'roocode-project',
  target: 'roocode',
  kind: 'project',
  rootSegments: ['.roo', 'rules'],
  installStatePathSegments: ['egc-install-state.json'],
  // rootSegments already ends in 'rules', matching rules-core's own module
  // path ('rules'): nativeRootRelativePath must equal that source path (not
  // '.roo', never exercised by any module) so resolveDestinationPath syncs
  // root children directly instead of nesting rules/rules/.
  nativeRootRelativePath: 'rules',
});
