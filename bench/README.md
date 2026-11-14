# Internal benchmark

This directory measures Pizza's own local machinery. It makes **no model calls**, reads no API keys, and does not hit the network.

Run it with:

```bash
npm run build          # needed for the cli-startup case
npm run bench
```

Useful variants:

```bash
npm run bench -- --list
npm run bench -- --case compaction-mask
npm run bench -- --case context-build --iterations 10
npm run bench -- --json > bench-result.json
```

## What it measures

| Case | What it does |
| --- | --- |
| `event-store-append` | Appends 10,000 user messages to an in-memory SQLite event store |
| `event-store-query` | Reads those 10,000 events back |
| `context-build` | Projects 5,000 turns into LLM context |
| `compaction-mask` | Masks 80 old tool results and 80 large `_write` argument payloads |
| `summary-serialization` | Serializes a summary turn with a 2k thinking block and a 40k `_write` argument |
| `cli-startup` | Spawns the built CLI with `--version` |

Each case runs one warmup plus N measured iterations (default 5; `context-build` defaults to 3), then reports p50/p95 and case-specific metrics such as events/sec or tokens saved.

## Interpreting the numbers

- These are **local runtime timings**, not a cross-agent comparison. Model choice, prompts, tools, and task setup dominate end-to-end agent performance.
- `compaction-mask` and `summary-serialization` report token estimates from Pizza's local estimator, not a provider tokenizer.
- `cli-startup` includes Node process startup and needs `dist/src/cli.js`; it is skipped when the project has not been built.
- Timing tests are intentionally not part of the required CI suite: machine noise makes hard thresholds flaky. Run benchmarks manually or on a dedicated runner.

## Future: cross-agent comparison

A fair comparison with Pi, DeepSeek Harness, ZCode, Kimi Code, or similar needs a separate harness with:

- pinned agent versions
- the same model/provider endpoint
- the same task set and repository snapshot
- fixed permissions, timeouts, and network policy
- multiple runs with p50/p95, token/cost, tool calls, and success rate

That belongs in a separate `bench/agents/` layer and should not be mixed into these local microbenchmarks.
