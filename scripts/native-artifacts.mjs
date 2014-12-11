/** Fixed native binding filenames staged as each `@yydb/sqlite-<platform>` package `main`. */
export const NATIVE_ARTIFACTS = [
    {
        pkg: 'sqlite-win32-x64',
        fileName: 'sqlite.win32-x64.node',
        hostPlatform: 'win32',
        hostArch: 'x64',
        cargoRelease: 'sqlite_napi.dll',
    },
    {
        pkg: 'sqlite-linux-x64',
        fileName: 'sqlite.linux-x64.node',
        hostPlatform: 'linux',
        hostArch: 'x64',
        cargoRelease: 'libsqlite_napi.so',
    },
    {
        pkg: 'sqlite-darwin-x64',
        fileName: 'sqlite.darwin-x64.node',
        hostPlatform: 'darwin',
        hostArch: 'x64',
        cargoRelease: 'libsqlite_napi.dylib',
    },
    {
        pkg: 'sqlite-darwin-arm64',
        fileName: 'sqlite.darwin-arm64.node',
        hostPlatform: 'darwin',
        hostArch: 'arm64',
        cargoRelease: 'libsqlite_napi.dylib',
    },
];
