#!/usr/bin/env node
'use strict';

// Crush's SessionStart hook (crush.json: session_id and cwd on stdin; the
// output of this event is not read, so the session reads the memory
// through get_state). The shared host session start restores the project
// memory and pulls the Team Brain when the team asks for it.
require('../lib/host-session-start').runHostSessionStartHook('crush');
