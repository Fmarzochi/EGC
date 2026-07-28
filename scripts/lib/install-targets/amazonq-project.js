const { createInstallTargetAdapter } = require('./helpers');

module.exports = createInstallTargetAdapter({
  id: 'amazonq-project',
  target: 'amazonq',
  kind: 'project',
  rootSegments: ['.amazonq', 'rules'],
  installStatePathSegments: ['egc-install-state.json'],
  // rootSegments already ends in 'rules', matching rules-core's own module
  // path ('rules'): nativeRootRelativePath must equal that source path (not
  // '.amazonq', never exercised by any module) so resolveDestinationPath
  // syncs root children directly instead of nesting rules/rules/.
  nativeRootRelativePath: 'rules',
});
