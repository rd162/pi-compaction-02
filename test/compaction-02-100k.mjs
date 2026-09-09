// 100k-file scale test: sort keeps largest, small fry -> common-root groups.
// Run: node /tmp/muse-compaction-100k.mjs
import assert from "node:assert";
import { createRequire } from "node:module";

const PI_ROOT = "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent";
const require = createRequire(`${PI_ROOT}/package.json`);
const { createJiti } = require(`${PI_ROOT}/node_modules/jiti`);
const jiti = createJiti(import.meta.url, {
	alias: {
		"@earendil-works/pi-coding-agent": `${PI_ROOT}/dist/index.js`,
		"@earendil-works/pi-ai": `${PI_ROOT}/node_modules/@earendil-works/pi-ai/dist/compat.js`,
	},
});
const mod = await jiti.import("/Users/rd/.pi/agent/extensions/custom-compaction.ts");
let handler;
mod.default({ on: (ev, fn) => { handler = fn; } });
const okResponse = { content: [{ type: "text", text: "S" }], stopReason: "stop" };
const ctx = {
	ui: { notify: () => {} },
	modelRegistry: { find: () => ({ id: "m" }), complete: async () => okResponse },
	model: { id: "mock-model", reasoning: true },
	cwd: "/tmp/mc-fixtures",
};

let n = 0;
const bash = (command) => ({ role: "assistant", content: [{ type: "toolCall", id: `h${n}`, name: "bash", arguments: { command } }], timestamp: n });
const res = (text) => ({ role: "toolResult", toolCallId: `h${n++}`, toolName: "bash", content: [{ type: "text", text }], isError: false, timestamp: n });
const tiny = "l1\nl2\nl3";
const big = Array.from({ length: 400 }, (_, i) => `line ${i} with content padding pad pad`).join("\n");

// 100k heads across two project dirs (nonexistent -> success-proxy path) + 5 big ones.
const msgs = [];
for (let i = 0; i < 100000; i++) {
	const dir = i % 2 === 0 ? "/tmp/mc-big/proj/a" : "/tmp/mc-big/proj/b";
	msgs.push(bash(`head -5 ${dir}/f${String(i).padStart(6, "0")}.log`), res(tiny));
}
for (let i = 0; i < 5; i++) {
	msgs.push(bash(`head -500 /tmp/mc-big/proj/a/IMPORTANT${i}.log`), res(big));
}
const prep = {
	messagesToSummarize: msgs,
	turnPrefixMessages: [],
	tokensBefore: 1,
	firstKeptEntryId: "x",
	previousSummary: undefined,
	customInstructions: undefined,
	fileOps: { read: new Set(), written: new Set(), edited: new Set() },
};

const t0 = Date.now();
const out = await handler({ preparation: prep, signal: {} }, ctx);
const ms = Date.now() - t0;
const summary = out?.compaction?.summary ?? "";
const details = out?.compaction?.details;
console.log(`100010 pairs in ${ms}ms`);
assert.ok(out?.compaction, "compaction returned");
assert.ok(ms < 60000, `bounded: ${ms}ms`);

// Largest kept individually (400-line reads sort above 3-line fry).
for (let i = 0; i < 5; i++) {
	assert.ok(summary.includes(`/tmp/mc-big/proj/a/IMPORTANT${i}.log (~400 lines, unverified)`), `big file ${i} kept`);
}
// Small fry collapsed to common roots (grouped, not listed one by one).
assert.ok(summary.includes("/tmp/mc-big/proj/a/... ("), "root group a present");
assert.ok(summary.includes("/tmp/mc-big/proj/b/... ("), "root group b present");
const mA = summary.match(/\/tmp\/mc-big\/proj\/a\/\.\.\. \((\d+) files\)/);
const mB = summary.match(/\/tmp\/mc-big\/proj\/b\/\.\.\. \((\d+) files\)/);
assert.ok(mA && mB, "group counts present");
console.log(`groups: a=${mA[1]} b=${mB[1]} (expect ~49940/50000, rest in kept 120)`);
assert.ok(Number(mA[1]) > 49000 && Number(mB[1]) > 49000, "bulk grouped");
// Display cap respected.
const groupLines = summary.split("\n").filter((l) => l.endsWith("files)") || l.endsWith("file)"));
assert.ok(groupLines.length <= 12, `groups capped at 12, got ${groupLines.length}`);
// details carry plain paths for accumulation.
assert.ok(details.readFiles.length <= 120 + 5, `details capped-ish: ${details.readFiles.length}`);
console.log("100K TEST PASSED");
