#!/usr/bin/env node
'use strict';

// Auggie's SessionStart hook (~/.augment/settings.json: conversation_id,
// workspace_roots and cwd on stdin; Auggie reads nothing back from this
// event). The shared host session start pulls the Team Brain when the team
// asks for it and restores the project memory of the first workspace root,
// which the session then reads through get_state.
require('../lib/host-session-start').runHostSessionStartHook('auggie');
