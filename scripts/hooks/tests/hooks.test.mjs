// フックとループ用スクリプトのテスト。実行: node --test scripts/hooks/tests/
// 一時ディレクトリにキット一式を複製し、フックに標準入力で JSON を渡して結果を確かめる。
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, cpSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const KIT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
let dir;

const PASS = 'node -e "process.exit(0)"';
const FAIL = 'node -e "console.log(\'boom\');process.exit(1)"';

function setup({ verify = PASS, ...config } = {}) {
  dir = mkdtempSync(path.join(tmpdir(), "loop-kit-"));
  cpSync(path.join(KIT, "scripts"), path.join(dir, "scripts"), { recursive: true });
  mkdirSync(path.join(dir, "loop"));
  const kitConfig = JSON.parse(readFileSync(path.join(KIT, "loop/loop.config.json"), "utf8"));
  writeFileSync(path.join(dir, "loop/loop.config.json"), JSON.stringify({ ...kitConfig, verify, ...config }));
  writeFileSync(path.join(dir, "loop/GOAL.md"), "# GOAL\n\n## 目的\nテスト用の目的\n\n## 完了条件\n");
  cpSync(path.join(KIT, "loop/STATE.template.md"), path.join(dir, "loop/STATE.template.md"));
  cpSync(path.join(KIT, "loop/STATE.template.md"), path.join(dir, "loop/STATE.md"));
}

const file = (p) => path.join(dir, p);
const read = (p) => readFileSync(file(p), "utf8");

function activate(extra = {}) {
  mkdirSync(file("loop/.run"), { recursive: true });
  writeFileSync(file("loop/.run/active.json"), JSON.stringify({
    startedAt: new Date().toISOString(), baseCommit: null, sessionId: "s1", checkpoint: false, ...extra,
  }));
}

function writeState({ tasks = "- [x] 完了したタスク", review = "", questions = "" } = {}) {
  writeFileSync(file("loop/STATE.md"),
    `# STATE\n\n## タスク\n${tasks}\n\n## 周回ログ\n\n## レビュー\n${review}\n\n## 人間への質問\n${questions}\n`);
}

function hook(name, input = {}) {
  const r = spawnSync("node", [file(`scripts/hooks/${name}.mjs`)], {
    input: JSON.stringify({ cwd: dir, session_id: "s1", ...input }),
    encoding: "utf8",
  });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout || "{}");
}

function script(name, args = []) {
  return spawnSync("node", [file(`scripts/loop/${name}.mjs`), ...args], { encoding: "utf8" });
}

const shell = (command, extra) => hook("pre-tool-guard", { tool_name: "run_in_terminal", tool_input: { command }, ...extra });
const edit = (toolName, toolInput) => hook("pre-tool-guard", { tool_name: toolName, tool_input: toolInput });
const denied = (out) => out.hookSpecificOutput?.permissionDecision === "deny";

beforeEach(() => setup());
afterEach(() => rmSync(dir, { recursive: true, force: true }));

// ---------- pre-tool-guard ----------

test("危険なシェルコマンドを拒否する", () => {
  for (const cmd of [
    "git push origin main",
    "git reset --hard HEAD~1",
    "git clean -fdx",
    "git checkout -- src/a.js",
    "git restore .",
    "rm -fr src",
    "rm -r -f src",
    "Remove-Item -Recurse src",
    "rmdir /s /q src",
    'npm pkg set scripts.test="exit 0"',
    "npm install lodash",
    "npm i -D lodash",
    "git commit --no-verify -m x",
  ]) {
    assert.ok(denied(shell(cmd)), cmd);
  }
});

test("通常のシェルコマンドは許可する", () => {
  for (const cmd of ["npm test", "npm install", "npm ci", "rm -f tmp.txt", "git status", "git restore --staged a.js"]) {
    assert.ok(!denied(shell(cmd)), cmd);
  }
});

test("保護ファイルを読むだけのシェルコマンドは許可し、書き換えは拒否する", () => {
  assert.ok(!denied(shell("cat loop/GOAL.md")));
  assert.ok(!denied(shell("git diff loop/GOAL.md")));
  assert.ok(!denied(shell("Get-Content .\\loop\\loop.config.json | Select-String verify")));
  assert.ok(denied(shell("echo x > loop/GOAL.md")));
  assert.ok(denied(shell("Set-Content loop\\GOAL.md x")));
  assert.ok(denied(shell("sed -i s/a/b/ package.json")));
  assert.ok(denied(shell("echo 0 > loop/.run/iterations")));
});

test("ループ用スクリプトの呼び出しは許可するが、連結したコマンドは拒否する", () => {
  assert.ok(!denied(shell("node scripts/loop/start.mjs --fresh")));
  assert.ok(!denied(shell('node scripts/loop/checkpoint.mjs "タスク1を実装"')));
  assert.ok(denied(shell("node scripts/loop/start.mjs; echo x > loop/GOAL.md")));
});

test("保護ファイルの編集を拒否する", () => {
  for (const p of [
    file("package.json"),
    "loop/GOAL.md",
    ".vscode/settings.json",
    ".github/agents/loop.agent.md",
    ".github/copilot-instructions.md",
    "scripts/hooks/stop-gate.mjs",
    "loop/.run/iterations",
    "vitest.config.ts",
    "src/__snapshots__/a.test.js.snap",
  ]) {
    assert.ok(denied(edit("replace_string_in_file", { filePath: p, oldString: "a", newString: "b" })), p);
  }
  assert.ok(denied(edit("apply_patch", { input: "*** Begin Patch\n*** Update File: .github/hooks/loop.json\n*** End Patch" })));
});

test("通常ファイルの編集は、本文に保護パスが書かれていても許可する", () => {
  assert.ok(!denied(edit("replace_string_in_file", { filePath: "loop/STATE.md", oldString: "a", newString: "- [ ] loop/GOAL.md を変更したい" })));
  assert.ok(!denied(edit("create_file", { filePath: file("src/a.js"), content: "// git push はしない" })));
  assert.ok(!denied(edit("editFiles", { files: ["src/a.js"] })));
});

test("BOM 付きの入力も解析する", () => {
  const r = spawnSync("node", [file("scripts/hooks/pre-tool-guard.mjs")], {
    input: "﻿" + JSON.stringify({ cwd: dir, tool_name: "create_file", tool_input: { filePath: "loop/GOAL.md" } }),
    encoding: "utf8",
  });
  assert.ok(denied(JSON.parse(r.stdout)));
});

test("ループ中はツール呼び出し回数の上限を超えると拒否する", () => {
  setup({ maxToolCalls: 2 });
  activate();
  assert.ok(!denied(shell("npm test")));
  assert.ok(!denied(shell("npm test")));
  assert.ok(denied(shell("npm test")));
});

test("別セッションのツール呼び出しは数えない", () => {
  setup({ maxToolCalls: 1 });
  activate();
  assert.ok(!denied(shell("npm test", { session_id: "other" })));
  assert.ok(!denied(shell("npm test", { session_id: "other" })));
  assert.ok(!existsSync(file("loop/.run/tool-calls")));
});

// ---------- stop-gate ----------

test("ループ中でなければ何もしない", () => {
  assert.deepEqual(hook("stop-gate"), {});
});

test("別セッションのチャットは止めない", () => {
  activate();
  writeState({ tasks: "- [ ] 未完了" });
  assert.deepEqual(hook("stop-gate", { session_id: "other" }), {});
});

test("未紐づけの active は最初のセッションに紐づく", () => {
  activate({ sessionId: null });
  writeState({ tasks: "- [ ] 未完了" });
  assert.equal(hook("stop-gate", { session_id: "s9" }).decision, "block");
  assert.equal(JSON.parse(read("loop/.run/active.json")).sessionId, "s9");
});

test("未完了タスクがあればブロックし、周回数を進める", () => {
  activate();
  writeState({ tasks: "- [x] 済\n- [ ] 未完了" });
  const out = hook("stop-gate");
  assert.equal(out.decision, "block");
  assert.match(out.reason, /未完了タスクが 1 件/);
  assert.equal(read("loop/.run/iterations"), "1");
});

test("verify が失敗していればブロックし、ログを残す", () => {
  setup({ verify: FAIL });
  activate();
  writeState({ review: "判定: OK" });
  const out = hook("stop-gate");
  assert.equal(out.decision, "block");
  assert.match(out.reason, /boom/);
  assert.match(read("loop/.run/last-verify.log"), /boom/);
});

test("verify がタイムアウトしたら失敗として扱う", () => {
  setup({ verify: 'node -e "setTimeout(() => {}, 60000)"', verifyTimeoutSec: 1 });
  activate();
  writeState({ review: "判定: OK" });
  const started = Date.now();
  const out = hook("stop-gate");
  assert.ok(Date.now() - started < 20_000);
  assert.equal(out.decision, "block");
  assert.match(out.reason, /タイムアウト/);
});

test("人間への質問があれば停止し、active を消す", () => {
  activate();
  writeState({ tasks: "- [ ] 未完了", questions: "- [ ] DB を変えてよいか" });
  const out = hook("stop-gate");
  assert.equal(out.decision, undefined);
  assert.match(out.systemMessage, /人間への質問が 1 件/);
  assert.ok(!existsSync(file("loop/.run/active.json")));
});

test("回答済み（[x]）の質問では止まらない", () => {
  activate();
  writeState({ tasks: "- [ ] 未完了", questions: "- [x] DB を変えてよいか → よい" });
  assert.equal(hook("stop-gate").decision, "block");
});

test("周回上限に達したら停止し、active を消す", () => {
  setup({ maxIterations: 2 });
  activate();
  writeState({ tasks: "- [ ] 未完了" });
  assert.equal(hook("stop-gate").decision, "block");
  assert.equal(hook("stop-gate").decision, "block");
  const out = hook("stop-gate");
  assert.match(out.systemMessage, /上限（2周）/);
  assert.ok(!existsSync(file("loop/.run/active.json")));
});

test("全タスク完了・verify 成功でもレビューがなければブロックする", () => {
  activate();
  writeState();
  const out = hook("stop-gate");
  assert.equal(out.decision, "block");
  assert.match(out.reason, /レビューが未完了/);
});

test("レビュー後に差分が変わっていればブロックする", () => {
  activate();
  writeState({ review: "判定: OK" });
  writeFileSync(file("loop/.run/review.hash"), "古いハッシュ");
  assert.match(hook("stop-gate").reason, /レビュー後にコードが変わっています/);
});

test("全タスク完了・verify 成功・レビュー OK なら終了し、active を消す", () => {
  activate();
  writeState({ review: "判定: OK" });
  // 一時ディレクトリは git 管理外なので差分は空になる
  writeFileSync(file("loop/.run/review.hash"), createHash("sha256").update("").digest("hex"));
  const out = hook("stop-gate");
  assert.match(out.systemMessage, /ループ終了/);
  assert.ok(!existsSync(file("loop/.run/active.json")));
});

test("requireReview が false ならレビューなしで終了できる", () => {
  setup({ requireReview: false });
  activate();
  writeState();
  assert.match(hook("stop-gate").systemMessage, /ループ終了/);
});

test("設定ファイルが壊れていれば停止する", () => {
  activate();
  writeFileSync(file("loop/loop.config.json"), "{ 壊れた JSON");
  const out = hook("stop-gate");
  assert.match(out.systemMessage, /読めません/);
  assert.ok(!existsSync(file("loop/.run/active.json")));
});

test("古すぎる active は無視して削除する", () => {
  activate({ startedAt: new Date(Date.now() - 13 * 3600_000).toISOString() });
  writeState({ tasks: "- [ ] 未完了" });
  assert.deepEqual(hook("stop-gate"), {});
  assert.ok(!existsSync(file("loop/.run/active.json")));
});

// ---------- reset-counter ----------

test("人間のプロンプトでカウンタを0に戻す", () => {
  activate();
  writeFileSync(file("loop/.run/iterations"), "5");
  writeFileSync(file("loop/.run/tool-calls"), "50");
  hook("reset-counter");
  assert.equal(read("loop/.run/iterations"), "0");
  assert.equal(read("loop/.run/tool-calls"), "0");
});

test("ループ中でなければカウンタを作らない", () => {
  hook("reset-counter");
  assert.ok(!existsSync(file("loop/.run")));
});

// ---------- scripts/loop ----------

test("start: GOAL の目的が空なら開始しない", () => {
  writeFileSync(file("loop/GOAL.md"), "# GOAL\n\n## 目的\n<!-- 例 -->\n\n## 完了条件\n");
  const r = script("start");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /目的」が空/);
  assert.ok(!existsSync(file("loop/.run/active.json")));
});

test("start: --fresh で STATE.md を初期化してループを開始する", () => {
  writeState({ tasks: "- [x] 前回のタスク" });
  const r = script("start", ["--fresh"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(read("loop/STATE.md"), read("loop/STATE.template.md"));
  assert.equal(read("loop/.run/iterations"), "0");
  assert.equal(JSON.parse(read("loop/.run/active.json")).sessionId, null);
});

test("start: 実行中のループがあれば開始し直さない", () => {
  activate();
  writeFileSync(file("loop/.run/iterations"), "5");
  const r = script("start");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /既に実行中/);
  assert.equal(read("loop/.run/iterations"), "5");
});

test("snapshot と checkpoint: git リポジトリで差分を書き出し、コミットする", () => {
  const git = (...args) => spawnSync("git", args, { cwd: dir, encoding: "utf8" });
  git("init", "-q");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "test");
  writeFileSync(file(".gitignore"), "loop/.run/\n");
  writeFileSync(file("a.txt"), "1\n");
  git("add", "-A");
  git("commit", "-qm", "init");

  assert.equal(script("start").status, 0);
  assert.equal(JSON.parse(read("loop/.run/active.json")).checkpoint, true);

  writeFileSync(file("a.txt"), "2\n");
  writeFileSync(file("新規.txt"), "new\n");
  assert.equal(script("snapshot").status, 0);
  const diff = read("loop/.run/review.diff");
  assert.match(diff, /\+2/);
  assert.match(diff, /新規ファイル（未追跡）: 新規.txt/);

  const r = script("checkpoint", ["タスク1"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(git("log", "-1", "--format=%s").stdout, /\[loop\] タスク1/);
});
