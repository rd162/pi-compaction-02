// Exotic-tool battery for Muse Compaction tracker. Run:
// node /tmp/muse-compaction-stress2.mjs
// Feeds real-world commands from non-standard CLI tools (jq/jd/difft/bat/eza/
// sqlite3/ast-grep/ffmpeg/...) as STRINGS (tracker never executes) + plausible
// outputs. Asserts: never throws, deterministic, bounded, no junk.
import assert from "node:assert";
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";

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
const mod = await jiti.import(new URL("../extensions/pi-compaction.ts", import.meta.url).href);

const FIX = "/tmp/mc-exotic";
if (!existsSync(FIX)) mkdirSync(FIX, { recursive: true });
writeFileSync(`${FIX}/a.json`, JSON.stringify({ users: [{ name: "ann", age: 31 }] }) + "\n");
writeFileSync(`${FIX}/b.yaml`, "a:\n  b: 1\n");
writeFileSync(`${FIX}/c.xml`, "<root><v>1</v></root>\n");
writeFileSync(`${FIX}/e.txt`, "alpha\nbeta\ngamma\n");
writeFileSync(`${FIX}/f1.txt`, "one\ntwo\n");
writeFileSync(`${FIX}/f2.txt`, "one\n2\n");
writeFileSync(`${FIX}/bundle.tgz`, "fake-tgz\n");
writeFileSync(`${FIX}/bundle.zip`, "fake-zip\n");
writeFileSync(`${FIX}/img.png`, "fake-png\n");
try { execFileSync("sqlite3", [`${FIX}/d.db`, "drop table if exists t; create table t(x); insert into t values (1);"]); } catch {}

function makeHarness() {
	let handler;
	const pi = { on: (ev, fn) => { if (ev === "session_before_compact") handler = fn; } };
	const ctx = {
		ui: { notify: () => {} },
		modelRegistry: {
			find: () => ({ id: "mock" }),
			complete: async () => ({ content: [{ type: "text", text: "## Goal\nx" }], usage: {}, stopReason: "stop" }),
		},
		model: { id: "mock-model", reasoning: true }, cwd: FIX,
	};
	mod.default(pi);
	return { handler, ctx };
}
let n = 0;
const bash = (cmd) => ({ role: "assistant", content: [{ type: "toolCall", name: "bash", id: `c${n++}`, arguments: { command: cmd } }], timestamp: n });
const res = (id, text, isError = false) => ({ role: "toolResult", toolCallId: id, content: [{ type: "text", text }], isError });

const BATTERY = [
	["jq '.users[] | select(.age > 30)' a.json", '{"name":"ann","age":31}'],
	["jq -r '.users[].name' a.json > names.txt", ""],
	["jq -s . a.json b.yaml", "[]"],
	["jd f1.txt f2.txt", "@@ -1,2 +1,2 @@\n-one\n+1one"],
	["difft f1.txt f2.txt", "1 |one |two"],
	["delta --side-by-side --file-style=red f1.txt", "diff"],
	["bat --style=numbers --color=never e.txt", "   1 alpha\n   2 beta"],
	["eza -la --git --icons=never", "drwxr-xr-x a.json\n-rw-r--r-- e.txt"],
	["rg -n 'alpha|beta' --no-heading", "e.txt:1:alpha\ne.txt:2:beta"],
	["rg --json 'alpha'", '{"type":"match","data":{"path":{"text":"e.txt"},"line_number":1}}'],
	["fd -e json . ", "a.json"],
	["yq '.a.b' b.yaml", "1\n"],
	["xq '.root.v' c.xml", '"1"\n'],
	["gron a.json", 'json = {};\njson.users = [];'],
	['sqlite3 d.db "select * from t;"', "1"],
	["sqlite3 d.db < q.sql", ""],
	["ast-grep --pattern 'console.log($X)' --lang ts", "a.ts:1:console.log(x)"],
	["tar -tzf bundle.tgz", "a.json"],
	["unzip -l bundle.zip", "a.json"],
	["ffmpeg -i clip.mp4 -ss 00:00:01 thumb.png", "Output file is empty"],
	["magick identify img.png", "img.png PNG 1x1"],
	["openssl dgst -sha256 e.txt", "SHA2-256(e.txt)= abc"],
	["xxd e.txt | head -3", "00000000: 616c..."],
	["strings -n 5 e.txt", "alpha"],
	["file --mime-type e.txt", "e.txt: text/plain"],
	["stat -f '%N %z' e.txt", "e.txt 17"],
	["git log --oneline -5", "abc123 fix"],
	["git diff --stat", "a.ts | 2 +-"],
	["gh issue list --limit 5", "#1 open bug"],
	["docker ps --format '{{.Names}}'", "web"],
	["kubectl get pods -o name", "pod/web-0"],
	["curl -s https://example.com/api | jq .", '{"ok":true}'],
	["wget -qO- http://x/y > page.html", ""],
	['ssh user@host "cat /remote/file"', "data"],
	["scp a.json user@host:/tmp/a.json", ""],
	["sudo cat /etc/hosts", "127.0.0.1 localhost"],
	["time -p cat e.txt", "alpha\nreal 0.01"],
	["env FOO=1 BAR=2 cat e.txt", "alpha"],
	["xargs -I{} cat {} < list.txt", "alpha"],
	["find . -name '*.json' -exec cat {} \\;", '{"users":[]}'],
	["python3 -c \"import json; print(open('a.json').read())\"", '{"users":[]}'],
	["python3 - <<'EOF'\nimport yaml\nprint(open('b.yaml').read())\nEOF", "a:\n  b: 1"],
	["node -e \"require('fs').readFileSync('e.txt','utf8')\"", "alpha"],
	["VAR1=x VAR2='a b' cat e.txt && echo done || echo fail; cat f1.txt", "alpha\ndone\none"],
	["(cd /tmp && cat mc-exotic/e.txt)", "alpha"],
	["cat $(echo e.txt)", "alpha"],
	["cat `echo e.txt`", "alpha"],
	["cat *.txt", "alpha\none"],
	["cat ./{e,f1}.txt", "alpha\none"],
	["printf 'a\\0b\\n' | xxd", "00000000: 6100..."],
	["cat e.txt | tee copy.txt | wc -l", "3"],
	["just --list", "Available recipes:"],
	["mdls e.txt", "kMDItemContentType = public.plain-text"],
	["sips -g all e.txt 2>&1 | head -2", "pixelWidth: 1"],
	["glow -s auto README.md", "# title"],
	["cloc --json . ", '{"header":{}}'],
	["tree -L 1 -J", '{"type":"directory"}'],
	["difft --display side-by-side f1.txt f2.txt | head -20", "diff"],
	["icdiff f1.txt f2.txt", "one"],
	["jq -Rn '[inputs]' e.txt", '["alpha","beta"]'],
	["yq -o=json '.' b.yaml | jq .a", '{"b":1}'],
];

async function runOnce() {
	const { handler, ctx } = makeHarness();
	const msgs = [];
	for (const [cmd, out] of BATTERY) {
		const b = bash(cmd);
		msgs.push(b, res(b.content[0].id, out));
	}
	// hostile inputs run separately: huge results may legitimately trip the
	// fail-open fallback (returns undefined) — that is correct, never a throw.
	if (process.env.STRESS2_HOSTILE) {
		const big = bash("rg -n 'e' /big");
		msgs.push(big, res(big.content[0].id, "x".repeat(200000)));
		msgs.push({ role: "assistant", content: [{ type: "toolCall", name: "bash", id: "null1", arguments: null }], timestamp: 999 });
		msgs.push({ role: "toolResult", toolCallId: "null1", content: null });
	}
	const t0 = Date.now();
	const out = await handler({ preparation: {
		messagesToSummarize: msgs, turnPrefixMessages: [], tokensBefore: 1,
		firstKeptEntryId: "k", previousSummary: undefined, customInstructions: undefined,
		fileOps: { read: new Set(), written: new Set(), edited: new Set() },
	}, signal: {} }, ctx);
	return { out, ms: Date.now() - t0 };
}

const r1 = await runOnce();
if (process.env.STRESS2_HOSTILE) { assert.ok(r1.out?.compaction === undefined || r1.out?.compaction, "hostile: clean fallback or complete, never throw"); } else assert.ok(r1.out?.compaction, "battery completes");
console.log(`battery ms: ${r1.ms}`);
assert.ok(r1.ms < 10000, "bounded");
const r2 = await runOnce();
if (process.env.STRESS2_HOSTILE) { assert.equal(r2.out, undefined, "hostile fallback is deterministic"); console.log("HOSTILE CLEAN FALLBACK PASSED"); process.exit(0); }
assert.deepEqual(r2.out.compaction.details, r1.out.compaction.details, "deterministic");
const rf = r1.out.compaction.details.readFiles ?? [];
const mf = r1.out.compaction.details.modifiedFiles ?? [];
console.log(`reads:${rf.length} mods:${mf.length}`);
for (const p of [...rf, ...mf]) {
	assert.ok(typeof p === "string" && p.length < 500 && !p.includes("\n") && !p.includes("://"), `sane: ${JSON.stringify(p).slice(0, 80)}`);
	assert.ok(!/[@{}$*?()[\]`\s]/.test(p), `no remote/metachar/space leak: ${p}`);
	assert.ok(!/(^|\/)-/.test(p), "no flags");
}
console.log("--- tracked reads:");
for (const p of rf) console.log("  R", p);
console.log("--- tracked modified:");
for (const p of mf) console.log("  M", p);
console.log("EXOTIC ALL PASSED");
