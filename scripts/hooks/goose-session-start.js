#!/usr/bin/env node
'use strict';

// Goose's SessionStart hook (the hooks.json of the egc-session plugin under
// ~/.agents/plugins, the Claude Code hook format: session_id and working_dir
// on stdin, additionalContext read back). The shared host session start
// restores the project memory and pulls the Team Brain when the team asks
// for it.
require('../lib/host-session-start').runHostSessionStartHook('goose');
