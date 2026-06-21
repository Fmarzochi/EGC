#!/usr/bin/env node

const { readConsent, writeConsent } = require('./lib/telemetry');

function showHelp(exitCode = 0) {
  console.log(`
Usage: egc telemetry <subcommand>

Manage anonymous usage telemetry.

Subcommands:
  status   Show current telemetry setting
  on       Enable anonymous usage telemetry
  off      Disable anonymous usage telemetry

EGC telemetry sends only: EGC version + OS platform.
No project data, no file contents, no identifiers.

You can also disable telemetry by deleting ~/.egc/telemetry.json.
`);
  process.exit(exitCode);
}

function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    showHelp(0);
  }

  const subcommand = args[0];

  if (subcommand === 'status') {
    const consent = readConsent();
    if (consent === null) {
      console.log('Telemetry: not configured (you will be asked on the next egc run).');
    } else if (consent.enabled) {
      console.log('Telemetry: enabled');
    } else {
      console.log('Telemetry: disabled');
    }
    return;
  }

  if (subcommand === 'on') {
    writeConsent(true);
    console.log('Telemetry enabled. Thank you for helping improve EGC.');
    return;
  }

  if (subcommand === 'off') {
    writeConsent(false);
    console.log('Telemetry disabled.');
    return;
  }

  console.error(`Error: Unknown subcommand: ${subcommand}`);
  showHelp(1);
}

main();
