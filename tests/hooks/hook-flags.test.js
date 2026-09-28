/**
 * Tests for scripts/lib/hook-flags.js
 *
 * Run with: node tests/hooks/hook-flags.test.js
 */

const assert = require('assert');

const {
  VALID_PROFILES,
  normalizeId,
  getHookProfile,
  getDisabledHookIds,
  parseProfiles,
  isHookEnabled,
} = require('../../scripts/lib/hook-flags');

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    return true;
  } catch (err) {
    console.log(`  ✗ ${name}`);
    console.log(`    Error: ${err.message}`);
    return false;
  }
}

// Helper to save and restore env vars
function withEnv(vars, fn) {
  const saved = {};
  for (const key of Object.keys(vars)) {
    saved[key] = process.env[key];
    if (vars[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = vars[key];
    }
  }
  try {
    fn();
  } finally {
    for (const key of Object.keys(saved)) {
      if (saved[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = saved[key];
      }
    }
  }
}

function runTests() {
  console.log('\n=== Testing hook-flags.js ===\n');

  let passed = 0;
  let failed = 0;
  const tally = ok => (ok ? passed++ : failed++);

  // VALID_PROFILES tests
  console.log('VALID_PROFILES:');

  tally(test('is a Set', () => {
    assert.ok(VALID_PROFILES instanceof Set);
  }));

  tally(test('contains minimal, standard, strict', () => {
    assert.ok(VALID_PROFILES.has('minimal'));
    assert.ok(VALID_PROFILES.has('standard'));
    assert.ok(VALID_PROFILES.has('strict'));
  }));

  tally(test('contains exactly 3 profiles', () => {
    assert.strictEqual(VALID_PROFILES.size, 3);
  }));

  // normalizeId tests
  console.log('\nnormalizeId:');

  tally(test('returns empty string for null', () => {
    assert.strictEqual(normalizeId(null), '');
  }));

  tally(test('returns empty string for undefined', () => {
    assert.strictEqual(normalizeId(undefined), '');
  }));

  tally(test('returns empty string for empty string', () => {
    assert.strictEqual(normalizeId(''), '');
  }));

  tally(test('trims whitespace', () => {
    assert.strictEqual(normalizeId('  hello  '), 'hello');
  }));

  tally(test('converts to lowercase', () => {
    assert.strictEqual(normalizeId('MyHook'), 'myhook');
  }));

  tally(test('handles mixed case with whitespace', () => {
    assert.strictEqual(normalizeId('  My-Hook-ID  '), 'my-hook-id');
  }));

  tally(test('converts numbers to string', () => {
    assert.strictEqual(normalizeId(123), '123');
  }));

  tally(test('returns empty string for whitespace-only input', () => {
    assert.strictEqual(normalizeId('   '), '');
  }));

  // getHookProfile tests
  console.log('\ngetHookProfile:');

  tally(test('defaults to standard when env var not set', () => {
    // hook-flags.js checks EGC_HOOK_PROFILE first, ECC_HOOK_PROFILE as a
    // legacy fallback (pre-rename alias) — both must be cleared for this to
    // actually exercise the "nothing set" default, not just the primary.
    withEnv({ EGC_HOOK_PROFILE: undefined, ECC_HOOK_PROFILE: undefined }, () => {
      assert.strictEqual(getHookProfile(), 'standard');
    });
  }));

  tally(test('returns minimal when set to minimal', () => {
    withEnv({ EGC_HOOK_PROFILE: 'minimal' }, () => {
      assert.strictEqual(getHookProfile(), 'minimal');
    });
  }));

  tally(test('returns standard when set to standard', () => {
    withEnv({ EGC_HOOK_PROFILE: 'standard' }, () => {
      assert.strictEqual(getHookProfile(), 'standard');
    });
  }));

  tally(test('returns strict when set to strict', () => {
    withEnv({ EGC_HOOK_PROFILE: 'strict' }, () => {
      assert.strictEqual(getHookProfile(), 'strict');
    });
  }));

  tally(test('is case-insensitive', () => {
    withEnv({ EGC_HOOK_PROFILE: 'STRICT' }, () => {
      assert.strictEqual(getHookProfile(), 'strict');
    });
  }));

  tally(test('trims whitespace from env var', () => {
    withEnv({ EGC_HOOK_PROFILE: '  minimal  ' }, () => {
      assert.strictEqual(getHookProfile(), 'minimal');
    });
  }));

  tally(test('defaults to standard for invalid value', () => {
    withEnv({ EGC_HOOK_PROFILE: 'invalid' }, () => {
      assert.strictEqual(getHookProfile(), 'standard');
    });
  }));

  tally(test('defaults to standard for empty string', () => {
    withEnv({ EGC_HOOK_PROFILE: '' }, () => {
      assert.strictEqual(getHookProfile(), 'standard');
    });
  }));

  // getDisabledHookIds tests
  console.log('\ngetDisabledHookIds:');

  tally(test('returns empty Set when env var not set', () => {
    withEnv({ EGC_DISABLED_HOOKS: undefined, ECC_DISABLED_HOOKS: undefined }, () => {
      const result = getDisabledHookIds();
      assert.ok(result instanceof Set);
      assert.strictEqual(result.size, 0);
    });
  }));

  tally(test('returns empty Set for empty string', () => {
    withEnv({ EGC_DISABLED_HOOKS: '' }, () => {
      assert.strictEqual(getDisabledHookIds().size, 0);
    });
  }));

  tally(test('returns empty Set for whitespace-only string', () => {
    withEnv({ EGC_DISABLED_HOOKS: '   ' }, () => {
      assert.strictEqual(getDisabledHookIds().size, 0);
    });
  }));

  tally(test('parses single hook id', () => {
    withEnv({ EGC_DISABLED_HOOKS: 'my-hook' }, () => {
      const result = getDisabledHookIds();
      assert.strictEqual(result.size, 1);
      assert.ok(result.has('my-hook'));
    });
  }));

  tally(test('parses multiple comma-separated hook ids', () => {
    withEnv({ EGC_DISABLED_HOOKS: 'hook-a,hook-b,hook-c' }, () => {
      const result = getDisabledHookIds();
      assert.strictEqual(result.size, 3);
      assert.ok(result.has('hook-a'));
      assert.ok(result.has('hook-b'));
      assert.ok(result.has('hook-c'));
    });
  }));

  tally(test('trims whitespace around hook ids', () => {
    withEnv({ EGC_DISABLED_HOOKS: ' hook-a , hook-b ' }, () => {
      const result = getDisabledHookIds();
      assert.strictEqual(result.size, 2);
      assert.ok(result.has('hook-a'));
      assert.ok(result.has('hook-b'));
    });
  }));

  tally(test('normalizes hook ids to lowercase', () => {
    withEnv({ EGC_DISABLED_HOOKS: 'MyHook,ANOTHER' }, () => {
      const result = getDisabledHookIds();
      assert.ok(result.has('myhook'));
      assert.ok(result.has('another'));
    });
  }));

  tally(test('filters out empty entries from trailing commas', () => {
    withEnv({ EGC_DISABLED_HOOKS: 'hook-a,,hook-b,' }, () => {
      const result = getDisabledHookIds();
      assert.strictEqual(result.size, 2);
      assert.ok(result.has('hook-a'));
      assert.ok(result.has('hook-b'));
    });
  }));

  // parseProfiles tests
  console.log('\nparseProfiles:');

  tally(test('returns fallback for null input', () => {
    const result = parseProfiles(null);
    assert.deepStrictEqual(result, ['standard', 'strict']);
  }));

  tally(test('returns fallback for undefined input', () => {
    const result = parseProfiles(undefined);
    assert.deepStrictEqual(result, ['standard', 'strict']);
  }));

  tally(test('uses custom fallback when provided', () => {
    const result = parseProfiles(null, ['minimal']);
    assert.deepStrictEqual(result, ['minimal']);
  }));

  tally(test('parses comma-separated string', () => {
    const result = parseProfiles('minimal,strict');
    assert.deepStrictEqual(result, ['minimal', 'strict']);
  }));

  tally(test('parses single string value', () => {
    const result = parseProfiles('strict');
    assert.deepStrictEqual(result, ['strict']);
  }));

  tally(test('parses array of profiles', () => {
    const result = parseProfiles(['minimal', 'standard']);
    assert.deepStrictEqual(result, ['minimal', 'standard']);
  }));

  tally(test('filters invalid profiles from string', () => {
    const result = parseProfiles('minimal,invalid,strict');
    assert.deepStrictEqual(result, ['minimal', 'strict']);
  }));

  tally(test('filters invalid profiles from array', () => {
    const result = parseProfiles(['minimal', 'bogus', 'strict']);
    assert.deepStrictEqual(result, ['minimal', 'strict']);
  }));

  tally(test('returns fallback when all string values are invalid', () => {
    const result = parseProfiles('invalid,bogus');
    assert.deepStrictEqual(result, ['standard', 'strict']);
  }));

  tally(test('returns fallback when all array values are invalid', () => {
    const result = parseProfiles(['invalid', 'bogus']);
    assert.deepStrictEqual(result, ['standard', 'strict']);
  }));

  tally(test('is case-insensitive for string input', () => {
    const result = parseProfiles('MINIMAL,STRICT');
    assert.deepStrictEqual(result, ['minimal', 'strict']);
  }));

  tally(test('is case-insensitive for array input', () => {
    const result = parseProfiles(['MINIMAL', 'STRICT']);
    assert.deepStrictEqual(result, ['minimal', 'strict']);
  }));

  tally(test('trims whitespace in string input', () => {
    const result = parseProfiles(' minimal , strict ');
    assert.deepStrictEqual(result, ['minimal', 'strict']);
  }));

  tally(test('handles null values in array', () => {
    const result = parseProfiles([null, 'strict']);
    assert.deepStrictEqual(result, ['strict']);
  }));

  // isHookEnabled tests
  console.log('\nisHookEnabled:');

  tally(test('returns true by default for a hook (standard profile)', () => {
    withEnv({ EGC_HOOK_PROFILE: undefined, EGC_DISABLED_HOOKS: undefined }, () => {
      assert.strictEqual(isHookEnabled('my-hook'), true);
    });
  }));

  tally(test('returns true for empty hookId', () => {
    withEnv({ EGC_HOOK_PROFILE: undefined, EGC_DISABLED_HOOKS: undefined }, () => {
      assert.strictEqual(isHookEnabled(''), true);
    });
  }));

  tally(test('returns true for null hookId', () => {
    withEnv({ EGC_HOOK_PROFILE: undefined, EGC_DISABLED_HOOKS: undefined }, () => {
      assert.strictEqual(isHookEnabled(null), true);
    });
  }));

  tally(test('returns false when hook is in disabled list', () => {
    withEnv({ EGC_HOOK_PROFILE: undefined, EGC_DISABLED_HOOKS: 'my-hook' }, () => {
      assert.strictEqual(isHookEnabled('my-hook'), false);
    });
  }));

  tally(test('disabled check is case-insensitive', () => {
    withEnv({ EGC_HOOK_PROFILE: undefined, EGC_DISABLED_HOOKS: 'MY-HOOK' }, () => {
      assert.strictEqual(isHookEnabled('my-hook'), false);
    });
  }));

  tally(test('returns true when hook is not in disabled list', () => {
    withEnv({ EGC_HOOK_PROFILE: undefined, EGC_DISABLED_HOOKS: 'other-hook' }, () => {
      assert.strictEqual(isHookEnabled('my-hook'), true);
    });
  }));

  tally(test('returns false when current profile is not in allowed profiles', () => {
    withEnv({ EGC_HOOK_PROFILE: 'minimal', EGC_DISABLED_HOOKS: undefined }, () => {
      assert.strictEqual(isHookEnabled('my-hook', { profiles: 'strict' }), false);
    });
  }));

  tally(test('returns true when current profile is in allowed profiles', () => {
    withEnv({ EGC_HOOK_PROFILE: 'strict', EGC_DISABLED_HOOKS: undefined }, () => {
      assert.strictEqual(isHookEnabled('my-hook', { profiles: 'standard,strict' }), true);
    });
  }));

  tally(test('returns true when current profile matches single allowed profile', () => {
    withEnv({ EGC_HOOK_PROFILE: 'minimal', EGC_DISABLED_HOOKS: undefined }, () => {
      assert.strictEqual(isHookEnabled('my-hook', { profiles: 'minimal' }), true);
    });
  }));

  tally(test('disabled hooks take precedence over profile match', () => {
    withEnv({ EGC_HOOK_PROFILE: 'strict', EGC_DISABLED_HOOKS: 'my-hook' }, () => {
      assert.strictEqual(isHookEnabled('my-hook', { profiles: 'strict' }), false);
    });
  }));

  tally(test('uses default profiles (standard, strict) when none specified', () => {
    withEnv({ EGC_HOOK_PROFILE: 'minimal', EGC_DISABLED_HOOKS: undefined }, () => {
      assert.strictEqual(isHookEnabled('my-hook'), false);
    });
  }));

  tally(test('allows standard profile by default', () => {
    withEnv({ EGC_HOOK_PROFILE: 'standard', EGC_DISABLED_HOOKS: undefined }, () => {
      assert.strictEqual(isHookEnabled('my-hook'), true);
    });
  }));

  tally(test('allows strict profile by default', () => {
    withEnv({ EGC_HOOK_PROFILE: 'strict', EGC_DISABLED_HOOKS: undefined }, () => {
      assert.strictEqual(isHookEnabled('my-hook'), true);
    });
  }));

  tally(test('accepts array profiles option', () => {
    withEnv({ EGC_HOOK_PROFILE: 'minimal', EGC_DISABLED_HOOKS: undefined }, () => {
      assert.strictEqual(isHookEnabled('my-hook', { profiles: ['minimal', 'standard'] }), true);
    });
  }));

  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
