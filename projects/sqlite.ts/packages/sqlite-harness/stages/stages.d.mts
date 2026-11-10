// Hand-written declaration for `stages.mjs` so the TypeScript harness CLI can
// import the plain-JavaScript platform registry without pulling it into
// `rootDir`. `run` returns the fields the `test` command reports.

export interface PlatformStageResult {
  readonly name: string;
  readonly ok: boolean;
  readonly assertions: number;
  readonly rows: number;
  readonly layers: { readonly storage: number; readonly sql: number };
  readonly skipped: number;
  readonly elapsed: number;
  readonly reasons: string[];
  readonly tail: string;
}

export interface PlatformStage {
  readonly name: string;
  readonly commands: string[];
  readonly assertionsFloor: number;
  readonly sqlFloor: number;
  readonly run: () => PlatformStageResult;
}

export declare const platformStages: PlatformStage[];
