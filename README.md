# pi-compaction-02

A `session_before_compact` hook for the [pi coding agent](https://github.com/badlogic/pi-mono) that routes compaction summaries to a **configurable model** instead of the session model — e.g. a cheap dedicated summarizer — while recovering the **file map pi's default extractor misses** (files touched via bash: `cat`/`sed`/`grep`/`jq`/`python -c`/redirects/`!` runs…).

Out of the box it uses your session model (zero config). Pin a cheap model and it behaves like a near-free, high-fidelity checkpoint writer.

## Install

```bash
pi install git:rd162/pi-compaction-02
# or npm, once published:
pi install npm:pi-compaction-02
```

## Configure

No hardcoded models. Everything is environment, read fresh on every compaction (no `/reload` needed):

| Variable | Default | Meaning |
|---|---|---|
| `PI_COMPACTION_MODEL` | `openrouter/meta/muse-spark-1.3-contributor` | `"provider/model-id"` — any model; unresolvable → session model |
| `PI_COMPACTION_REASONING` | `medium` | `off\|minimal\|low\|medium\|high\|xhigh\|max` (invalid → default) |
| `PI_COMPACTION_MAX_TOKENS` | `16384` | Output cap, clamped to `2048..65536` and to the model's own max |

Example (override the default with your own summarizer):

```bash
export PI_COMPACTION_MODEL="anthropic/claude-haiku-4-5"
export PI_COMPACTION_REASONING="low"
```

Malformed `PI_COMPACTION_MODEL` warns and falls back to the built-in default. `reasoning` is only requested on models that advertise `reasoning: true` (otherwise the call would throw and you'd lose the hook to default compaction).

## What it does

- **Same pipeline as pi's own summarizer** (mirrors `core/compaction/compaction.js`): dedicated system prompt, `<conversation>` wrap + `serializeConversation`, update-merge with `<previous-summary>`, `/compact` focus via `Additional focus:`, `<read-files>`/`<modified-files>` in `details`, same failure guards (length/error/toolCall/empty/throw → default compaction).
- **Prompt tuned for fidelity** (MGPC-adapted: Mission / Goals / Premises with source + risk-if-false / sourced Constraints / `Area › Domain` Knowledge Map / Mission Space): discovery scan before summarizing (explicit → implications → transcript cues), quote-don't-paraphrase, full code snippets, every claim anchored with a concrete example, thorough-over-concise, status hygiene + old-header migration on merge.
- **Bash file tracking** (pi's default only sees `read`/`write`/`edit` tool paths): quote-aware command split, read/search/interpreter dispatch, redirect + write-verb destinations (declared writes need no existence gate), result-shape attribution (line counts, `file:N:` hits, listings → dir rollup), `!`-execution envelopes (converted and raw), success-proxy with depth + metachar floors, path hygiene at every ingress (no dirs, blobs, or header-shaped junk — ever), cross-compaction accumulation scoped to the current branch.
- **Bounded and fail-open**: every loop and allocation has a hard budget (20k cmd chars, 2000 stats, 30×16KB script peeks, 120 display entries…); anything unexpected degrades to Tier-0 lists or default compaction. Never throws out to pi.

## Test

Harnesses load the extension through pi's own `jiti` loader (same as production):

```bash
node test/compaction-02-test.mjs      # 24 unit tests
node test/compaction-02-stress.mjs    # 900-msg hostile spans, determinism
node test/compaction-02-stress2.mjs   # 56 exotic-tool commands (jq/jd/difft/bat/eza/sqlite3/ast-grep/ffmpeg…)
node test/compaction-02-100k.mjs      # 100k tool pairs, budget exhaustion
```

(Test scripts live in `test/`; fixtures are created under `$TMPDIR` at runtime.)

## License

MIT
