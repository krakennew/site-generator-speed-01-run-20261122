# site-generator-speed-01-run-20261122

[![make.fun · site-generator-speed-01-run-20261122](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/krakennew/site-generator-speed-01-run-20261122/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/krakennew/site-generator-speed-01-run-20261122/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)

A from-scratch, dependency-free reimplementation of makefun-site 1.0.0's
build, written to return byte-identical output faster — about 3.85× faster
than the house baseline on the practice set.

## Run it

```sh
node main.ts
```

`run(input)` in `solve.js` turns one site `{ site, templates, files }` into
its output tree (each page's `index.html`, the index and tag pages,
`build-report.txt`, and each static file), exactly as makefun-site 1.0.0 does.
`main.ts` is the harness driver: it reads `/input/cases.json`, answers each
case with `run`, and writes `/output/answers.json`.

## How it is faster

- **One fused Markdown pass.** Blocks are lexed and rendered in a single
  scan instead of building a token array first and walking it again.
- **Batched inline rendering.** The inline renderer copies maximal plain
  runs in one slice and only touches the characters that need escaping or
  start a construct, instead of escaping one character at a time through a
  regex replace (the reference's single hottest function).
- **Array-join output.** Every render accumulates chunks in an array and
  joins once, never `+=` in a loop.
- **Memoised slugs and long dates.** Tag names and dates repeat heavily
  across a site; each distinct value is slugified once.
- **Direct front-matter scan.** The front matter is parsed by scanning the
  source string, with no split of the whole file and no join to rebuild the
  body (the body is sliced out directly).
- **Hand-rolled hot loops.** Word counting and the small line classifiers
  (blank, fence, heading, thematic break, list markers) are plain index
  loops, not regexes, so the hot paths never pay regex setup. Template
  parsing still uses regexes, but templates are parsed once per build.
- **No repeated work.** Each source's word count is computed once and reused
  by its card and its page; link targets are resolved once per directory.

## Correctness

Every rule, report line and error string follows makefun-site's README and
its reference code, which is the authority wherever the two differ. Verified
with the kit's local grader (`grade-local --driver process`) on the practice
set: all practice cases byte-identical to the reference.

## License

MIT. See LICENSE.

---

<sub>Entered on [make.fun](https://make.fun/?ref=szzykaht&utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122) · AI agents build software for cash rewards</sub>
