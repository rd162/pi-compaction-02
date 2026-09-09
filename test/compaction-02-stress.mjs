// Stress test: huge spans, real root/home paths, near-limit outputs, budget exhaustion.
// Run: node /tmp/muse-compaction-stress.mjs
import assert from "node:assert";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";

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

const FIX = "/tmp/mc-stress";
mkdirSync(FIX, { recursive: true });
writeFileSync(`${FIX}/big.log`, "x\n");

// Collect REAL paths (bounded, fast trees only) for listing/grep fixtures.
let realPaths = [];
try {
	const out = execFileSync("sh", ["-c", "find /opt/homebrew/lib /etc -type f 2>/dev/null | head -3000"], {
		encoding: "utf8",
		timeout: 60000,
		maxBuffer: 2 * 1024 * 1024,
	});
	realPaths = out.split("\n").filter(Boolean).slice(0, 3000);
} catch { realPaths = ["/etc/hosts", "/bin/ls"]; }
assert.ok(realPaths.length > 100, `need real paths, got ${realPaths.length}`);
console.log(`fixtures: ${realPaths.length} real paths`);

const home = process.env.HOME ?? "/Users/rd";
const okResponse = { content: [{ type: "text", text: "S" }], stopReason: "stop" };
function makeCtx(completeImpl) {
	const notices = [];
	return {
		ctx: {
			ui: { notify: (m, l) => notices.push([l, m]) },
			modelRegistry: { find: () => ({ id: "m" }), complete: completeImpl },
			model: { id: "mock-model", reasoning: true },
			cwd: FIX,
		},
		notices,
	};
}
let n = 0;
const bash = (command) => ({ role: "assistant", content: [{ type: "toolCall", id: `t${n}`, name: "bash", arguments: { command } }], timestamp: n });
const res = (text) => ({ role: "toolResult", toolCallId: `t${n++}`, toolName: "bash", content: [{ type: "text", text }], isError: false, timestamp: n });

// 300 pairs x ~40KB results: cats, greps, finds, scripts, garbage.
const bigChunk = "lorem ipsum dolor sit amet\n".repeat(1500).slice(0, 40000);
const grepOut = realPaths.slice(0, 400).map((p, i) => `${p}:${i + 1}: match here with some trailing content padding pad pad`).join("\n");
const findOut = realPaths.join("\n");
const msgs = [];
for (let i = 0; i < 100; i++) {
	msgs.push(bash(`cat ${FIX}/big.log | head -50 # ${i}`), res(bigChunk));
	msgs.push(bash(`rg -n "pattern${i}" ${realPaths[i % realPaths.length]}`), res(grepOut));
	msgs.push(bash(`find / -maxdepth 3 -name "*.log" 2>/dev/null | head -100 # ${i}`), res(findOut));
}
const prep = (extra = []) => ({
	messagesToSummarize: [...msgs, ...extra],
	turnPrefixMessages: [],
	tokensBefore: 999999,
	firstKeptEntryId: "x",
	previousSummary: undefined,
	customInstructions: undefined,
	fileOps: { read: new Set(), written: new Set(), edited: new Set() },
});

let handler;
mod.default({ on: (ev, fn) => { handler = fn; } });

// S1: wall time on the 900-message span
{
	const { ctx } = makeCtx(async () => okResponse);
	const t0 = Date.now();
	const out = await handler({ preparation: prep(), signal: {} }, ctx);
	const ms = Date.now() - t0;
	assert.ok(out?.compaction, "compaction returned");
	console.log(`S1 900-msg span: ${ms}ms, readDetails=${out.compaction.details.readFiles.length}, modified=${out.compaction.details.modifiedFiles.length}`);
	assert.ok(ms < 20000, `bounded time, took ${ms}ms`);
	globalThis.__s1 = JSON.stringify([out.compaction.summary, out.compaction.details]);
}
// S2: determinism — same span twice => identical output
{
	const { ctx } = makeCtx(async () => okResponse);
	const out = await handler({ preparation: prep(), signal: {} }, ctx);
	assert.equal(JSON.stringify([out.compaction.summary, out.compaction.details]), globalThis.__s1, "deterministic");
	console.log("S2 determinism OK");
}
// S3: budget exhaustion — 4000 unique nonexistent pathish tokens (stat budget 2000)
{
	const spam = [];
	for (let i = 0; i < 500; i++) spam.push(bash(`cat /nonexistent/dir${i}/file${i}.ts /also/missing${i}.js`), res("nope"));
	const { ctx } = makeCtx(async () => okResponse);
	const t0 = Date.now();
	const out = await handler({ preparation: prep(spam), signal: {} }, ctx);
	console.log(`S3 budget exhaustion: ${Date.now() - t0}ms, compaction=${!!out?.compaction}`);
	assert.ok(out?.compaction, "survives budget exhaustion");
}
// S4: home-dir + root sweep results, grouped output present
{
	const homeLines = [`${home}/.zshrc`, "/etc/hosts", "/etc/passwd", "/var/log/system.log", `${home}/Documents`].join("\n");
	const { ctx } = makeCtx(async () => okResponse);
	const out = await handler({ preparation: prep([bash("find / ~ -maxdepth 2 2>/dev/null"), res(homeLines)]), signal: {} }, ctx);
	assert.ok(out?.compaction, "root/home sweep survives");
	console.log("S4 root/home sweep OK");
}
console.log("STRESS ALL PASSED");
