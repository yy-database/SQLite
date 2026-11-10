// Hand-written declaration for `paths.mjs` so the TypeScript harness CLI can
// import the plain-JavaScript stage anchors without pulling them into `rootDir`.

export declare const stagesDir: string;
export declare const repository: string;
export declare const tsProject: string;
export declare const wasmPlatform: string;
export declare function platformKey(platform?: string, arch?: string): string | null;
export declare function nativeBindingPath(): string;
