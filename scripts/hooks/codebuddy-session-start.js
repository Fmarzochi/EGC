#!/usr/bin/env node
'use strict';

// CodeBuddy's SessionStart hook (.codebuddy/settings.json, the Claude Code
// hook format: session_id and cwd on stdin, additionalContext and
// hookSpecificOutput read back). The shared host session start restores the
// project memory and pulls the Team Brain when the team asks for it.
require('../lib/host-session-start').runHostSessionStartHook('codebuddy');
