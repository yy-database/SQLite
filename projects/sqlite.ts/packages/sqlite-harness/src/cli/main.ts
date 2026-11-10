// Single dispatch point for the toolbox. Each subcommand is imported lazily so
// an unbuilt native module only breaks the commands that need it.

import { nativeModulePath } from "../native/binding.ts";
import { parseOptions } from "./util.ts";

const USAGE = `sqlite-harness

  node projects/sqlite.ts/packages/sqlite-harness/bin/cli.mjs <command> [--json]

Commands
  test         build the native module, run the TypeScript and Python suites, then all platform smokes
  bench        run the same workload on this repository and on better-sqlite3
  conformance  parse externally produced fixtures and compare with an external engine
  fixtures     regenerate the fixture assets from external engines and print sha256
  oracle       report external engines and verify two of them agree on the probes
  corpus       run a seeded differential corpus against both external oracles
  fuzz         grammar-driven fuzz inputs through the harness fuzz engine, shrinked findings against both external oracles

Corpus parameters are explicit:
  --seed <n>   --count <n>   --json
  --check             require every difference to match the baseline and fail otherwise
  --update-baseline   rewrite the baseline from the current run and drop fixed entries

Fuzz parameters are explicit:
  --seed <n>   --count <n>   --depth <n>   --stmts <n>   --max-shrink <n>   --json
  same --check / --update-baseline semantics against "corpus/fuzz-baseline.json"

Bench parameters are environment variables, not config files:
  BENCH_ROWS  BENCH_TXN  BENCH_POINT  BENCH_RANGE  BENCH_PAGE  BENCH_ROUNDS
`;

export async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (command === undefined || command === "--help" || command === "-h") {
    process.stdout.write(USAGE);
    return command === undefined ? 1 : 0;
  }

  if (command === "corpus" || command === "fuzz") {
    process.env.SQLITE_NATIVE = nativeModulePath();
    try {
      if (command === "corpus") {
        const { commandCorpus, parseCorpusOptions } = await import("../conformance/corpus.ts");
        return commandCorpus(parseCorpusOptions(rest));
      }
      const { commandFuzz, parseFuzzOptions } = await import("../fuzz/index.ts");
      return commandFuzz(parseFuzzOptions(rest));
    } catch (error) {
      process.stderr.write(`${(error as Error).message}\n`);
      return 1;
    }
  }

  let options;
  try {
    options = parseOptions(rest);
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    return 1;
  }

  // `bench` reads the binding when it is imported, so it resolves the artefact
  // first. `test` builds the module itself, so it must not resolve a path that
  // does not exist on a fresh checkout yet.
  switch (command) {
    case "test": {
      const { commandTest } = await import("../tests/index.ts");
      return commandTest(options);
    }
    case "bench": {
      process.env.SQLITE_NATIVE = nativeModulePath();
      const { commandBench } = await import("../bench/index.ts");
      return commandBench(options);
    }
    case "conformance": {
      const { commandConformance } = await import("../conformance/index.ts");
      return commandConformance(options);
    }
    case "fixtures": {
      const { commandFixtures } = await import("../conformance/fixtures.ts");
      return commandFixtures(options);
    }
    case "oracle": {
      const { commandOracle } = await import("../conformance/oracle-command.ts");
      return commandOracle(options);
    }
    default:
      process.stderr.write(`unknown command: ${command}\n\n${USAGE}`);
      return 1;
  }
}

process.exitCode = await main(process.argv.slice(2));
