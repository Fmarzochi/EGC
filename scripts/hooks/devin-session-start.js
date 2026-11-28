#!/usr/bin/env node
'use strict';

// Devin's SessionStart hook (~/.config/devin/config.json: session_id and
// source on stdin, the project in DEVIN_PROJECT_DIR,
// hookSpecificOutput.additionalContext read back). The shared host session
// start restores the project memory and pulls the Team Brain when the team
// asks for it.
require('../lib/host-session-start').runHostSessionStartHook('devin');
