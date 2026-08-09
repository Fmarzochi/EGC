'use strict';

const operations = require('../../scripts/lib/operations');

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    return true;
  } catch (error) {
    console.log(`  ✗ ${name}`);
    console.error(`    ${error.stack || error.message}`);
    return false;
  }
}

async function testAsync(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    return true;
  } catch (error) {
    console.log(`  ✗ ${name}`);
    console.error(`    ${error.stack || error.message}`);
    return false;
  }
}

async function main() {
  console.log('\n=== Testing Operations Registry ===\n');
  let passed = 0;
  let failed = 0;

  const runSync = (name, fn) => {
    if (test(name, fn)) passed++;
    else failed++;
  };

  const runAsync = async (name, fn) => {
    if (await testAsync(name, fn)) passed++;
    else failed++;
  };

  const expectedOperations = [
    'crusher.aggregate_breakdown',
    'doctor.report',
    'install.apply_plan',
    'install.create_plan',
    'state_store.db_stats',
    'state_store.markdown_decisions',
    'state_store.query'
  ];

  runSync('operations.list() returns all expected registered operations', () => {
    const list = operations.list();
    for (const expected of expectedOperations) {
      if (!list.includes(expected)) {
        throw new Error(`Expected operation '${expected}' not found in registry list`);
      }
    }
  });

  runSync('operations.has() correctly identifies registered and unregistered operations', () => {
    if (!operations.has('doctor.report')) throw new Error('has(doctor.report) should be true');
    if (!operations.has('crusher.aggregate_breakdown')) throw new Error('has(crusher.aggregate_breakdown) should be true');
    if (operations.has('non_existent_op')) throw new Error('has(non_existent_op) should be false');
  });

  runSync('operations.execute throws for unknown operations', () => {
    let threw = false;
    try {
      operations.execute('non_existent_op');
    } catch (err) {
      threw = true;
      if (!err.message.includes('Unknown operation')) {
        throw new Error(`Unexpected error message: ${err.message}`, { cause: err });
      }
    }
    if (!threw) throw new Error('Executing unknown operation did not throw');
  });

  runSync('crusher.aggregate_breakdown returns plain JSON structure', () => {
    const originalLog = console.log;
    const originalError = console.error;
    let logged = false;
    console.log = () => {
      logged = true;
    };
    console.error = () => {
      logged = true;
    };
    try {
      const result = operations.execute('crusher.aggregate_breakdown', { entries: [] });
      if (typeof result !== 'object' || result === null) {
        throw new Error('Result must be an object');
      }
      if (typeof result.runs !== 'number') {
        throw new Error('Result must contain runs count');
      }
      JSON.stringify(result); // verify JSON serializable
    } finally {
      console.log = originalLog;
      console.error = originalError;
    }
    if (logged) throw new Error('Operation wrote to console');
  });

  runSync('doctor.report returns plain JSON structure without writing to console', () => {
    const originalLog = console.log;
    const originalError = console.error;
    let logged = false;
    console.log = () => {
      logged = true;
    };
    console.error = () => {
      logged = true;
    };
    try {
      const result = operations.execute('doctor.report', { targets: [] });
      if (typeof result !== 'object' || result === null) {
        throw new Error('Result must be an object');
      }
      if (!result.summary || typeof result.summary.checkedCount !== 'number') {
        throw new Error('Result must contain summary object');
      }
      JSON.stringify(result); // verify JSON serializable
    } finally {
      console.log = originalLog;
      console.error = originalError;
    }
    if (logged) throw new Error('Operation wrote to console');
  });

  await runAsync('state_store.db_stats returns plain JSON object', async () => {
    const result = await operations.execute('state_store.db_stats');
    if (result !== null && typeof result !== 'object') {
      throw new Error('Result must be an object or null');
    }
    if (result) {
      JSON.stringify(result);
    }
  });

  runSync('state_store.markdown_decisions returns a number', () => {
    const count = operations.execute('state_store.markdown_decisions');
    if (typeof count !== 'number') {
      throw new Error('Result must be a number');
    }
  });

  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}\n`);
  if (failed > 0) process.exit(1);
}

main();
