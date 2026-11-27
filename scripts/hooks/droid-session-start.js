#!/usr/bin/env node
'use strict';

// Droid's SessionStart hook (~/.factory/settings.json, the Claude Code hook
// format: session_id and cwd on stdin, additionalContext read back into the
// context). The shared host session start restores the project memory and
// pulls the Team Brain when the team asks for it.
require('../lib/host-session-start').runHostSessionStartHook('droid');
