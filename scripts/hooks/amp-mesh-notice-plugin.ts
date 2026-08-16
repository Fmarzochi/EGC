// EGC session-mesh wake-signal plugin for Amp (Sourcegraph). Amp loads
// plugins in-process from .amp/plugins/*.ts (project) or
// ~/.config/amp/plugins/*.ts (home) under its own Bun runtime, and the
// official Plugin API (https://ampcode.com/manual/plugin-api) documents
// `agent.start` as "Fired when a user submits a prompt (initial or reply)"
// whose handler may return {message: {content, display}} "for adding
// context messages": exactly the turn-boundary slot the mesh notice needs.
//
// Same in-process pattern as amp-guardian-crusher-plugin.ts: require the
// shared implementation copied alongside this file (same targetRoot,
// preserve-relative-path) and call its run() directly, no subprocess and no
// stdout wire contract. run() never writes, exits, or throws past its own
// guards, so a quiet bus costs one stat call per prompt.

const { run: runMeshNotice } = require('../scripts/hooks/mesh-events-inject');

export const description = 'EGC session mesh: injects a one-line wake notice when the shared session bus moved, so this tab drains its events with session_events.';

export default function egcMeshNoticePlugin(amp: any) {
  amp.on('agent.start', (event: any) => {
    const sessionId = event && typeof event.sessionId === 'string' ? event.sessionId : undefined;
    const notice = runMeshNotice({ session_id: sessionId });
    if (!notice) return undefined;
    // display:false keeps the notice out of the visible thread; it reaches
    // the model as context, mirroring additionalContext on hook hosts.
    return { message: { content: notice, display: false } };
  });
}
