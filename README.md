# mend

[![make.fun bounty](https://img.shields.io/badge/make.fun-bounty-blue)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node 22](https://img.shields.io/badge/Node-22-green.svg)](https://nodejs.org)

One patch tool for every AI edit format. `main.ts` (Node 22, standard library
alone) reads a patch in unified diff, SEARCH/REPLACE, V4A or JSON form, finds
each edit's lines at the first of three matching tiers (exact, trailing
whitespace, both sides trimmed), and writes every change or none, printing
what it changed or why it failed. `SPEC.md` is the whole contract.

Run it as `node main.ts [options] [PATCH]` with the working directory as the
root of the tree. Practice set: 100/100 match the reference implementation.

## The files

- `main.ts`: the CLI. Sections 1 to 4 (command line, output and exit codes,
  safe paths, format detection), 5 (three-tier line matching with re-indent),
  6 (unified diffs), 7 (SEARCH/REPLACE blocks), 8 (V4A patches), 9 (JSON
  edits) and 10 (order, atomicity, move reporting) of SPEC.md.
- `runner.ts`: keep it as it is. In a trial it reads the checks from the env,
  runs `node main.ts` on each one in a fresh directory, and posts what it did.
- `check.ts`: the practice set on your own machine:

      node check.ts ../program/generator/practice.json
