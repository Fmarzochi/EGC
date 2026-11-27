#!/usr/bin/env node
'use strict';

// Junie's SessionStart hook (~/.junie/config.json: session_id, cwd and
// project_path on stdin; Junie reads nothing back from this event). The
// shared host session start pulls the Team Brain when the team asks for it
// and restores the project memory of project_path, which the session then
// reads through get_state.
require('../lib/host-session-start').runHostSessionStartHook('junie');
