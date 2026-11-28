#!/usr/bin/env node
'use strict';

// Qwen Code's SessionStart hook (.qwen/settings.json, the Claude Code hook
// format: session_id and cwd on stdin, hookSpecificOutput.additionalContext
// read back into the session). The shared host session start restores the
// project memory and pulls the Team Brain when the team asks for it.
require('../lib/host-session-start').runHostSessionStartHook('qwen');
