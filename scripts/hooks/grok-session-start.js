#!/usr/bin/env node
'use strict';

// Grok Build's SessionStart hook (~/.grok/hooks/egc-session-start.json, a file
// EGC owns in the Claude Code hook shape: hookEventName, sessionId, cwd and
// workspaceRoot on stdin). Grok ignores the stdout of a passive event, so the
// session reads the memory through get_state; what this hook adds is the Team
// Brain pull before the session, when the team asks for it, and the session
// marker and telemetry of the shared host session start.
require('../lib/host-session-start').runHostSessionStartHook('grok');
