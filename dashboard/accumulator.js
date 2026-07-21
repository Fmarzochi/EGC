'use strict';

/**
 * Shared accumulator factory used by dashboard/server.js and tests.
 *
 * createAccumulator(prices) returns a fresh accumulator with its own
 * providerState and sessionHistory so every caller (including each test)
 * gets an isolated instance that exercises the same production code path.
 *
 * @param {object} [externalPrices] — mutable container for calcCost lookups
 *   (e.g. the server's MODEL_PRICES object).  When omitted all cost
 *   calculations return null.
 */
function createAccumulator(externalPrices) {
  const providerState = {};
  const sessionHistory = [];
  const MAX_SESSION_HISTORY = 1000;
  const MAX_REPLAY_SESSIONS = 200;
  const MAX_EVENTS_PER_SESSION = 2000;

  // replayLog: Map<sessionId, { meta, events[] }>
  const replayLog = new Map();

  const CAPABILITIES = {
    claude:    { tokenUsage:true,  model:true,  cost:true,  session:true,  workspace:true  },
    gemini:    { tokenUsage:true,  model:true,  cost:false, session:true,  workspace:false },
    cursor:    { tokenUsage:false, model:false, cost:false, session:true,  workspace:true  },
    codex:     { tokenUsage:false, model:false, cost:false, session:false, workspace:false },
    vscode:    { tokenUsage:false, model:false, cost:false, session:false, workspace:true  },
    kiro:      { tokenUsage:false, model:false, cost:false, session:false, workspace:false },
    trae:      { tokenUsage:false, model:false, cost:false, session:false, workspace:false },
    opencode:  { tokenUsage:false, model:false, cost:false, session:false, workspace:false },
    codebuddy: { tokenUsage:false, model:false, cost:false, session:false, workspace:false },
    aider:     { tokenUsage:false, model:false, cost:false, session:false, workspace:false },
  };

  const IDE_PRICE_KEY = {
    claude:   '_default_claude',
    gemini:   '_default_gemini',
    codex:    '_default_codex',
    opencode: '_default_opencode',
  };

  const prices = externalPrices || {};

  function calcCost(ide, tokens, model) {
    const pricing = prices[model] || prices[IDE_PRICE_KEY[ide]];
    if (!pricing) return null;
    const inp = (tokens.input      || 0) * (pricing.input      || 0) / 1e6;
    const out = (tokens.output     || 0) * (pricing.output     || 0) / 1e6;
    const cr  = (tokens.cacheRead  || 0) * (pricing.cacheRead  || 0) / 1e6;
    const cw  = (tokens.cacheWrite || 0) * (pricing.cacheWrite || 0) / 1e6;
    return inp + out + cr + cw;
  }

  function getProvider(ide) {
    if (!providerState[ide]) {
      providerState[ide] = {
        ide,
        lastSeen:  null,
        running:   false,
        toolCalls: 0,
        sessions:  0,
        lastModel: null,
        tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      };
    }
    return providerState[ide];
  }

  function getOrCreateReplaySession(sessionId, ide, model) {
    if (!replayLog.has(sessionId)) {
      // evict oldest if over limit
      if (replayLog.size >= MAX_REPLAY_SESSIONS) {
        const oldest = replayLog.keys().next().value;
        replayLog.delete(oldest);
      }
      replayLog.set(sessionId, {
        id:        sessionId,
        ide,
        model:     model || null,
        startedAt: Date.now(),
        endedAt:   null,
        events:    [],
      });
    }
    return replayLog.get(sessionId);
  }

  function resolveSessionId(ev) {
    return ev.session_id || ev.sessionId || `${ev.ide}-${Date.now()}`;
  }

  /**
   * Process a telemetry event.
   * @returns {boolean} true if the event was accepted and state was updated;
   *                    false if the event was rejected (missing/invalid ide).
   */
  function accumulateEvent(ev) {
    if (!ev || typeof ev.ide !== 'string' || !ev.ide) return false;

    const p = getProvider(ev.ide);
    p.lastSeen = Date.now();
    p.running  = true;
    if (ev.model) p.lastModel = ev.model;

    if (ev.event === 'pre_tool') p.toolCalls++;

    // ── Replay tracking ──────────────────────────────────────
    const sessionId = resolveSessionId(ev);
    const replay = getOrCreateReplaySession(sessionId, ev.ide, ev.model || p.lastModel);

    if (replay.events.length < MAX_EVENTS_PER_SESSION) {
      replay.events.push({
        t:     Date.now(),
        event: ev.event || 'unknown',
        tool:  ev.tool_name || ev.tool || null,
        file:  ev.file_path || ev.file || ev.detail || null,
        cmd:   ev.command   || null,
        mem:   ev.memory_key || null,
        model: ev.model || null,
        raw:   ev,
      });
    }
    // ────────────────────────────────────────────────────────

    if (ev.event === 'session_end') {
      const usage = ev.usage || {};
      const sessionTokens = {
        input:      usage.input_tokens                || 0,
        output:     usage.output_tokens               || 0,
        cacheRead:  usage.cache_read_input_tokens     || 0,
        cacheWrite: usage.cache_creation_input_tokens || 0,
      };
      const sessionModel = ev.model || p.lastModel || null;
      const ideCap       = CAPABILITIES[ev.ide] || {};
      const sessionCost  = ideCap.cost === true ? calcCost(ev.ide, sessionTokens, sessionModel) : null;

      // Mark replay session as ended
      replay.endedAt = Date.now();
      replay.duration = replay.endedAt - replay.startedAt;

      sessionHistory.push({
        id:           sessionId,
        timestamp:    Date.now(),
        ide:          ev.ide,
        model:        sessionModel,
        input_tokens:  sessionTokens.input,
        output_tokens: sessionTokens.output,
        total_tokens:  sessionTokens.input + sessionTokens.output,
        cost:          sessionCost,
        duration:      replay.duration,
        eventCount:    replay.events.length,
      });

      if (sessionHistory.length > MAX_SESSION_HISTORY) sessionHistory.shift();
    }

    if (ev.usage) {
      p.sessions++;
      p.tokens.input += (ev.usage.input_tokens || 0);
      p.tokens.output += (ev.usage.output_tokens || 0);
      p.tokens.cacheRead += (ev.usage.cache_read_input_tokens || 0);
      p.tokens.cacheWrite += (ev.usage.cache_creation_input_tokens || 0);
    }

    return true;
  }

  function getReplaySessions() {
    return sessionHistory.slice().reverse();
  }

  function getReplayEvents(sessionId) {
    const entry = replayLog.get(sessionId);
    if (!entry) return null;
    return entry;
  }

  return {
    providerState,
    sessionHistory,
    replayLog,
    getProvider,
    accumulateEvent,
    calcCost,
    CAPABILITIES,
    getReplaySessions,
    getReplayEvents,
  };
}

module.exports = { createAccumulator };
