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
}

export interface SyncResult {
  pulledCount: number;
  pushedCount: number;
  conflictCount: number;
  errors: string[];
}

export abstract class SyncBackend {
  async init(_config: SyncConfig): Promise<void> {
    throw new Error('Not implemented');
  }
  abstract pull(): Promise<string[]>;
  abstract push(): Promise<void>;
  abstract status(): Promise<SyncStatus>;
  abstract destroy(): Promise<void>;
}
