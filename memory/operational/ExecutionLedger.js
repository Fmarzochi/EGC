const Store = require('../relational/store');
const Migrations = require('../relational/migrations');
const SessionRepository = require('../relational/SessionRepository');
const TraceRepository = require('../relational/TraceRepository');
const TelemetryRepository = require('../relational/TelemetryRepository');
const RuntimeState = require('./RuntimeState');

class ExecutionLedger {
  constructor(baseDir) {
    this.store = new Store(baseDir);
    Migrations.run(this.store, baseDir);
    this.state = new RuntimeState();
  }

  startExecution(traceId, command) {
    this.state.startSession(traceId);
    SessionRepository.create(this.store, traceId, command);
  }

  recordTrace(traceId, mode, payload) {
    setTimeout(() => {
      try {
        TraceRepository.save(this.store, traceId, this.state.sessionId, mode, payload);
      } catch (e) {
        console.error(e);
      }
    }, 0);
  }

  endExecution(traceId, status) {
    const duration = this.state.endSession();
    SessionRepository.end(this.store, traceId);
    TelemetryRepository.save(this.store, traceId, duration, status);
  }

  shutdown() {
    this.store.shutdown();
  }
}

module.exports = ExecutionLedger;
