# mend

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Adheirlaffadz/mend/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Adheirlaffadz/mend/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

One patch tool for every AI edit format. `mend` applies an edit an AI model
wrote to a tree of text files, in any of four formats, to one written
specification (`SPEC.md`):

- unified diffs, even with wrong line numbers (the hunk takes the occurrence
  nearest the line number it names);
- SEARCH/REPLACE blocks;
- V4A patches;
- JSON text-editor tool calls (`create`, `str_replace`, `insert`).

Old lines are found at the first of three matching tiers where they occur:
exact, trailing-whitespace-insensitive, then leading-and-trailing-whitespace
insensitive (with re-indentation at the third tier). Every change is written
or none is: a failed edit changes nothing, later edits still run, and every
failure is reported.

## Run it

```sh
node main.ts
```

## Usage

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

`PATCH` is a patch file, or `-` (or absent) to read it from standard input.
`--format` is `unified`, `search-replace`, `v4a`, `json`, or `auto` (the
default, which detects the format). `--check` is a dry run: same output and
exit code, no files written. `--strict` matches lines exactly (tier 0 only).

Node 22, standard library only. No dependencies, no network, no randomness.

## Files

- `main.ts` — the CLI.
- `runner.ts` — the trial runner the grader uses beside `main.ts`.
- `check.ts` — runs the 100 public practice checks:
  `node check.ts <practice.json>`.
- `SPEC.md` — the whole specification.
- `LICENSE` — MIT.

---

<sub>Entered on [make.fun](https://make.fun/?ref=1dyvwkap&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
