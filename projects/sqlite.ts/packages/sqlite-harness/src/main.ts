// Single dispatch point for the toolbox. Each subcommand is imported lazily so
// an unbuilt native module only breaks the commands that need it.

import { nativeModulePath, parseOptions } from "./util.ts";

const USAGE = `sqlite-harness

  node projects/sqlite.ts/packages/sqlite-harness/cli.mjs <command> [--json]

Commands
  test         build the native module, run the TypeScript and Python suites, then all platform smokes
  bench        run the same workload on this repository and on better-sqlite3
  conformance  parse externally produced fixtures and compare with an external engine
  fixtures     regenerate the fixture assets from external engines and print sha256
  oracle       report external engines and verify two of them agree on the probes

Bench parameters are environment variables, not config files:
  BENCH_ROWS  BENCH_TXN  BENCH_POINT  BENCH_RANGE  BENCH_PAGE  BENCH_ROUNDS
`;

export async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (command === undefined || command === "--help" || command === "-h") {
    process.stdout.write(USAGE);
    return command === undefined ? 1 : 0;
  }

  let options;
  try {
    options = parseOptions(rest);
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    return 1;
  }

  // The TypeScript package reads `SQLITE_NATIVE` when it is imported, so the
  // built artefact is resolved before any subcommand module is loaded.
  process.env.SQLITE_NATIVE = nativeModulePath();

  switch (command) {
    case "test": {
      const { commandTest } = await import("./test.ts");
      return commandTest(options);
    }
    case "bench": {
      const { commandBench } = await import("./bench.ts");
      return commandBench(options);
    }
    case "conformance": {
      const { commandConformance } = await import("./conformance.ts");
      return commandConformance(options);
    }
    case "fixtures": {
      const { commandFixtures } = await import("./fixtures.ts");
      return commandFixtures(options);
    }
    case "oracle": {
      const { commandOracle } = await import("./oracle-command.ts");
      return commandOracle(options);
    }
    default:
      process.stderr.write(`unknown command: ${command}\n\n${USAGE}`);
      return 1;
  }
}

process.exitCode = await main(process.argv.slice(2));
