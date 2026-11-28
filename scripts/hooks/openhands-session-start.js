#!/usr/bin/env node
'use strict';

// OpenHands' session_start hook (.openhands/hooks.json: event_type,
// session_id and working_dir on stdin, additionalContext read back). The
// shared host session start restores the project memory and pulls the Team
// Brain when the team asks for it.
require('../lib/host-session-start').runHostSessionStartHook('openhands');
