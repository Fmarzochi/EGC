#!/usr/bin/env node
'use strict';

// Letta Code's SessionStart hook (~/.letta/settings.json, the Claude Code hook
// format: event_type and working_directory on stdin). Letta documents no
// reading of this hook's output, so the answer goes out in both shapes the
// Claude readers take and the pull of the Team Brain, when the team asks for
// it, is what the session gets for sure.
require('../lib/host-session-start').runHostSessionStartHook('letta');
