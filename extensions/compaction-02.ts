/**
 * Smart Compaction — pi's own summarization pipeline, but routed to a
 * configurable model (PI_COMPACTION_MODEL, e.g. a cheap dedicated summarizer)
 * instead of the session model at session thinking level.
 * Every trick below mirrors pi 0.85.1's real implementation
 * (core/compaction/compaction.js + utils.js), not the simplified example:
 *  - system prompt: dedicated summarizer role, "ONLY output the summary",
 *    never continue the conversation (sent as systemPrompt, not user text)
 *  - EXACT structured format (Goal / Constraints / Progress Done-InProgress-
 *    Blocked / Decisions / Next Steps / Critical Context), exact paths/names
 *  - update-merge prompt when a previous summary exists (preserve all,
 *    move In Progress→Done, refresh Next Steps) with <previous-summary> tags
 *  - /compact focus instructions honored ("Additional focus: ...")
 *  - <conversation> wrapping + serializeConversation so the model can't
 *    mistake history for an ongoing chat
 *  - file tracking: <read-files>/<modified-files> appended AND stored in
 *    details, so tracking accumulates across compactions like the default
 *  - failure guards: stopReason error/length (partial text must NEVER become
 *    a checkpoint) and toolCall blocks all fall back to default compaction
 *  - one-off call hygiene: cacheRetention "none" + fresh routing sessionId
 *
 * Default reasoning is medium, not xhigh: summary quality comes from coverage
 * (span + format + file lists), not reasoning depth. Past medium, gains
 * saturate while every compaction blocks the session longer, and deep
 * reasoning drifts extractive→interpretive. Tune via PI_COMPACTION_REASONING.
 *
 * Deliberately NOT ported (default fallback covers them):
 *  - transient retry (retryAssistantCall): on failure we return undefined and
 *    pi's default compaction runs instead — fail-safe over retry cleverness.
 *    Sole exception: stopReason `length` gets ONE retry at 2x budget (capped by
 *    the model max), because `length` means our budget was too small, not a transient.
 *  - split-turn two-pass merge: we summarize the whole spill range in one
 *    call with a full token budget, which preserves the same information
 */

import { uuidv7 } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { convertToLlm, serializeConversation } from "@earendil-works/pi-coding-agent";

// Summarizer configuration — environment, read fresh on every compaction (no reload
// needed). Out of the box a cheap default summarizer is used; override it (or fall
// back to the session model by pointing at it) via PI_COMPACTION_MODEL="provider/model-id".
//   PI_COMPACTION_MODEL    "provider/model-id" (default: openrouter/meta/muse-spark-1.3-contributor)
//   PI_COMPACTION_REASONING off|minimal|low|medium|high|xhigh|max (default: medium)
//   PI_COMPACTION_MAX_TOKENS  output cap (default 16384, clamped 2048..65536 and
//                          to the model's own maxTokens)
const DEFAULT_PROVIDER = "openrouter";
const DEFAULT_MODEL_ID = "meta/muse-spark-1.3-contributor";
const DEFAULT_REASONING = "medium";
const DEFAULT_MAX_TOKENS = 16384;
const VALID_REASONING = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

interface CompactionModelConfig {
	provider?: string;
	modelId?: string;
	reasoning: string; // "off" = no thinking param
	maxTokens: number;
}

function resolveCompactionConfig(env: NodeJS.ProcessEnv = process.env): CompactionModelConfig {
	let provider: string | undefined;
	let modelId: string | undefined;
	const rawModel = (env.PI_COMPACTION_MODEL ?? "").trim();
	const slash = rawModel.indexOf("/");
	if (slash > 0 && slash < rawModel.length - 1) {
		provider = rawModel.slice(0, slash);
		modelId = rawModel.slice(slash + 1);
	}
	const rawReasoning = (env.PI_COMPACTION_REASONING ?? "").trim().toLowerCase();
	const reasoning = VALID_REASONING.has(rawReasoning) ? rawReasoning : DEFAULT_REASONING;
	const rawMax = parseInt(env.PI_COMPACTION_MAX_TOKENS ?? "", 10);
	const maxTokens = Number.isFinite(rawMax)
		? Math.min(65536, Math.max(2048, rawMax))
		: DEFAULT_MAX_TOKENS;
	return { provider, modelId, reasoning, maxTokens };
}

const SYSTEM_PROMPT = `You are a context summarization assistant. Your task is to read a conversation between a user and an AI assistant, then produce a structured summary following the exact format specified. Detail preserved is success; specifics compressed away is failure.

Do NOT continue the conversation. Do NOT respond to any questions in the conversation. Do NOT use tools. ONLY output the structured summary.`;

const BASE_PROMPT = `The messages above are a conversation to summarize. Write a structured context checkpoint summary so that another instance of you can resume the work with ONLY this summary and zero clarifying questions. The full history is deleted after this — compression that loses specifics is failure.

FIRST, run a discovery scan (a few sentences per chunk, chronological):
1. Explicit topics — what was stated outright (requests, actions, files, errors).
2. Implications — what does the work IMPLY that was never stated? Unsaid assumptions
   the work rests on (environment, versions, intent readings, tool availability) become
   Premises; unstated limits become Constraints. If nothing new, stop.
3. Transcript cues — hedging ("ideally", "if possible") marks NEGOTIABLE constraints;
   note who holds veto (whose correction overrode what) and what went unchallenged.

THEN write the summary. RULES:
- Be thorough, not concise: long spans deserve multi-thousand-word summaries.
- QUOTE, don't paraphrase: constraints, decisions, errors, corrections, resumption point — verbatim.
- Every abstract claim anchored with a CONCRETE session example (a value, a path, a message quote).
- Code: FULL snippets for current work, never summaries of code, plus why each file matters.
- Errors: every error, failed approach and why it failed, fixes applied; user corrections quoted.
- Weight the most recent ~20% heaviest — that is where work resumes. Before finishing, self-check:
  list the 3–5 newest load-bearing facts and confirm EACH appears; the newest thread gets the
  most words even if it means compressing older material harder.
- File lists are appended mechanically after your text; explain why key files matter, don't duplicate.
- Classify knowledge generically (Area › Domain), not just code: research findings, ops facts,
  decisions, and domain rules all belong in the Knowledge Map with examples.
- Do NOT use tools. Respond with ONLY the summary below.

Use this EXACT format:

## Mission
[One sentence: the terminal why. If the session has distinct threads, one line per thread.]
[If the stated request differs from the inferred need, record both: Stated: ... / Needed: ...]

## Goals
1. [Concrete objective] — [done | active | blocked]

## Premises
| # | Premise (assumption the work rests on) | Source (stated / inferred from [what] / unchallenged) | Risk if false |
| P1 | ... | ... | [what breaks] |
[Or "(none established)" — never invent premises to fill the table.]

## Constraints & Preferences
| # | Constraint (exact wording) | Source (who imposed it) | Negotiable? (yes if hedged, else no) |
| C1 | ... | ... | ... |
[Or "(none)" if none were mentioned.]

## Knowledge Map
- [Area › Domain]: [concept/fact/rule] — e.g. [concrete session example]
[Covers code AND non-code: findings, infra, procedures, domain rules.]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work — precisely, with file names and full snippets where applicable]

### Errors & Corrections
- [Error or failed approach]: [cause, fix; user corrections quoted verbatim]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [rationale — quote the deciding constraint where one exists]

## Mission Space
- Alternatives tried: [approach + fit against the Constraints above]
- Open questions / knowledge gaps: [what the session never answered]

## Next Steps
1. [Ordered list of what should happen next]
- Resumption point (verbatim quote from the latest messages showing exactly where work left off):

## Critical Context
- [Any data, examples, numbers, URLs, or references needed to continue — exact values, never rounded or reworded]
- [Or "(none)" if not applicable]`;

const UPDATE_INSTRUCTIONS = `Update the existing structured summary with new information from the NEW messages. The merged result is the ONLY record — the new messages are deleted after this. RULES:
- PRESERVE all existing information; never drop entries to save space — grow instead.
- NEWNESS SUPREMACY: when the previous summary and the NEW messages conflict, the NEW messages
  win unconditionally. Identifier classes that go stale across compactions — model ids,
  file paths, repo/branch names, test counts, version numbers, published URLs — MUST be
  deleted in their old form, never merged alongside the new form. A summary that says both
  "pinned model X" and "model configurable via env" is a FAILED summary.
- MARGINAL-INFORMATION RULE: the previous summary is already checkpointed in session history
  — your job is the NEW thread, not re-typing the old one. Compress OLD entries to one line
  each unless still load-bearing; spend the majority of words on the newest work. Information
  loss on old trivia is acceptable; loss on the newest thread is failure.
- Before finishing, self-check: list the 3–5 newest load-bearing facts (renames, config changes,
  published artifacts, fixes with their verification) and confirm EACH appears in the output.
- HEADER MIGRATION: previous summaries may use older headers — migrate, never drop:
  Goal → Mission + Goals; Key Technical Concepts → Knowledge Map (add Area › Domain tags + examples);
  Errors & Corrections stays; anything unmapped goes to Critical Context.
- ADD from the new messages: progress, decisions, files, errors, and newly implied Premises
  (assumptions the new work silently rests on, with source + risk-if-false).
- UPDATE Goals statuses (done/active/blocked); move finished In Progress items to Done with outcomes.
- UPDATE Constraints with new exact-wording entries + source + negotiability (hedged = negotiable).
- UPDATE Knowledge Map generically (code AND findings/facts/rules), each with a concrete example.
- UPDATE Mission Space: append tried alternatives with fit; resolve or carry open questions.
- UPDATE Next Steps; refresh the verbatim resumption quote from the latest messages.
- New code: FULL snippets for current work, never summaries of code.
- QUOTE, don't paraphrase: new constraints, decisions, errors, corrections, resumption — verbatim.
- Give the newest messages the most detail.
- STATUS HYGIENE (mandatory): finished items move to Done with outcomes; resolved blockers
  are removed with resolutions noted — never carry a resolved blocker forward; Next Steps
  must be actually-pending work, never items already Done.
- If something is genuinely superseded (not merely old), you may remove it — say what and why.
- Do NOT use tools. Respond with ONLY the updated summary.

Use this EXACT format:

## Mission
[Preserve; add a line if the task gained a distinct thread; record Stated vs Needed on split]

## Goals
1. [Preserve all, update statuses, append new]

## Premises
| # | Premise | Source | Risk if false |
[Preserve all rows, append new implied ones; drop only falsified premises, noting what broke]

## Constraints & Preferences
| # | Constraint (exact wording) | Source | Negotiable? |
[Preserve all, append new]

## Knowledge Map
- [Preserve all, tag Area › Domain, append new with concrete examples]

## Progress
### Done
- [x] [Previously done AND newly completed, with outcomes]

### In Progress
- [ ] [Current work, with file names and full snippets where applicable]

### Errors & Corrections
- [Preserve all, append new with causes, fixes, verbatim corrections]

### Blocked
- [Current blockers only — resolved ones removed with resolution noted]

## Key Decisions
- **[Decision]**: [rationale] (preserve all, add new — quote deciding constraints)

## Mission Space
- Alternatives tried: [preserve + append with fit]
- Open questions / knowledge gaps: [resolve answered ones, carry the rest]

## Next Steps
1. [Update based on current state — actually pending only]
- Resumption point (verbatim quote from the latest messages showing exactly where work left off):

## Critical Context
- [Preserve important context exactly, add new exact values if needed]`;
// =============================================================================
// Bash file tracking — best-effort, bounded, never throws.
//
// Recovers the file map pi's default extractor misses: files touched via bash
// (cat/sed/grep/python -c/redirects...). Strategy: extract path-shaped tokens,
// keep only what exists on disk, classify read-vs-listing, weigh by measured
// volume. Every loop and allocation below has a hard budget; the whole pass
// is O(messages) with tiny constants. Any error → Tier-0 lists only.
// =============================================================================

import { closeSync, globSync, openSync, readSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, resolve } from "node:path";

const TRACK_BUDGETS = {
	maxCommandChars: 20000, // truncate absurd commands (inline heredocs) before lexing
	maxTokensPerCommand: 200, // candidate tokens examined per command
	maxStatCalls: 2000, // total existence checks per compaction (memoized)
	maxScriptsScanned: 30, // executed script files whose content we peek into
	maxScriptBytes: 16384, // prefix read per script — never whole files
	maxScriptTokens: 200, // path candidates per script prefix
	maxResultChars: 100000, // result text examined per tool result
	maxResultLines: 500, // lines examined per tool result (shape test)
	maxGlobHits: 50, // expanded hits kept per glob (no `**` expansion at all)
	maxTotalEntries: 120, // total paths in the summary section (~2-3k tokens)
	maxMapEntries: 20000, // hard bound on tracked-file map (memory O(1))
	maxDirGroups: 2000, // hard bound on directory counter map
	maxGroupLines: 12, // dir-group lines shown (hierarchical rollup first)
	maxAccumulatedPaths: 5000, // prior-compaction detail paths re-accumulated
	listingSample: 40, // pathish lines stat-checked to confirm a listing
	maxCandidateLen: 500, // ignore absurdly long tokens
};

const READER_CMDS = new Set([
	"cat", "head", "tail", "less", "more", "most", "bat", "sed", "awk", "cut", "wc",
	"file", "stat", "diff", "comm", "od", "xxd", "hexdump", "strings", "nl", "tac", "paste",
]);
const SEARCHER_CMDS = new Set(["grep", "rg", "ag", "ack", "find", "ls", "fd", "tree", "locate"]);
const INTERPRETERS = new Set(["python", "python3", "node", "bun", "deno", "ruby", "php", "perl"]);
const SHELLS = new Set(["sh", "bash", "zsh", "dash"]);

interface TrackedFile {
	weight: number; // eviction order under cap (higher survives)
	lines: number; // measured content lines attributed (0 if unknown)
	hits: number; // grep-style match hits attributed
	via: string; // provenance label ("", "script", "grep", ...)
	modified: boolean; // written via redirect/tee (modified tier)
}

// Quote-aware splitter. Handles '...', "...", \ escapes, and records
// unquoted redirect targets (> >> <). Returns tokens + redirect targets.
function splitCommand(src: string): { tokens: string[]; writeTargets: string[]; readTargets: string[] } {
	const s = src.length > TRACK_BUDGETS.maxCommandChars ? src.slice(0, TRACK_BUDGETS.maxCommandChars) : src;
	const tokens: string[] = [];
	const writeTargets: string[] = [];
	const readTargets: string[] = [];
	let cur = "";
	let quote: string | null = null;
	let escaped = false;
	let pendingRedir: ">" | "<" | null = null;
	const push = () => {
		if (!cur) return; // keep pendingRedir across spaces: `> out.log`
		if (pendingRedir === ">") writeTargets.push(cur);
		else if (pendingRedir === "<") readTargets.push(cur);
		else tokens.push(cur);
		cur = "";
		pendingRedir = null;
	};
	for (let i = 0; i < s.length; i++) {
		const ch = s[i];
		if (escaped) {
			cur += ch;
			escaped = false;
			continue;
		}
		if (ch === "\\" && quote !== "'") {
			escaped = true;
			continue;
		}
		if (quote) {
			if (ch === quote) quote = null;
			else cur += ch;
			continue;
		}
		if (ch === "'" || ch === '"') {
			quote = ch;
			continue;
		}
		if (ch === ">" || ch === "<") {
			// `2>`, `&>`, `>>`, `<<` — the digit/& prefix is junk the gate drops.
			push();
			pendingRedir = ch as ">" | "<";
			// swallow a second identical char (>> or <<)
			if (s[i + 1] === ch) i++;
			continue;
		}
		if (ch === ";" || ch === "&" || ch === "|" || ch === "(" || ch === ")" || ch === "\n" || ch === "\t" || ch === " ") {
			push();
			continue;
		}
		cur += ch;
	}
	push();
	return { tokens, writeTargets, readTargets };
}

// Path-shaped? Deliberately loose — the existence gate decides.
function classifyToken(t: string): "path" | "glob" | null {
	if (!t || t.length > TRACK_BUDGETS.maxCandidateLen) return null;
	if (t.startsWith("-") || t.startsWith("+")) return null; // flags
	if (t.includes("://")) return null; // URLs
	if (/[\0-\b\v\f\x7f]/.test(t)) return null; // control chars
	if (t.includes("$") || t.includes("`")) return null; // expansions we cannot resolve
	if (t.includes("**")) return null; // recursive globs: no expansion, dir-group fallback
	if (t.includes("*") || t.includes("?") || t.includes("[")) return "glob";
	if (t.includes("/")) return "path";
	return /^[\w@.\-]+\.[a-z0-9]{1,6}$/i.test(t) ? "path" : null; // bare `name.ext`
}

// Never memorialize devices or ephemeral outputs (also used by success-proxy).
function isBannedPath(abs: string, tmpPrefix: string): boolean {
	if (abs === "/dev/null" || abs.startsWith("/dev/")) return true;
	if (abs === tmpPrefix || abs.startsWith(tmpPrefix + "/")) return true;
	return false;
}

// String-shape hygiene for any path entering details. Kills immortal junk:
// multiline blobs (quoted heredoc/inline-code fragments), HTTP-header-shaped
// tokens (`Content-Type: application/json`), absurd lengths. Zero syscalls.
// Applied at EVERY ingress (bash gate, success-proxy, accumulation, Tier-0)
// so one bad compaction can never poison all future ones.
function isSanePathString(p: string): boolean {
	if (!p || p.length > 500) return false;
	if (p.includes("\n") || p.includes("\r")) return false;
	if (p.includes(": ")) return false; // `Key: value` lines are never paths
	return true;
}

// Bounded existence gate with memo. Returns absolute path or null.
function gate(
	token: string,
	cwd: string,
	statMemo: Map<string, string | null>,
	budget: { calls: number },
	tmpPrefix: string,
): string | null {
	if (statMemo.has(token)) return statMemo.get(token) ?? null;
	if (budget.calls >= TRACK_BUDGETS.maxStatCalls) return null; // budget out: fail closed
	budget.calls++;
	let abs: string;
	try {
		abs = isAbsolute(token) ? token : resolve(cwd, token);
		if (isBannedPath(abs, tmpPrefix)) {
			statMemo.set(token, null);
			return null;
		}
		if (!isSanePathString(token)) {
			statMemo.set(token, null);
			return null;
		}
		let st;
		try {
			st = statSync(abs);
		} catch {
			statMemo.set(token, null);
			return null;
		}
		if (!st.isFile()) { // dirs, sockets, fifos are not files — never map entries
			statMemo.set(token, null);
			return null;
		}
	} catch {
		statMemo.set(token, null);
		return null;
	}
	statMemo.set(token, abs);
	return abs;
}

// Plain-text extractor for toolResult content (no API surface risk).
function resultText(msg: { content?: unknown }): string {
	const c = msg.content;
	if (typeof c === "string") return c.slice(0, TRACK_BUDGETS.maxResultChars);
	if (!Array.isArray(c)) return "";
	let out = "";
	for (const b of c) {
		if (out.length >= TRACK_BUDGETS.maxResultChars) break;
		if (typeof b === "object" && b !== null && (b as { type?: unknown }).type === "text") {
			const t = (b as { text?: unknown }).text;
			if (typeof t === "string") out += t;
		}
	}
	return out.slice(0, TRACK_BUDGETS.maxResultChars);
}

// Peek at most N bytes of a file. Never loads whole files.
function peekFile(abs: string, n: number): string | null {
	let fd = -1;
	try {
		const st = statSync(abs);
		if (!st.isFile() || st.size === 0) return null;
		fd = openSync(abs, "r");
		const buf = Buffer.alloc(Math.min(n, st.size));
		const read = readSync(fd, buf, 0, buf.length, 0);
		return buf.slice(0, read).toString("utf8");
	} catch {
		return null;
	} finally {
		if (fd >= 0) {
			try {
				closeSync(fd);
			} catch {
			/* ignore */
			}
		}
	}
}

// Pending bash call awaiting its tool result.
interface PendingBash {
	files: string[]; // existence-gated absolute paths from operands
	rawCandidates: string[]; // pathish operand strings (for success-proxy admission)
	script: string | null; // executed script file (interpreters)
	kind: "content" | "search" | "other";
}

// Analyze one bash tool call: gate operands, record redirects + scripts.
// Fail-open per call; appends nothing on any error.
function analyzeBashCall(
	command: unknown,
	cwd: string,
	callId: string | null,
	pending: Map<string, PendingBash>,
	read: Map<string, TrackedFile>,
	modified: Map<string, TrackedFile>,
	statMemo: Map<string, string | null>,
	budget: { calls: number },
	tmpPrefix: string,
	scriptsScanned: { n: number },
): void {
	if (typeof command !== "string" || !command) return;
	const { tokens, writeTargets, readTargets } = splitCommand(command);
	const toks = tokens.slice(0, TRACK_BUDGETS.maxTokensPerCommand);
	// Skip env assignments (A=B) and wrappers (sudo/env/time) to find the real command.
	let cmdIdx = 0;
	while (cmdIdx < toks.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(toks[cmdIdx]) || ["sudo", "env", "time", "nice"].includes(toks[cmdIdx].toLowerCase()))) cmdIdx++;
	const first = cmdIdx < toks.length ? (toks[cmdIdx].split("/").pop() ?? "") : "";
	const base = first.toLowerCase();
	const operands = toks.slice(cmdIdx + 1).filter((t) => !t.startsWith("-") && !t.startsWith("+"));
	const rawOperands = toks.slice(cmdIdx + 1); // positional (keeps flags for -c/-m detection)

	// Declared writes (`>`, tee/cp/mv/touch dest) are recorded WITHOUT the existence
	// gate: a write target usually does not exist yet (new file). String hygiene +
	// denylist still apply (zero syscalls); Tier-0 `written` parity. Never-created
	// files are dropped by accumulation self-cleaning on the next compaction.
	const declareWrite = (t: string): string | null => {
		if (classifyToken(t) !== "path" || !isSanePathString(t)) return null;
		const abs = resolve(cwd, t);
		if (isBannedPath(abs, tmpPrefix)) return null;
		return abs;
	};

	// Redirect targets: `>` writes (modified tier), `<` reads.
	for (const t of writeTargets) {
		if (classifyToken(t) !== "path") continue;
		const abs = declareWrite(t); // declared intent: no existence gate (new files)
		if (abs && (modified.has(abs) || modified.size < 2000)) modified.set(abs, { weight: 0.5, lines: 0, hits: 0, via: "redirect", modified: true });
	}
	for (const t of readTargets) {
		if (classifyToken(t) !== "path") continue;
		const abs = gate(t, cwd, statMemo, budget, tmpPrefix);
		if (abs && !read.has(abs)) read.set(abs, { weight: 0.7, lines: 0, hits: 0, via: "redirect-in", modified: false });
	}

	const gateOperand = (t: string): string | null =>
		classifyToken(t) === "path" ? gate(t, cwd, statMemo, budget, tmpPrefix) : null;

	let kind: PendingBash["kind"] = "other";
	const files: string[] = [];
	let script: string | null = null;

	// Write verbs: operands are modified-tier, not reads. `tee a b` writes all;
	// `cp/mv SRC DST` modifies the destination (last operand); `touch` creates.
	if (base === "tee" || base === "touch" || base === "install") {
		for (const op of operands) {
			const abs = declareWrite(op); // destinations may be new files
			if (abs && (modified.has(abs) || modified.size < 2000)) modified.set(abs, { weight: 0.5, lines: 0, hits: 0, via: base, modified: true });
		}
	} else if (base === "cp" || base === "mv") {
		const dst = operands.length > 0 ? operands[operands.length - 1] : undefined;
		if (dst) {
			const abs = declareWrite(dst); // destination may be a new file
			if (abs && (modified.has(abs) || modified.size < 2000)) modified.set(abs, { weight: 0.5, lines: 0, hits: 0, via: base, modified: true });
		}
	}
	// `tee` anywhere in a pipeline (`echo x | tee f`, `... | sudo tee f`).
	for (let i = 0; i < toks.length; i++) {
		if ((toks[i].split("/").pop() ?? "").toLowerCase() !== "tee") continue;
		for (let j = i + 1; j < toks.length; j++) {
			const t = toks[j];
			if (t === "|" || t === ";" || t === "&" || t === "(" || t === ")") break;
			if (t.startsWith("-") || t.startsWith("+") || classifyToken(t) !== "path") continue;
			const abs = declareWrite(t); // pipeline-tee targets may be new files
			if (abs && (modified.has(abs) || modified.size < 2000)) modified.set(abs, { weight: 0.5, lines: 0, hits: 0, via: "tee", modified: true });
		}
	}


	if (INTERPRETERS.has(base) || SHELLS.has(base)) {
		// First non-flag operand is the script; `-c`/`-e` values are inline code to scan.
		// Iterate raw positions (not the filtered list) so `-c`/`-m` detection is exact.
		for (let i = 0; i < rawOperands.length; i++) {
			const op = rawOperands[i];
			if (op.startsWith("-") || op.startsWith("+")) continue;
			const prevRaw = i > 0 ? rawOperands[i - 1] : "";
			if (prevRaw === "-c" || prevRaw === "-e") {
				scanInlineCode(op, cwd, read, statMemo, budget, tmpPrefix);
				continue;
			}
			if (prevRaw === "-m") continue; // module name, not a path
			if (!script) {
				const abs = gateOperand(op);
				if (abs) {
					script = abs;
					files.push(abs);
					read.set(abs, { weight: 0.9, lines: 0, hits: 0, via: "executed", modified: false });
					scanScriptFile(abs, cwd, read, statMemo, budget, tmpPrefix, scriptsScanned);
				}
			} else {
				const abs = gateOperand(op);
				if (abs) files.push(abs);
			}
		}
		kind = "content";
	} else if (READER_CMDS.has(base)) {
		kind = "content";
		for (const op of operands) {
			const cls = classifyToken(op);
			if (cls === "path") {
				const abs = gate(op, cwd, statMemo, budget, tmpPrefix);
				if (abs) files.push(abs);
			} else if (cls === "glob") {
				for (const h of expandGlob(op, cwd)) {
					const abs = gate(h, cwd, statMemo, budget, tmpPrefix);
					if (abs) files.push(abs);
				}
			}
		}
	} else if (SEARCHER_CMDS.has(base) || (base === "git" && toks.some((t) => t === "grep" || t === "log" || t === "diff" || t === "show"))) {
		kind = "search";
		for (const op of operands) {
			const cls = classifyToken(op);
			if (cls === "path") {
				const abs = gate(op, cwd, statMemo, budget, tmpPrefix);
				if (abs) files.push(abs);
			} else if (cls === "glob") {
				for (const h of expandGlob(op, cwd)) {
					const abs = gate(h, cwd, statMemo, budget, tmpPrefix);
					if (abs) files.push(abs);
				}
			}
		}
	} else {
		// Unknown command: gate operands weakly. Existence decides.
		for (const op of operands) {
			const abs = gateOperand(op);
			if (abs) files.push(abs);
		}
	}

	// Raw pathish tokens for success-proxy admission (stat budget may be out).
	const rawCandidates: string[] = [];
	for (const t of toks) {
		if (rawCandidates.length >= 20) break;
		const cls = classifyToken(t);
		if (cls === "path" || cls === "glob") rawCandidates.push(t);
	}

	if (callId && pending.size < 500 && (files.length > 0 || script || rawCandidates.length > 0)) {
		pending.set(callId, { files, script, kind, rawCandidates });
	}
}

// Scan inline `-c`/`-e` code for hardcoded paths (bounded).
function scanInlineCode(
	code: string,
	cwd: string,
	read: Map<string, TrackedFile>,
	statMemo: Map<string, string | null>,
	budget: { calls: number },
	tmpPrefix: string,
): void {
	const { tokens } = splitCommand(code.slice(0, 5000));
	for (const t of tokens.slice(0, 50)) {
		if (classifyToken(t) !== "path") continue;
		const abs = gate(t, cwd, statMemo, budget, tmpPrefix);
		if (abs && !read.has(abs)) read.set(abs, { weight: 0.6, lines: 0, hits: 0, via: "inline-code", modified: false });
	}
}

// Peek into an executed script for hardcoded paths. Bounded size and count.
function scanScriptFile(
	abs: string,
	cwd: string,
	read: Map<string, TrackedFile>,
	statMemo: Map<string, string | null>,
	budget: { calls: number },
	tmpPrefix: string,
	scriptsScanned: { n: number },
): void {
	if (scriptsScanned.n >= TRACK_BUDGETS.maxScriptsScanned) return;
	scriptsScanned.n++;
	const prefix = peekFile(abs, TRACK_BUDGETS.maxScriptBytes);
	if (!prefix) return;
	const name = abs.split("/").pop() ?? "script";
	const consider = (t: string, examined: { n: number }) => {
		if (examined.n >= TRACK_BUDGETS.maxScriptTokens) return;
		examined.n++;
		if (classifyToken(t) !== "path") return;
		const hit = gate(t, cwd, statMemo, budget, tmpPrefix);
		if (hit && !read.has(hit)) read.set(hit, { weight: 0.6, lines: 0, hits: 0, via: `via ${name}`, modified: false });
	};
	const examined = { n: 0 };
	// 1. String literals: highest signal (`open("data.json")`, paths in config).
	const strRe = /"([^"]{1,300})"|'([^']{1,300})'/g;
	let sm: RegExpExecArray | null;
	while ((sm = strRe.exec(prefix)) !== null && examined.n < TRACK_BUDGETS.maxScriptTokens) {
		consider(sm[1] ?? sm[2], examined);
	}
	// 2. Bare slash-paths outside strings.
	const pathRe = /[A-Za-z0-9_@.~\-]+(\/[A-Za-z0-9_@.~\-]+)+/g;
	let m: RegExpExecArray | null;
	while ((m = pathRe.exec(prefix)) !== null && examined.n < TRACK_BUDGETS.maxScriptTokens) {
		consider(m[0], examined);
	}
}

// Expand a single-level glob (no `**`). Capped, fail-open.
function expandGlob(pattern: string, cwd: string): string[] {
	try {
		if (typeof globSync !== "function") return [];
		const hits = (globSync as (p: string, o?: object) => unknown)(pattern, { cwd });
		if (!Array.isArray(hits)) return [];
		const out: string[] = [];
		for (const h of hits) {
			if (out.length >= TRACK_BUDGETS.maxGlobHits) break;
			if (typeof h === "string") out.push(h);
		}
		return out;
	} catch {
		return [];
	}
}

// Attribute a tool result to the pending bash call's files.
function attributeResult(
	msg: { content?: unknown; isError?: unknown },
	p: PendingBash,
	read: Map<string, TrackedFile>,
	dirCounts: Map<string, number>,
	statMemo: Map<string, string | null>,
	budget: { calls: number },
	tmpPrefix: string,
	cwd: string,
): void {
	const text = resultText(msg);
	if (!text) return;
	const okResult = msg.isError !== true; // success proxy: a good read proves existence
	const allLines = text.split("\n");
	const lines = allLines.slice(0, TRACK_BUDGETS.maxResultLines);
	const nonEmpty = lines.filter((l) => l.trim().length > 0);
	if (nonEmpty.length === 0) return;

	const dirOf = (abs: string): string => {
		const s = abs.lastIndexOf("/");
		return s > 0 ? abs.slice(0, s) : "/";
	};
	// Directory counter with hierarchical rollup: bounded map, small groups merge
	// into parents, so 100k swept files collapse toward common roots.
	const bumpDir = (dir: string, n: number) => {
		dirCounts.set(dir, (dirCounts.get(dir) ?? 0) + n);
		let guard = 0;
		while (dirCounts.size > TRACK_BUDGETS.maxDirGroups && guard++ < 10) {
			let smallest: string | null = null;
			for (const [d, c] of dirCounts) {
				if (smallest === null || (c as number) < (dirCounts.get(smallest) as number)) smallest = d;
			}
			if (smallest === null) break;
			const count = dirCounts.get(smallest) as number;
			dirCounts.delete(smallest);
			const s = smallest.lastIndexOf("/");
			const parent = s > 0 ? smallest.slice(0, s) : "/";
			if (parent === smallest) {
				dirCounts.set(smallest, count);
				break;
			}
			dirCounts.set(parent, ((dirCounts.get(parent) ?? 0) as number) + count);
		}
	};
	// Map insert with hard memory bound. Overflow policy (deterministic top-K):
	// light newcomers go to dir counters; substantial newcomers (weight>=0.5 or
	// >=100 lines or >=50 hits) evict the current minimum if strictly better.
	// The O(map) victim scan runs only for substantial files, so it stays rare.
	const rankOf = (e: TrackedFile, path: string): [number, number, number, string] => [e.weight, e.lines, e.hits, path];
	const greaterRank = (a: [number, number, number, string], b: [number, number, number, string]): boolean =>
		a[0] !== b[0] ? a[0] > b[0] : a[1] !== b[1] ? a[1] > b[1] : a[2] !== b[2] ? a[2] > b[2] : a[3] < b[3];
	const upsert = (abs: string, patch: Partial<TrackedFile>) => {
		const w = patch.weight ?? 0;
		const nl = patch.lines ?? 0;
		const nh = patch.hits ?? 0;
		if (!read.has(abs) && read.size >= TRACK_BUDGETS.maxMapEntries) {
			const substantial = w >= 0.5 || nl >= 100 || nh >= 50;
			if (!substantial) {
				bumpDir(dirOf(abs), 1);
				return;
			}
			let victim: string | null = null;
			let victimRank: [number, number, number, string] | null = null;
			for (const [p, e] of read) {
				const r = rankOf(e, p);
				if (victimRank === null || greaterRank(victimRank, r)) {
					victim = p;
					victimRank = r;
				}
			}
			const incoming: [number, number, number, string] = [w, nl, nh, abs];
			if (victim !== null && victimRank !== null && greaterRank(incoming, victimRank)) {
				read.delete(victim);
				bumpDir(dirOf(victim), 1); // evicted file still counts toward its root
			} else {
				bumpDir(dirOf(abs), 1);
				return;
			}
		}
		const prev = read.get(abs) ?? { weight: 0, lines: 0, hits: 0, via: "", modified: false };
		read.set(abs, {
			weight: Math.max(prev.weight, w),
			lines: prev.lines + (patch.lines ?? 0),
			hits: prev.hits + (patch.hits ?? 0),
			via: prev.via || patch.via || "",
			modified: prev.modified || patch.modified || false,
		});
	};
	// NOTE: no small-file shortcut — small reads stay in the map (bounded by
	// maxMapEntries) and accumulate across results. Thresholds apply only at the
	// 120-entry display cap, lightest-first. Dir counters take listings plus
	// map-overflow only.

	// Per-file grep hits: `path:line: ...` prefixes.
	const hits = new Map<string, number>();
	for (const l of lines) {
		const m = /^([^:\n]{1,300}):\d+:?/.exec(l);
		if (!m) continue;
		const t = m[1].trim();
		if (classifyToken(t) !== "path") continue;
		const abs = gate(t, cwd, statMemo, budget, tmpPrefix);
		if (abs) hits.set(abs, (hits.get(abs) ?? 0) + 1);
	}

	// `==> path <==` section markers (multi-file head/tail).
	const sections = new Map<string, number>();
	let current: string | null = null;
	for (const l of lines) {
		const m = /^==>\s*(.+?)\s*<==$/.exec(l.trim());
		if (m) {
			const abs = classifyToken(m[1]) === "path" ? gate(m[1], cwd, statMemo, budget, tmpPrefix) : null;
			current = abs;
			if (abs && !sections.has(abs)) sections.set(abs, 0);
			continue;
		}
		if (current) sections.set(current, (sections.get(current) ?? 0) + 1);
	}

	// Listing test on a SAMPLE: stat at most listingSample pathish lines.
	// Confirmed listings group the REST by string alone — no per-file stats.
	let sampled = 0;
	let sampleHits = 0;
	for (const l of lines) {
		if (sampled >= TRACK_BUDGETS.listingSample) break;
		const t = l.trim().replace(/\/$/, "");
		if (!t || classifyToken(t) !== "path") continue;
		sampled++;
		if (gate(t, cwd, statMemo, budget, tmpPrefix)) sampleHits++;
	}
	const allPathish =
		nonEmpty.length > 0 &&
		nonEmpty.every((l) => {
			// A `path:NN:` grep-hit line contains slashes but is a match, not a path.
			if (/^([^:\n]{1,300}):\d+:?/.test(l)) return false;
			const t = l.trim().replace(/\/$/, "");
			return !!t && classifyToken(t) === "path";
		});
	// Search-kind commands (find/ls/grep -l) produce listings by construction;
	// content-kind keeps the sampled vote (cat of a path-list is still content).
	const isListing = (p.kind === "search" && allPathish) || (sampled >= 5 && sampleHits / sampled > 0.6);

	if (isListing) {
		for (const l of lines) {
			const t = l.trim().replace(/\/$/, "");
			if (!t || classifyToken(t) !== "path") continue;
			if (/^([^:\n]{1,300}):\d+:?/.test(l)) continue; // grep-hit line, not a path
			// String-level dirname: the sample already proved these are paths.
			const s = resolve(cwd, t); // pure string normalize, zero syscalls
			const slash = s.lastIndexOf("/");
			bumpDir(slash > 0 ? s.slice(0, slash) : "/", 1);
		}
		return;
	}
	if (hits.size > 0) {
		for (const [abs, n] of hits) upsert(abs, { weight: 0.4, hits: n, via: "grep" });
		return;
	}
	if (sections.size > 0) {
		for (const [abs, n] of sections) upsert(abs, { weight: 0.8, lines: n, via: "" });
		return;
	}
	// Plain content: attribute volume to the command's files.
	const totalLines = allLines.length;
	if (p.files.length === 1) {
		const w = p.kind === "content" ? 0.8 : 0.3;
		const n = Math.min(totalLines, 5000);
		upsert(p.files[0], { weight: w, lines: n });
	} else if (p.files.length > 1) {
		const share = Math.max(1, Math.floor(totalLines / p.files.length));
		for (const f of p.files) {
			const w = p.kind === "content" ? 0.7 : 0.3;
			const n = Math.min(share, 5000);
			upsert(f, { weight: w, lines: n });
		}
	} else if (okResult && p.rawCandidates.length === 1 && p.rawCandidates[0] !== undefined) {
		// Success proxy: stat budget out (or file since deleted), but a successful
		// non-empty read proves it existed. Resolve by string — zero syscalls.
		const raw: string = p.rawCandidates[0];
		if (isSanePathString(raw)) { // same hygiene as gate, zero syscalls
			const abs = resolve(cwd, raw); // pure string normalize, zero syscalls
			// Depth floor: without stat we cannot tell file from dir, so refuse top-level
			// entries (`/tmp`, `/`) — a real read worth immortalizing is never that
			// shallow (`/etc/hosts` still passes). Zero syscalls.
			const depth = abs.split("/").filter((s) => s !== "").length;
			// Metachar floor: unexpanded shell fragments (`{a,b}.txt`, `$(x)`, `cat /r/f`
			// from ssh payloads) are never literal paths. The stat gate still admits
			// such names if they truly exist — this only binds the blind proxy.
			const hasMeta = /[{}$*?()[\]`\s]/.test(raw);
			if (depth >= 2 && !hasMeta && !isBannedPath(abs, tmpPrefix)) {
				upsert(abs, { weight: 0.4, lines: Math.min(totalLines, 5000), via: "unverified" });
			}
		}
	}
}

// Full pass over the summarized span. Never throws (fail-open to Tier 0).
function trackBashFiles(messages: unknown[], cwd: string): { read: Map<string, TrackedFile>; modified: Map<string, TrackedFile>; dirCounts: Map<string, number> } {
	const read = new Map<string, TrackedFile>();
	const modified = new Map<string, TrackedFile>();
	const dirCounts = new Map<string, number>();
	try {
		const statMemo = new Map<string, string | null>();
		const budget = { calls: 0 };
		const scriptsScanned = { n: 0 };
		const pending = new Map<string, PendingBash>();
		let synthN = 0; // synthetic ids for user `!` executions (no tool ids)
		let tmpPrefix = "/tmp";
		try {
			tmpPrefix = resolve(tmpdir());
		} catch {
			/* keep default */
		}
		for (const m of messages) {
			if (!m || typeof m !== "object") continue;
			const msg = m as { role?: unknown; content?: unknown; toolCallId?: unknown };
			try {
				// Raw `bashExecution` session entries (round-4 review): the span is normally
				// pre-converted to `Ran `cmd`` user text (test 18), but if pi ever hands us
				// raw entries, parse them the same way instead of silently dropping `!` runs.
				const rawExec = (m as { type?: unknown; command?: unknown; output?: unknown; exitCode?: unknown }).type === "bashExecution" ? (m as { command?: unknown; output?: unknown; exitCode?: unknown }) : null;
				if (rawExec && typeof rawExec.command === "string") {
					const output = typeof rawExec.output === "string" ? rawExec.output : "";
					if (output && output !== "(no output)") {
						const synthId = `userbash-${synthN++}`;
						analyzeBashCall(rawExec.command, cwd, synthId, pending, read, modified, statMemo, budget, tmpPrefix, scriptsScanned);
						const p = pending.get(synthId);
						if (p) {
							pending.delete(synthId);
							attributeResult({ content: [{ type: "text", text: output }], isError: typeof rawExec.exitCode === "number" && rawExec.exitCode !== 0 }, p, read, dirCounts, statMemo, budget, tmpPrefix, cwd);
						}
					}
				} else if (msg.role === "assistant" && Array.isArray(msg.content)) {
					for (const b of msg.content) {
						if (!b || typeof b !== "object") continue;
						const blk = b as { type?: unknown; name?: unknown; id?: unknown; arguments?: unknown };
						if (blk.type !== "toolCall" || blk.name !== "bash") continue;
							const args = blk.arguments as { command?: unknown } | null | undefined;
							analyzeBashCall(args?.command, cwd, typeof blk.id === "string" ? blk.id : null, pending, read, modified, statMemo, budget, tmpPrefix, scriptsScanned);
					}
				} else if (msg.role === "toolResult" && typeof msg.toolCallId === "string") {
					const p = pending.get(msg.toolCallId);
					if (!p) continue;
					pending.delete(msg.toolCallId);
						attributeResult(msg, p, read, dirCounts, statMemo, budget, tmpPrefix, cwd);
				} else if (msg.role === "user" && Array.isArray(msg.content)) {
					// User `!` executions serialize as text (`Ran `cmd`` + fenced output), not
					// toolCalls — parse the same envelope so their files join the map.
					for (const b of msg.content) {
						if (!b || typeof b !== "object" || (b as { type?: unknown }).type !== "text") continue;
						const t = (b as { text?: unknown }).text;
						if (typeof t !== "string") continue;
						const m = /^Ran `([^`\n]+)`([\s\S]*)$/.exec(t);
						if (!m || m[1] === undefined) continue;
						let rest = m[2] ?? "";
						if (rest.startsWith("\n```\n")) rest = rest.slice(5);
						const endFence = rest.lastIndexOf("\n```");
						const output = (endFence >= 0 ? rest.slice(0, endFence) : rest).trim();
						if (!output || output === "(no output)") continue;
						const isError = /Command exited with code [1-9]/.test(rest) || rest.includes("(command cancelled)");
						const synthId = `userbash-${synthN++}`;
						analyzeBashCall(m[1], cwd, synthId, pending, read, modified, statMemo, budget, tmpPrefix, scriptsScanned);
						const p = pending.get(synthId);
						if (!p) continue;
						pending.delete(synthId);
						attributeResult({ content: [{ type: "text", text: output }], isError }, p, read, dirCounts, statMemo, budget, tmpPrefix, cwd);
					}
				}
			} catch {
				/* per-message fail-open */
			}
		}
	} catch {
		/* whole-pass fail-open */
	}
	return { read, modified, dirCounts };
}

export default function (pi: ExtensionAPI) {
	pi.on("session_before_compact", async (event, ctx) => {
		// NOTE: customInstructions lives on the EVENT, not preparation
		// (SessionBeforeCompactEvent). Reading it from preparation silently drops
		// every `/compact focus...` — a real bug caught by external review.
		const { preparation, branchEntries, signal, customInstructions } = event as typeof event & { customInstructions?: unknown };
		const focus = typeof customInstructions === "string" ? customInstructions : undefined;
		const {
			messagesToSummarize,
			turnPrefixMessages,
			tokensBefore,
			firstKeptEntryId,
			previousSummary,
			fileOps,
		} = preparation;

		// Tier 0 (always present): read/write/edit tool files — the working set.
		// Accumulation-compatible with pi's default (plain paths in details).
		// pi SKIPS hook-provided details on the next prepare (!fromHook), so without
		// the union below our lists would reset every compaction. We re-accumulate
		// all prior compaction entries ourselves (bounded, oldest→newest, Sets dedupe;
		// re-adding pi's own lists is idempotent).
		const rawRead = (fileOps as { read?: Iterable<string> } | undefined)?.read ?? [];
		const rawWritten = (fileOps as { written?: Iterable<string> } | undefined)?.written ?? [];
		const rawEdited = (fileOps as { edited?: Iterable<string> } | undefined)?.edited ?? [];
		const accRead = new Set<string>([...rawRead].filter((p) => typeof p === "string" && isSanePathString(p)));
		const accEdited = new Set<string>(
			[...rawWritten, ...rawEdited].filter((p) => typeof p === "string" && isSanePathString(p)),
		);
		// Branch scope (round-4 review): getEntries() spans the whole tree, but this
		// compaction resumes ONE branch — only re-union compaction details from entries
		// on the current branch. Empty/unknown branch list = fall back to all (old).
		const branchIds = new Set(
			(Array.isArray(branchEntries) ? branchEntries : [])
				.map((e) => (e as { id?: unknown } | null | undefined)?.id)
				.filter((id): id is string => typeof id === "string"),
		);
		try {
			const entries = ctx.sessionManager?.getEntries?.() ?? [];
			let collected = 0;
			for (const e of entries) {
				if (collected >= TRACK_BUDGETS.maxAccumulatedPaths) break;
				if (!e || (e as { type?: unknown }).type !== "compaction") continue;
				if (branchIds.size > 0 && !branchIds.has((e as { id?: unknown }).id)) continue; // other branch: skip
				const d = (e as { details?: unknown }).details;
				if (!d || typeof d !== "object") continue;
				const rec = d as Record<string, unknown>;
				for (const key of ["readFiles", "modifiedFiles"] as const) {
					const arr = rec[key];
					if (!Array.isArray(arr)) continue;
					for (const p of arr) {
						if (collected >= TRACK_BUDGETS.maxAccumulatedPaths) break;
						if (typeof p !== "string" || !isSanePathString(p)) continue;
						// Self-cleaning: re-verify old entries (dirs + vanished files drop;
						// current-span Tier-0 keeps history blindly). Bounded: capped paths.
						let isFile = false;
						try { isFile = statSync(p).isFile(); } catch { isFile = false; }
						if (!isFile) continue;
						collected++;
						(key === "readFiles" ? accRead : accEdited).add(p);
					}
				}
			}
		} catch {
			/* preparation fileOps only */
		}
		const modifiedSet = accEdited;
		const tier0Read = [...accRead].filter((f) => !modifiedSet.has(f)).sort();
		const tier0Modified = [...modifiedSet].sort();

		// Bash tiers: best-effort, fail-open. Tier 0 always survives eviction.
		let bashRead: Map<string, TrackedFile> = new Map();
		let bashModified: Map<string, TrackedFile> = new Map();
		const directGroups = new Map<string, number>(); // small-fry + listing dir counts
		try {
			const cwd = typeof ctx.cwd === "string" && ctx.cwd ? ctx.cwd : process.cwd();
			const tracked = trackBashFiles([...messagesToSummarize, ...turnPrefixMessages], cwd);
			bashRead = tracked.read;
			bashModified = tracked.modified;
			for (const [d, n] of tracked.dirCounts) {
				directGroups.set(d, (directGroups.get(d) ?? 0) + n);
			}
		} catch {
			/* Tier 0 only */
		}

		const tier0Set = new Set<string>([...tier0Read, ...tier0Modified]);
		const ranked = [...bashRead.entries()]
			.filter(([p]) => !tier0Set.has(p))
			.sort((a, b) => b[1].weight - a[1].weight || b[1].lines - a[1].lines || b[1].hits - a[1].hits || (a[0] < b[0] ? -1 : 1));
		const bashBudget = Math.max(0, TRACK_BUDGETS.maxTotalEntries - tier0Set.size);
		const kept = ranked.slice(0, bashBudget);
		const dropped = ranked.slice(bashBudget);

		// Overflow + small-fry collapse to directory roots, then hierarchical rollup:
		// small groups merge into parents so sweeps converge on common roots.
		const dirGroups = new Map<string, number>(directGroups);
		for (const [p] of dropped) {
			const slash = p.lastIndexOf("/");
			const dir = slash > 0 ? p.slice(0, slash) : ".";
			dirGroups.set(dir, (dirGroups.get(dir) ?? 0) + 1);
		}
		let guard = 0;
		while (dirGroups.size > TRACK_BUDGETS.maxGroupLines * 4 && guard++ < 20) {
			let smallest: string | null = null;
			for (const [d, c] of dirGroups) {
				if (smallest === null || c < (dirGroups.get(smallest) as number)) smallest = d;
			}
			if (smallest === null) break;
			const count = dirGroups.get(smallest) as number;
			dirGroups.delete(smallest);
			const s = smallest.lastIndexOf("/");
			const parent = s > 0 ? smallest.slice(0, s) : "/";
			if (parent === smallest) {
				dirGroups.set(smallest, count);
				break;
			}
			dirGroups.set(parent, ((dirGroups.get(parent) ?? 0) as number) + count);
		}
		const grouped = [...dirGroups.entries()]
			.sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
			.slice(0, TRACK_BUDGETS.maxGroupLines)
			.map(([d, n]) => `${d}/... (${n} file${n === 1 ? "" : "s"})`);

		const fmt = (abs: string, t: TrackedFile): string => {
			if (t.hits > 0 && t.lines === 0) return `${abs} (${t.hits} grep hit${t.hits === 1 ? "" : "s"})`;
			if (t.lines > 0) return `${abs} (~${t.lines} lines${t.via && t.via !== "" ? `, ${t.via}` : ""})`;
			return t.via ? `${abs} (${t.via})` : abs;
		};
		const bashReadLines = kept.map(([p, t]) => fmt(p, t));
		const readFiles = [...tier0Read];
		const readDetails = [...tier0Read, ...kept.map(([p]) => p)];

		const bashModLines: string[] = [];
		const modDetails = [...tier0Modified];
		for (const [p, t] of bashModified) {
			if (tier0Set.has(p)) continue;
			bashModLines.push(t.via ? `${p} (via ${t.via})` : p);
			modDetails.push(p);
		}
		bashModLines.sort();

		const fileSection = [
			...(readFiles.length + bashReadLines.length + grouped.length
				? [`<read-files>\n${[...readFiles, ...bashReadLines, ...grouped].join("\n")}\n</read-files>`]
				: []),
			...(tier0Modified.length + bashModLines.length
				? [`<modified-files>\n${[...tier0Modified, ...bashModLines].join("\n")}\n</modified-files>`]
				: []),
		].join("\n\n");

		// Model selection: PI_COMPACTION_MODEL pin, else the built-in default summarizer,
		// else the session model. The default is a documented preference, not a lock-in —
		// any provider/model works via env, and an unresolvable default falls through.
		const cfg = resolveCompactionConfig();
		const rawModel = (process.env.PI_COMPACTION_MODEL ?? "").trim();
		if (rawModel && (!cfg.provider || !cfg.modelId)) {
			ctx.ui.notify(`Smart Compaction: ignoring malformed PI_COMPACTION_MODEL=${JSON.stringify(rawModel)} (want "provider/model-id"), using default summarizer`, "warning");
		}
		const model =
			(cfg.provider && cfg.modelId ? ctx.modelRegistry.find(cfg.provider, cfg.modelId) : undefined) ??
				ctx.modelRegistry.find(DEFAULT_PROVIDER, DEFAULT_MODEL_ID) ??
				ctx.model;
		if (!model) {
			ctx.ui.notify("Smart Compaction: no model available, using default compaction", "warning");
			return;
		}

		// Drop malformed entries up front: session files parse without validation
		// (old versions, forks, hand-edits), and convertToLlm assumes well-formed
		// objects — a single null content would kill the hook instead of falling back.
		const allMessages = [...messagesToSummarize, ...turnPrefixMessages].filter((m): m is NonNullable<typeof m> => {
			if (!m || typeof m !== "object") return false;
			const c = (m as { content?: unknown }).content;
			return c === undefined || typeof c === "string" || Array.isArray(c);
		});
		ctx.ui.notify(
			`Smart Compaction: summarizing ${allMessages.length} messages (${tokensBefore.toLocaleString()} tokens) with ${model.id}@${cfg.reasoning} (max ${cfg.maxTokens})...`,
			"info",
		);

		let conversationText: string;
		try {
			conversationText = serializeConversation(convertToLlm(allMessages));
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			ctx.ui.notify(`Smart Compaction: cannot serialize context (${message}), using default compaction`, "warning");
			return;
		}

		let basePrompt = previousSummary
			? `The messages above are NEW conversation messages to incorporate into the existing summary provided in <previous-summary> tags.\n\n${UPDATE_INSTRUCTIONS}`
			: BASE_PROMPT;
		if (focus) {
			basePrompt = `${basePrompt}\n\nAdditional focus: ${focus}`;
		}

		let promptText = `<conversation>\n${conversationText}\n</conversation>\n\n`;
		if (previousSummary) {
			promptText += `<previous-summary>\n${previousSummary}\n</previous-summary>\n\n`;
		}
		promptText += basePrompt;

		const modelMax = (model as { maxTokens?: unknown }).maxTokens as number | undefined;
		const baseBudget = Math.min(cfg.maxTokens, modelMax ?? cfg.maxTokens);
		const runOnce = (budget: number) =>
			ctx.modelRegistry.complete(
				model,
				{
					systemPrompt: SYSTEM_PROMPT,
					messages: [
						{
							role: "user" as const,
							content: [{ type: "text" as const, text: promptText }],
							timestamp: Date.now(),
						},
					],
				},
				{
					maxTokens: budget,
					signal,
					cacheRetention: "none",
					sessionId: uuidv7(),
					// Reasoning gate (round-4 review): only request thinking on models that
					// support it — otherwise the call throws and we lose the hook to fallback.
					// "off" disables thinking even on capable models.
					reasoning: cfg.reasoning !== "off" && (model as { reasoning?: unknown }).reasoning === true ? cfg.reasoning : undefined,
				},
			);
		try {
			let response = await runOnce(baseBudget);
			let stopReason = (response as { stopReason?: string }).stopReason;
			// Length-only retry (once, 2x budget): `length` means OUR budget was too small
			// for the span — not a transient. `error` still falls back immediately.
			const retryBudget = Math.min(baseBudget * 2, modelMax ?? baseBudget * 2);
			if (stopReason === "length" && retryBudget > baseBudget) {
				ctx.ui.notify(`Smart Compaction: summary hit ${baseBudget} tokens, retrying once at ${retryBudget}...`, "warning");
				response = await runOnce(retryBudget);
				stopReason = (response as { stopReason?: string }).stopReason;
			}
			// Same failure guards as pi: partial/errored output must never checkpoint.
			if (stopReason === "error" || stopReason === "length") {
				ctx.ui.notify(
					`Smart Compaction: summarizer stopped (${stopReason}), using default compaction`,
					"warning",
				);
				return;
			}
			if (response.content.some((block) => block.type === "toolCall")) {
				ctx.ui.notify("Smart Compaction: summarizer called a tool, using default compaction", "warning");
				return;
			}

			let summary = response.content
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map((c) => c.text)
				.join("\n");

			if (!summary.trim()) {
				if (!signal.aborted)
					ctx.ui.notify("Smart Compaction: empty summary, using default compaction", "warning");
				return;
			}
			if (fileSection) summary += `\n\n${fileSection}`;

			return {
				compaction: {
					summary,
					firstKeptEntryId,
					tokensBefore,
					usage: response.usage,
					details: { readFiles: readDetails, modifiedFiles: modDetails },
				},
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			ctx.ui.notify(`Smart Compaction failed (${message}), using default compaction`, "error");
			return;
		}
	});
}
