# everything-claude-code Development Patterns

> Auto-generated skill from repository analysis

## Overview

This skill teaches the development patterns for the everything-claude-code repository - a comprehensive multi-platform AI coding assistant system. The codebase maintains compatibility across multiple AI platforms (Claude, Cursor, Codex, OpenCode) while supporting internationalization across four languages (English, Chinese Simplified/Traditional, Japanese). The system focuses on skill-based architecture, continuous learning capabilities, and cross-platform synchronization.

## Coding Conventions

### File Naming
- Use **camelCase** for JavaScript files
- Use **kebab-case** for directories and skill names
- Test files follow pattern: `*.test.js`

```javascript
// File structure examples
skills/continuousLearningV2/SKILL.md
tests/hooks/hookManager.test.js
scripts/platformSync.js
```

### Import/Export Style
- Mixed import styles (both CommonJS and ES modules supported)
- Mixed export styles based on platform compatibility

```javascript
// CommonJS style
const hookManager = require('./hookManager');
module.exports = { syncPlatforms };

// ES module style  
import { translateDocs } from './translationUtils.js';
export { processSkills };
```

### Commit Conventions
- Use conventional commit prefixes: `feat:`, `fix:`, `test:`, `chore:`, `docs:`
- Keep commit messages under 70 characters
- Be descriptive about cross-platform impacts

```bash
feat: add multi-language skill sync workflow
fix: resolve cursor platform hook integration
docs: update zh-CN translation for continuous learning
```

## Workflows

### Multi-Language Documentation Sync
**Trigger:** When core documentation or features are updated  
**Command:** `/sync-docs`

1. Update English documentation in root README.md or skill files
2. Identify sections that need translation updates
3. Update Chinese Simplified (`docs/zh-CN/*.md`)
4. Update Traditional Chinese (`docs/zh-TW/*.md`) 
5. Update Japanese (`docs/ja-JP/*.md`)
6. Verify cross-references and links work across all languages
7. Test that skill descriptions match across platforms

```markdown
<!-- Example translation structure -->
# English: skills/example/SKILL.md
# Chinese: docs/zh-CN/skills/example/SKILL.md  
# Japanese: docs/ja-JP/skills/example/SKILL.md
```

### Cross-Platform Harness Sync
**Trigger:** When adding new features or updating platform configurations  
**Command:** `/sync-platforms`

1. Update main platform files in root directory
2. Port changes to `.cursor/` directory for Cursor IDE
3. Port changes to `.codex/` directory for Codex integration
4. Port changes to `.opencode/` directory for OpenCode platform
5. Update platform-specific configuration files
6. Test that each platform can load and execute the changes
7. Verify skill compatibility across all platforms

```javascript
// Platform-specific config example
// .cursor/package.json
{
  "name": "everything-claude-code-cursor",
  "platform": "cursor"
}

// .opencode/package.json  
{
  "name": "everything-claude-code-opencode",
  "platform": "opencode"
}
```

### Skill Addition Workflow
**Trigger:** When adding a new skill or capability  
**Command:** `/add-skill`

1. Create main skill directory: `skills/{skillName}/`
2. Write comprehensive `SKILL.md` with examples and usage
3. Add skill reference to root `README.md`
4. Port skill to `.cursor/skills/{skillName}/SKILL.md`
5. Port to `.agents/skills/{skillName}/` with `openai.yaml`
6. Update `package.json` with new skill metadata
7. Add translations for skill name and description
8. Test skill loading across all platforms

```yaml
# .agents/skills/example/openai.yaml
name: example-skill
description: Example skill for demonstration
version: 1.0.0
compatibility: ["openai", "claude", "cursor"]
```

### Version Release Workflow  
**Trigger:** When preparing a new release  
**Command:** `/release`

1. Update version in root `package.json`
2. Update `.claude-plugin/plugin.json` manifest version
3. Update `.claude-plugin/marketplace.json` with release notes
4. Update `.opencode/package.json` version to match
5. Update version references in `README.md`
6. Update `CHANGELOG.md` with new features and fixes
7. Create git tag and push release
8. Verify plugin compatibility across platforms

```json
// package.json version sync
{
  "version": "2.1.0",
  "name": "everything-claude-code"
}
```

### Hook System Updates
**Trigger:** When modifying hook behavior or adding new hooks  
**Command:** `/update-hooks`

1. Update `hooks/hooks.json` with new hook definitions
2. Create or modify hook scripts in `scripts/hooks/`
3. Port hook implementations to `.cursor/hooks/`
4. Update tests in `tests/hooks/` or `tests/integration/`
5. Update hook documentation in `hooks/README.md`
6. Test hook execution across different trigger scenarios
7. Verify platform-specific hook behaviors

```json
// hooks/hooks.json example
{
  "pre-commit": {
    "script": "scripts/hooks/preCommit.js",
    "platforms": ["cursor", "opencode"],
    "enabled": true
  }
}
```

### Continuous Learning Updates
**Trigger:** When enhancing the continuous learning capabilities  
**Command:** `/update-learning`

1. Update main `skills/continuous-learning-v2/` skill files
2. Modify observer scripts for better learning detection  
3. Port updates to platform-specific skill directories
4. Update translation files for learning prompts
5. Update related commands in `commands/evolve.md`
6. Update instinct commands (`commands/instinct-*.md`)
7. Test learning feedback loops across platforms

```javascript
// Learning observer example
class LearningObserver {
  observePatterns() {
    // Detect coding patterns
    // Update skill knowledge
    // Sync across platforms
  }
}
```

## Testing Patterns

Tests follow the `*.test.js` pattern and focus on:
- Cross-platform compatibility verification
- Multi-language content validation  
- Hook execution testing
- Skill loading and execution

```javascript
// Example test structure
describe('Platform Sync', () => {
  test('should sync skills across all platforms', () => {
    const platforms = ['cursor', 'opencode', 'codex'];
    platforms.forEach(platform => {
      expect(skillExists(platform, 'continuous-learning-v2')).toBe(true);
    });
  });
});
```

## Commands

| Command | Purpose |
|---------|---------|
| `/sync-docs` | Synchronize documentation across all language versions |
| `/sync-platforms` | Port changes across AI coding platforms |
| `/add-skill` | Add new skill with full cross-platform support |
| `/release` | Prepare and publish new version release |
| `/update-hooks` | Modify hook system and test integration |
| `/update-learning` | Enhance continuous learning capabilities |
| `/test-platforms` | Run compatibility tests across all platforms |
| `/translate` | Generate translations for new content |