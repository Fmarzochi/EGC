#!/usr/bin/env node
'use strict';

// Mistral Vibe's session_start hook (hooks.toml: session_id and cwd on
// stdin, hook_specific_output.additional_context read back and placed
// before the first message). The shared host session start restores the
// project memory and pulls the Team Brain when the team asks for it.
require('../lib/host-session-start').runHostSessionStartHook('vibe');
