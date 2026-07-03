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
  abstract init(config: SyncConfig): Promise<void>;
  abstract pull(): Promise<string[]>;
  abstract push(): Promise<void>;
  abstract status(): Promise<SyncStatus>;
  abstract destroy(): Promise<void>;
}
