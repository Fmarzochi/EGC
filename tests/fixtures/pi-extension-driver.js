#!/usr/bin/env node
'use strict';

// Drives an EGC extension for pi the way pi does, in a process of its own,
// so HOME and the project are the ones the test chose: registers the
// handlers the extension declares, runs the steps the payload asks for (an
// event name, with a file whose mtime moves first when `touch` names one, as
// the bus store does when another session writes, or a file written first
// when `write` names one, as the memory server does when the state changes)
// and prints the events registered and what each step answered. The payload
// comes as JSON in the third argument; the extension path in the second.

const fs = require('node:fs');

const extension = require(process.argv[2]);
const payload = JSON.parse(process.argv[3]);

const handlers = new Map();
extension({ on: (event, handler) => handlers.set(event, handler) });

const ctx = {
  cwd: payload.cwd,
  sessionManager: { getSessionId: () => payload.sessionId },
};

async function main() {
  const answers = [];
  for (const step of payload.steps) {
    if (step.touch) {
      const moved = new Date(Date.now() + (step.advanceMs || 0));
      fs.utimesSync(step.touch, moved, moved);
    }
    if (step.write) fs.writeFileSync(step.write.path, step.write.content);
    const handler = handlers.get(step.event);
    answers.push(handler ? await handler({}, ctx) : null);
  }
  process.stdout.write(JSON.stringify({ events: [...handlers.keys()], answers }));
}

main().catch(error => {
  process.stdout.write(JSON.stringify({ error: error.message }));
  process.exit(1);
});
