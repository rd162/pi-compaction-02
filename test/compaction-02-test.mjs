// Ephemeral test for Smart Compaction extension. Run:
// node /tmp/muse-compaction-test.mjs
import assert from "node:assert";
import { createRequire } from "node:module";

const PI_ROOT = "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent";
const NM = `${PI_ROOT}/node_modules`;
const require = createRequire(`${PI_ROOT}/package.json`);
const { createJiti } = require(`${NM}/jiti`);

const jiti = createJiti(import.meta.url, {
	alias: {
		"@earendil-works/pi-coding-agent": `${PI_ROOT}/dist/index.js`,
		"@earendil-works/pi-ai": `${NM}/@earendil-works/pi-ai/dist/compat.js`,
	},
});

const mod = await jiti.import(new URL("../extensions/compaction-02.ts", import.meta.url).href);
assert.equal(typeof mod.default, "function", "default export is a factory");

function makeHarness(completeImpl, findResult = { id: "mock-model", reasoning: true }, cwd) { // mock stands in for Muse
	let handler;
	const pi = { on: (ev, fn) => { if (ev === "session_before_compact") handler = fn; } };
	const notices = [];
	const calls = [];
	const ctx = {
		ui: { notify: (msg, level) => notices.push([level, msg]) },
		modelRegistry: {
			find: (prov, id) => { calls.push(["find", prov, id]); return findResult; },
			complete: async (...args) => { calls.push(["complete", ...args]); return completeImpl(...args); },
		},
		model: findResult, // real pi always has a session model; findResult doubles as it
		...(cwd ? { cwd } : {}),
	};
	mod.default(pi);
	assert.ok(handler, "handler registered");
	return { handler, ctx, notices, calls };
}

const prep = {
	messagesToSummarize: [
		{ role: "user", content: "Add auth to the server", timestamp: 1 },
		{ role: "assistant", content: [{ type: "text", text: "Done, edited server.ts" }], timestamp: 2 },
	],
	turnPrefixMessages: [],
	tokensBefore: 50000,
	firstKeptEntryId: "abc123",
	previousSummary: undefined,
	fileOps: { read: new Set(["src/a.ts"]), written: new Set(), edited: new Set(["src/b.ts"]) },
};
// focus travels on the EVENT (SessionBeforeCompactEvent), never preparation
const ev = { preparation: prep, signal: {}, customInstructions: "focus on auth" };
const okResponse = {
	content: [{ type: "text", text: "## Goal\nAuth stuff" }],
	usage: { input: 1 },
	stopReason: "stop",
};

// 1. happy path
{
	const { handler, ctx, notices, calls } = makeHarness(async () => okResponse);
	const out = await handler(ev, ctx);
	assert.ok(out?.compaction, "returns compaction");
	assert.equal(out.compaction.firstKeptEntryId, "abc123");
	assert.equal(out.compaction.tokensBefore, 50000);
	assert.deepEqual(out.compaction.details, { readFiles: ["src/a.ts"], modifiedFiles: ["src/b.ts"] });
	assert.ok(out.compaction.summary.includes("## Goal\nAuth stuff"));
	assert.ok(out.compaction.summary.includes("<read-files>\nsrc/a.ts\n</read-files>"));
	assert.ok(out.compaction.summary.includes("<modified-files>\nsrc/b.ts\n</modified-files>"));
	const completeCall = calls.find((c) => c[0] === "complete");
	assert.ok(completeCall, "complete called");
	const [model, context, opts] = completeCall.slice(1);
	assert.equal(model.id, "mock-model");
	assert.ok(context.systemPrompt.includes("ONLY output the structured summary"), "system prompt set");
	const prompt = context.messages[0].content[0].text;
	assert.ok(prompt.includes("<conversation>"), "conversation wrapped");
	assert.ok(prompt.includes("Use this EXACT format"), "structured format");
	assert.ok(prompt.includes("Additional focus: focus on auth"), "custom instructions");
	assert.ok(!prompt.includes("<previous-summary>"), "no previous-summary tags");
	assert.equal(opts.maxTokens, 16384);
	assert.equal(opts.cacheRetention, "none");
	assert.ok(opts.sessionId);
	assert.equal(opts.reasoning, "medium");
	assert.ok(notices.some(([l, m]) => m.includes("Smart Compaction: summarizing 2 messages")));
	console.log("PASS 1 happy path");
}
// 2. previous summary -> update-merge prompt
{
	let seen = "";
	const { handler, ctx } = makeHarness(async (_m, c) => { seen = c.messages[0].content[0].text; return okResponse; });
	const out = await handler({ preparation: { ...prep, previousSummary: "OLD SUMMARY" }, signal: {} }, ctx);
	assert.ok(out?.compaction);
	assert.ok(seen.includes("<previous-summary>\nOLD SUMMARY\n</previous-summary>"), "prev summary tags");
	assert.ok(seen.includes("PRESERVE all existing information"), "update rules");
	console.log("PASS 2 update-merge prompt");
}
// 3. stopReason length -> fallback (never checkpoint partial text)
{
	const { handler, ctx, notices } = makeHarness(async () => ({ ...okResponse, stopReason: "length" }));
	const out = await handler(ev, ctx);
	assert.equal(out, undefined);
	assert.ok(notices.some(([l, m]) => m.includes("stopped (length)")));
	console.log("PASS 3 length guard");
}
// 4. toolCall block -> fallback
{
	const { handler, ctx } = makeHarness(async () => ({ content: [{ type: "toolCall" }], stopReason: "stop" }));
	assert.equal(await handler(ev, ctx), undefined);
	console.log("PASS 4 toolCall guard");
}
// 5. empty summary -> fallback
{
	const { handler, ctx } = makeHarness(async () => ({ content: [{ type: "text", text: "  " }], stopReason: "stop" }));
	assert.equal(await handler(ev, ctx), undefined);
	console.log("PASS 5 empty guard");
}
// 6. throw -> fallback, no crash
{
	const { handler, ctx, notices } = makeHarness(async () => { throw new Error("boom"); });
	assert.equal(await handler(ev, ctx), undefined);
	assert.ok(notices.some(([l, m]) => m.includes("Smart Compaction failed (boom)")));
	console.log("PASS 6 throw guard");
}
// 7. no model at all -> fallback
{
	const { handler, ctx } = makeHarness(async () => okResponse, null);
	assert.equal(await handler(ev, ctx), undefined);
	console.log("PASS 7 no-model guard");
}
// 8-12. bash tiers against a real fixture dir
{
	import("node:fs").then(async ({ mkdirSync, writeFileSync }) => {
		const FIX = "/tmp/mc-fixtures";
		mkdirSync(FIX, { recursive: true });
		writeFileSync(`${FIX}/a.ts`, "line1\nline2\nline3\n");
		writeFileSync(`${FIX}/out.log`, "old\n");
		writeFileSync(`${FIX}/script.py`, 'import json\nopen("data.json").read()\n');
		writeFileSync(`${FIX}/data.json`, "{}");
		const bash = (id, command) => ({ role: "assistant", content: [{ type: "toolCall", id, name: "bash", arguments: { command } }], timestamp: 3 });
		const res = (toolCallId, text) => ({ role: "toolResult", toolCallId, toolName: "bash", content: [{ type: "text", text }], isError: false, timestamp: 4 });
		const A = `${FIX}/a.ts`;
		// 8. single-file cat attributes lines
		{
			const { handler, ctx } = makeHarness(async () => okResponse, undefined, FIX);
				const out = await handler({ preparation: { ...prep, previousSummary: undefined, customInstructions: undefined, messagesToSummarize: [bash("c1", "cat a.ts"), res("c1", "line1\nline2\nline3")], fileOps: { read: new Set(), written: new Set(), edited: new Set() } }, signal: {} }, ctx);
			assert.ok(out?.compaction.summary.includes(`${A} (~3 lines)`), "cat lines attributed");
			assert.ok(out.compaction.details.readFiles.includes(A));
			console.log("PASS 8 cat attribution");
		}
		// 9. grep hits tier (pattern must NOT become a file)
		{
			const { handler, ctx } = makeHarness(async () => okResponse, undefined, FIX);
				const out = await handler({ preparation: { ...prep, previousSummary: undefined, customInstructions: undefined, messagesToSummarize: [bash("c2", "rg -n foo a.ts"), res("c2", "a.ts:1: foo bar\na.ts:2: foo baz")], fileOps: { read: new Set(), written: new Set(), edited: new Set() } }, signal: {} }, ctx);
			assert.ok(out?.compaction.summary.includes(`${A} (2 grep hits)`), "grep hits counted");
			assert.ok(!out.compaction.details.readFiles.some((p) => p.endsWith("/foo") || p === "foo"), "pattern not a file");
			console.log("PASS 9 grep hits");
		}
		// 10. find output is a listing, not content
		{
			const { handler, ctx } = makeHarness(async () => okResponse, undefined, FIX);
				const out = await handler({ preparation: { ...prep, previousSummary: undefined, customInstructions: undefined, messagesToSummarize: [bash("c3", "find . -name '*.ts'"), res("c3", "./a.ts")], fileOps: { read: new Set(), written: new Set(), edited: new Set() } }, signal: {} }, ctx);
			assert.ok(out?.compaction.summary.includes(`${FIX}/... (1 file)`), "listing grouped by dir");
			assert.ok(!out.compaction.details.readFiles.includes(A), "listing not a per-file read");
			console.log("PASS 10 listing detection");
		}
		// 11. redirect target is modified tier; /dev/null + /tmp excluded
		{
			const { handler, ctx } = makeHarness(async () => okResponse, undefined, FIX);
				const out = await handler({ preparation: { ...prep, previousSummary: undefined, customInstructions: undefined, messagesToSummarize: [bash("c4", "echo hi > out.log; cat /dev/null"), res("c4", "hi")], fileOps: { read: new Set(), written: new Set(), edited: new Set() } }, signal: {} }, ctx);
			assert.ok(out?.compaction.details.modifiedFiles.includes(`${FIX}/out.log`), "redirect = modified");
			assert.ok(!JSON.stringify(out.compaction).includes("/dev/null"), "/dev/null excluded");
			console.log("PASS 11 redirect + denylist");
		}
		// 12. executed script + hardcoded path inside it + inline -c code
		{
			const { handler, ctx } = makeHarness(async () => okResponse, undefined, FIX);
				const out = await handler({ preparation: { ...prep, previousSummary: undefined, customInstructions: undefined, messagesToSummarize: [bash("c5", "python script.py"), res("c5", "ok"), bash("c6", "python -c \"open('a.ts').read()\""), res("c6", "ok")], fileOps: { read: new Set(), written: new Set(), edited: new Set() } }, signal: {} }, ctx);
			const s = out?.compaction.summary ?? "";
			assert.ok(s.includes(`${FIX}/script.py (`) && s.includes("executed"), "script executed");
			assert.ok(s.includes(`${FIX}/data.json (via script.py)`), "hardcoded path in script");
			assert.ok(s.includes(`${A} (inline-code)`), "inline -c path");
			console.log("PASS 12 script + inline code");
		}
		// 13. adversarial: giant command, giant result, garbage shapes — no hang, no crash
		{
			const { handler, ctx } = makeHarness(async () => okResponse, undefined, FIX);
				const big = "cat " + "a".repeat(30000) + " 'unterminated";
				const bigRes = "x".repeat(60000).split("").join("\n").slice(0, 120000);
				const t0 = Date.now();
				const out = await handler({ preparation: { ...prep, previousSummary: undefined, customInstructions: undefined, messagesToSummarize: [bash("c7", big), res("c7", bigRes), { role: "assistant", content: null }, null, bash("c8", "rm -rf / --no-preserve-root"), res("c8", "")], fileOps: { read: new Set(), written: new Set(), edited: new Set() } }, signal: {} }, ctx);
				assert.ok(Date.now() - t0 < 5000, "bounded time");
			assert.ok(out?.compaction, "Tier 0 path intact");
			console.log("PASS 13 adversarial/time-bounded");
		}
		// 14. focus ONLY from event: prep-level focus must not leak into prompt
		{
			let seen = "";
			const { handler, ctx } = makeHarness(async (_m, c) => { seen = c.messages[0].content[0].text; return okResponse; }, undefined, FIX);
			const out = await handler({ preparation: { ...prep, previousSummary: undefined, customInstructions: "SNEAKY-PREP-FOCUS", messagesToSummarize: [], fileOps: { read: new Set(), written: new Set(), edited: new Set() } }, signal: {} }, ctx);
			assert.ok(out?.compaction, "compaction returned");
			assert.ok(!seen.includes("Additional focus"), "prep-level focus ignored");
			assert.ok(!seen.includes("SNEAKY-PREP-FOCUS"), "prep focus text absent");
			const out2 = await handler({ preparation: { ...prep, previousSummary: undefined, customInstructions: "SNEAKY-PREP-FOCUS", messagesToSummarize: [], fileOps: { read: new Set(), written: new Set(), edited: new Set() } }, signal: {}, customInstructions: "EVENT-FOCUS-XYZ" }, ctx);
			assert.ok(out2?.compaction, "compaction returned");
			assert.ok(seen.includes("Additional focus: EVENT-FOCUS-XYZ"), "event focus honored");
			console.log("PASS 14 event-level focus");
		}
		// 15. accumulation: prior compaction details (pi + hook) merge into Tier 0
		{
			const { handler, ctx } = makeHarness(async () => okResponse, undefined, FIX);
			for (const f of ["old-a.ts", "hook-a.ts", "old-m.ts", "new-a.ts"]) writeFileSync(`${FIX}/${f}`, "x\n");
			const OA = `${FIX}/old-a.ts`, HA = `${FIX}/hook-a.ts`, OM = `${FIX}/old-m.ts`, NA = `${FIX}/new-a.ts`;
			ctx.sessionManager = { getEntries: () => [
				{ type: "compaction", id: "old1", details: { readFiles: [OA], modifiedFiles: [OM] } },
				{ type: "compaction", id: "old2", fromHook: true, details: { readFiles: [HA], modifiedFiles: [] } },
				{ type: "message", id: "m1" },
			] };
			const out = await handler({ preparation: { ...prep, previousSummary: undefined, customInstructions: undefined, messagesToSummarize: [], fileOps: { read: new Set([NA]), written: new Set(), edited: new Set() } }, signal: {} }, ctx);
			assert.ok(out?.compaction.details.readFiles.includes(OA), "pi details merged");
			assert.ok(out.compaction.details.readFiles.includes(HA), "hook details merged despite fromHook");
			assert.ok(out.compaction.details.readFiles.includes(NA), "current span kept");
			assert.ok(out.compaction.details.modifiedFiles.includes(OM), "modified merged");
			console.log("PASS 15 cross-compaction accumulation");
		}
		// 16. write verbs: tee/cp/touch land in modified tier
		{
			writeFileSync(`${FIX}/dest.log`, "");
			const { handler, ctx } = makeHarness(async () => okResponse, undefined, FIX);
			const out = await handler({ preparation: { ...prep, previousSummary: undefined, customInstructions: undefined, messagesToSummarize: [bash("c9", "echo hi | tee dest.log"), res("c9", "hi"), bash("c10", "cp dest.log dest2.log"), res("c10", "")], fileOps: { read: new Set(), written: new Set(), edited: new Set() } }, signal: {} }, ctx);
			assert.ok(out?.compaction.details.modifiedFiles.includes(`${FIX}/dest.log`), "tee = modified");
			console.log("PASS 16 write verbs");
		}
		// 17. hygiene: dirs, multiline blobs, header-shaped tokens never enter details
		{
			const { handler, ctx } = makeHarness(async () => okResponse, undefined, FIX);
			ctx.sessionManager = { getEntries: () => [
				{ type: "compaction", id: "junk", details: { readFiles: ["/x/\nimport y;", "Content-Type: application/json", "/tmp/mc-fixtures/", "/tmp", `${FIX}/a.ts`], modifiedFiles: [] } },
			] };
			const out = await handler({ preparation: { ...prep, previousSummary: undefined, customInstructions: undefined, messagesToSummarize: [bash("c11", "ls /tmp/mc-fixtures"), res("c11", "a.ts"), bash("c12", "curl -H 'Content-Type: application/json' http://x"), res("c12", "ok")], fileOps: { read: new Set([`${FIX}/out.log`]), written: new Set(), edited: new Set() } }, signal: {} }, ctx);
			const rf = out?.compaction.details.readFiles ?? [];
			assert.ok(!rf.some((p) => p.includes("\n")), "no multiline blob");
			assert.ok(!rf.some((p) => p.includes("Content-Type")), "no header token");
			assert.ok(!rf.some((p) => p.endsWith("/")), "no directory entries");
			assert.ok(rf.includes(`${FIX}/a.ts`), "sane accumulated path kept");
			console.log("PASS 17 ingress hygiene");
		}
		// 18. user `!` executions (bashExecution envelope) join the map
		{
			const { handler, ctx } = makeHarness(async () => okResponse, undefined, FIX);
			const out = await handler({ preparation: { ...prep, previousSummary: undefined, customInstructions: undefined, messagesToSummarize: [{ role: "user", content: [{ type: "text", text: "Ran `cat a.ts`\n```\nline1\nline2\n```" }], timestamp: 5 }], fileOps: { read: new Set(), written: new Set(), edited: new Set() } }, signal: {} }, ctx);
			assert.ok(out?.compaction.details.readFiles.includes(`${FIX}/a.ts`), "user-bash file tracked");
			assert.ok(out.compaction.summary.includes(`${FIX}/a.ts (~2 lines)`), "user-bash volume attributed");
			console.log("PASS 18 user-bang executions");
		}
		// 19. success-proxy depth floor: top-level dirs refused, deep vanished files kept
		{
			const { handler, ctx } = makeHarness(async () => okResponse, undefined, FIX);
			writeFileSync(`${FIX}/gone.ts`, "a\n");
			const { unlinkSync } = await import("node:fs");
			unlinkSync(`${FIX}/gone.ts`); // gate misses, proxy must still admit (depth 3)
			const out = await handler({ preparation: { ...prep, previousSummary: undefined, customInstructions: undefined, messagesToSummarize: [bash("c13", "cat /tmp"), res("c13", "x\ny\nz"), bash("c14", `cat ${FIX}/gone.ts`), res("c14", "a")], fileOps: { read: new Set(), written: new Set(), edited: new Set() } }, signal: {} }, ctx);
			const rf = out?.compaction.details.readFiles ?? [];
			assert.ok(!rf.includes("/tmp"), "proxy refuses top-level dir");
			assert.ok(rf.includes(`${FIX}/gone.ts`), "proxy keeps deep vanished file");
			console.log("PASS 19 proxy depth floor");
		}
		// 20. declared writes: redirect/tee/cp to NEW files land in modified (no gate)
		{
			const { handler, ctx } = makeHarness(async () => okResponse, undefined, FIX);
			const out = await handler({ preparation: { ...prep, previousSummary: undefined, customInstructions: undefined, messagesToSummarize: [bash("c15", "echo hi > brandnew.log"), res("c15", ""), bash("c16", "cat e2.txt | tee teed.log"), res("c16", "x"), bash("c17", "cp e2.txt cpd.log"), res("c17", "")], fileOps: { read: new Set(), written: new Set(), edited: new Set() } }, signal: {} }, ctx);
			const mf = out?.compaction.details.modifiedFiles ?? [];
			assert.ok(mf.includes(`${FIX}/brandnew.log`), "redirect to new file tracked");
			assert.ok(mf.includes(`${FIX}/teed.log`), "pipeline tee to new file tracked");
			assert.ok(mf.includes(`${FIX}/cpd.log`), "cp dest new file tracked");
			console.log("PASS 20 declared writes");
		}
		// 21. raw bashExecution entries (unconverted `!` shape) join the map
		{
			const { handler, ctx } = makeHarness(async () => okResponse, undefined, FIX);
			const out = await handler({ preparation: { ...prep, previousSummary: undefined, customInstructions: undefined, messagesToSummarize: [{ type: "bashExecution", command: "cat a.ts", output: "line1\nline2", exitCode: 0 }], fileOps: { read: new Set(), written: new Set(), edited: new Set() } }, signal: {} }, ctx);
			assert.ok(out?.compaction.details.readFiles.includes(`${FIX}/a.ts`), "raw envelope tracked");
			console.log("PASS 21 raw bashExecution");
		}
		// 22. accumulation is branch-scoped: other-branch compactions do not leak
		{
			const { handler, ctx } = makeHarness(async () => okResponse, undefined, FIX);
			ctx.sessionManager = { getEntries: () => [
				{ type: "compaction", id: "cA", details: { readFiles: [`${FIX}/a.ts`], modifiedFiles: [] } },
				{ type: "compaction", id: "cB", details: { readFiles: [`${FIX}/out.log`], modifiedFiles: [] } },
			] };
			const out = await handler({ preparation: { ...prep, previousSummary: undefined, customInstructions: undefined, messagesToSummarize: [], fileOps: { read: new Set(), written: new Set(), edited: new Set() } }, signal: {}, branchEntries: [{ id: "cA" }, { id: "m9" }] }, ctx);
			assert.ok(out?.compaction.details.readFiles.includes(`${FIX}/a.ts`), "same-branch kept");
			assert.ok(!out.compaction.details.readFiles.includes(`${FIX}/out.log`), "other-branch dropped");
			console.log("PASS 22 branch-scoped accumulation");
		}
		// 23. reasoning gate: only thinking models get the reasoning param
		{
			const mk = (findResult) => makeHarness(async () => okResponse, findResult, FIX);
			const a = mk({ id: "plain" });
			await a.handler({ preparation: { ...prep, previousSummary: undefined, customInstructions: undefined }, signal: {} }, a.ctx);
			const plainOpts = a.calls.find((c) => c[0] === "complete")[3];
			assert.equal(plainOpts.reasoning, undefined, "no reasoning for plain model");
			const b = mk({ id: "thinker", reasoning: true });
			await b.handler({ preparation: { ...prep, previousSummary: undefined, customInstructions: undefined }, signal: {} }, b.ctx);
			const thinkOpts = b.calls.find((c) => c[0] === "complete")[3];
			assert.equal(thinkOpts.reasoning, "medium", "reasoning kept for thinking model");
			console.log("PASS 23 reasoning gate");
		}
		// 24. env config: PI_COMPACTION_MODEL/REASONING/MAX_TOKENS (restored after)
		{
			const saved = { ...process.env };
			try {
				process.env.PI_COMPACTION_MODEL = "openrouter/m-1";
				process.env.PI_COMPACTION_REASONING = "xhigh";
				process.env.PI_COMPACTION_MAX_TOKENS = "100000";
				const h = makeHarness(async () => okResponse, { id: "env-model", reasoning: true, maxTokens: 8000 }, FIX);
				await h.handler({ preparation: { ...prep, previousSummary: undefined, customInstructions: undefined }, signal: {} }, h.ctx);
				const findCall = h.calls.find((c) => c[0] === "find");
				assert.deepEqual([findCall[1], findCall[2]], ["openrouter", "m-1"], "provider/id split");
				const opts = h.calls.find((c) => c[0] === "complete")[3];
				assert.equal(opts.reasoning, "xhigh", "reasoning override");
				assert.equal(opts.maxTokens, 8000, "clamped to model max (100000 -> 65536 -> 8000)");
				delete process.env.PI_COMPACTION_MODEL;
				process.env.PI_COMPACTION_REASONING = "bogus";
				process.env.PI_COMPACTION_MAX_TOKENS = "abc";
				const h2 = makeHarness(async () => okResponse, { id: "m", reasoning: true }, FIX);
				await h2.handler({ preparation: { ...prep, previousSummary: undefined, customInstructions: undefined }, signal: {} }, h2.ctx);
				const opts2 = h2.calls.find((c) => c[0] === "complete")[3];
				assert.equal(opts2.reasoning, "medium", "invalid reasoning -> default");
				assert.equal(opts2.maxTokens, 16384, "invalid maxTokens -> default");
				assert.ok(!h2.calls.some((c) => c[0] === "find"), "no env model -> session model, find skipped");
				process.env.PI_COMPACTION_MODEL = "nonsense-no-slash";
				const h3 = makeHarness(async () => okResponse, { id: "sess", reasoning: false }, FIX);
				const out3 = await h3.handler({ preparation: { ...prep, previousSummary: undefined, customInstructions: undefined }, signal: {} }, h3.ctx);
				assert.ok(out3?.compaction, "malformed model -> session fallback still compacts");
			} finally {
				for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
				Object.assign(process.env, saved);
			}
			console.log("PASS 24 env config");
		}
		console.log("ALL TESTS PASSED");
	});
}
