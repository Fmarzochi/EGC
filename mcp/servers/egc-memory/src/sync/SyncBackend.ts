export interface SyncStatus {
  lastSyncTime: string | null;
  hasUncommittedChanges: boolean;
  conflictCount: number;
  remoteUrl: string;
}

export interface SyncConfig {
  backend: string;
  remote: string;
  branch: string;
  teamKey?: string;
}

export interface SyncResult {
  pulledCount: number;
  pushedCount: number;
  conflictCount: number;
  rejectedCount: number;
  errors: string[];
}

// readRemote false skips every read of the remote: the backend is set up
// from the local checkout alone, which is enough for a status during an
// outage of the remote.
export interface InitOptions {
  readRemote?: boolean;
}

export abstract class SyncBackend {
  abstract init(config: SyncConfig, options?: InitOptions): Promise<void>;
  abstract pull(): Promise<string[]>;
  abstract push(): Promise<boolean>;
  abstract status(): Promise<SyncStatus>;
  abstract destroy(): Promise<void>;
}
