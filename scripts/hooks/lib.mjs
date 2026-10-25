// フックとループ用スクリプトの共通処理。
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";

export const RUN_DIR = "loop/.run";
export const ACTIVE = `${RUN_DIR}/active.json`;
export const ITERATIONS = `${RUN_DIR}/iterations`;
export const TOOL_CALLS = `${RUN_DIR}/tool-calls`;
export const VERIFY_LOG = `${RUN_DIR}/last-verify.log`;
export const REVIEW_DIFF = `${RUN_DIR}/review.diff`;
export const REVIEW_HASH = `${RUN_DIR}/review.hash`;
export const STATE = "loop/STATE.md";
export const STATE_TEMPLATE = "loop/STATE.template.md";
export const GOAL = "loop/GOAL.md";
export const CONFIG = "loop/loop.config.json";

const DEFAULT_CONFIG = {
  verify: "npm test",
  maxIterations: 8,
  maxToolCalls: 200,
  verifyTimeoutSec: 240,
  staleHours: 12,
  requireReview: true,
  checkpointCommits: true,
  protectedPaths: [],
};

// 標準入力の JSON を読み、作業ディレクトリをワークスペースのルートに合わせる。
// 解析できない入力は空オブジェクトとして扱う（＝ガードは素通しになる）。
export function readHookInput() {
  let input = {};
  // PowerShell 5.1 などは先頭に BOM を付けて渡すので取り除く
  try { input = JSON.parse(readFileSync(0, "utf8").replace(/^﻿/, "") || "{}"); } catch {}
  const cwd = input.cwd ?? input.workspaceFolder;
  if (typeof cwd === "string" && existsSync(cwd)) process.chdir(cwd);
  return input;
}

export function sessionIdOf(input) {
  return input.session_id ?? input.sessionId ?? null;
}

// 設定ファイルが壊れていても例外にせず、エラー内容を返す。
export function loadConfig() {
  try {
    return { config: { ...DEFAULT_CONFIG, ...JSON.parse(readFileSync(CONFIG, "utf8")) }, error: null };
  } catch (e) {
    return { config: { ...DEFAULT_CONFIG }, error: `${CONFIG} を読めません: ${e.message}` };
  }
}

export function readActive() {
  if (!existsSync(ACTIVE)) return null;
  try { return JSON.parse(readFileSync(ACTIVE, "utf8")); } catch { return {}; }
}

export function writeActive(active) {
  mkdirSync(RUN_DIR, { recursive: true });
  writeFileSync(ACTIVE, JSON.stringify(active, null, 2));
}

export function deactivate() {
  rmSync(ACTIVE, { force: true });
}

// このセッションのループが実行中なら active を返す。
// 起動後に最初に来たセッションに紐づけ、別セッション（無関係なチャット）では null を返す。
// 古すぎる active は放置されたものとみなして削除する。
export function activeForSession(input, config) {
  const active = readActive();
  if (!active) return null;
  const started = Date.parse(active.startedAt ?? "");
  if (Number.isFinite(started) && Date.now() - started > config.staleHours * 3600_000) {
    deactivate();
    return null;
  }
  const sid = sessionIdOf(input);
  if (sid) {
    if (!active.sessionId) {
      active.sessionId = sid;
      writeActive(active);
    } else if (active.sessionId !== sid) {
      return null;
    }
  }
  return active;
}

export function readCounter(file) {
  try { return Number(readFileSync(file, "utf8")) || 0; } catch { return 0; }
}

export function writeCounter(file, n) {
  mkdirSync(RUN_DIR, { recursive: true });
  writeFileSync(file, String(n));
}

// STATE.md の「## 見出し」直下の本文（HTML コメントを除く）を返す。
export function stateSection(state, heading) {
  const lines = state.split(/\r?\n/);
  const start = lines.findIndex((l) => new RegExp(`^##\\s*${heading}\\s*$`).test(l));
  if (start < 0) return "";
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^##\s/.test(l));
  return (end < 0 ? rest : rest.slice(0, end)).join("\n").replace(/<!--[\s\S]*?-->/g, "");
}

export function readState() {
  return existsSync(STATE) ? readFileSync(STATE, "utf8") : "";
}

export function countOpenTasks(state) {
  return (stateSection(state, "タスク").match(/^\s*-\s+\[ \]/gm) ?? []).length;
}

export function openQuestions(state) {
  return stateSection(state, "人間への質問")
    .split("\n")
    .filter((l) => /^\s*-\s+\S/.test(l) && !/^\s*-\s+\[x\]/i.test(l));
}

export function reviewPassed(state) {
  return /判定\s*[:：]\s*`?OK`?\s*$/m.test(stateSection(state, "レビュー"));
}

// パスをワークスペース相対・スラッシュ区切り・小文字に揃える。
export function normalizePath(p) {
  let s = String(p).replace(/^file:\/\/\/?/i, "");
  try { s = decodeURIComponent(s); } catch {}
  if (path.isAbsolute(s)) s = path.relative(process.cwd(), s);
  return s.replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
}

// "jest.config.*" や "src/**/*.snap" のような簡易 glob を正規表現にする。
// スラッシュを含まないパターンはファイル名（basename）に対して照合する。
// 末尾の "/**" はディレクトリ自身にも一致させる。
export function globToRegExp(glob) {
  let g = glob.replace(/\\/g, "/").toLowerCase();
  const dirTail = g.endsWith("/**");
  if (dirTail) g = g.slice(0, -3);
  const body = g
    .split("**")
    .map((part) => part.replace(/[.+^${}()|[\]]/g, "\\$&").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]"))
    .join(".*") + (dirTail ? "(/.*)?" : "");
  return g.includes("/") ? new RegExp(`^${body}$`) : new RegExp(`(^|/)${body}$`);
}

// verify コマンドを実行する。stdout と stderr を両方記録し、
// タイムアウト時は子孫プロセス（npm から起動されたテストなど）ごと終了させる。
export function runVerify(config) {
  return new Promise((resolve) => {
    const child = spawn(config.verify, {
      shell: true,
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    let out = "";
    let timedOut = false;
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { out += d; });
    const timer = setTimeout(() => {
      timedOut = true;
      if (process.platform === "win32") {
        spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
      } else {
        try { process.kill(-child.pid, "SIGKILL"); } catch {}
      }
    }, config.verifyTimeoutSec * 1000);
    child.on("error", (e) => { out += `\n${e.message}`; });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) out += `\n[verify が ${config.verifyTimeoutSec} 秒でタイムアウトしました]`;
      resolve({ ok: code === 0 && !timedOut, out });
    });
  });
}

const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const OUTSIDE_LOOP = ["--", ".", ":(exclude)loop"];

function git(args) {
  try {
    return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 });
  } catch {
    return "";
  }
}

// ループ開始時点からの変更（loop/ 配下は除く）。未追跡ファイルは中身ごと含める。
export function workDiff(baseCommit) {
  let diff = git(["diff", baseCommit || EMPTY_TREE, ...OUTSIDE_LOOP]);
  const untracked = git(["ls-files", "-z", "--others", "--exclude-standard", ...OUTSIDE_LOOP]).split("\0").filter(Boolean);
  for (const file of untracked) {
    let body;
    try {
      const buf = readFileSync(file);
      body = buf.length > 200_000 || buf.includes(0) ? "（バイナリまたは大きいファイルのため省略）" : buf.toString("utf8");
    } catch { body = "（読めませんでした）"; }
    diff += `\n=== 新規ファイル（未追跡）: ${file}\n${body}\n`;
  }
  return diff;
}

export function hashText(text) {
  return createHash("sha256").update(text).digest("hex");
}

export function headCommit() {
  return git(["rev-parse", "HEAD"]).trim() || null;
}

// loop/ 配下（人間が書いた GOAL.md など）を除いて未コミットの変更があるか
export function worktreeDirty() {
  return git(["status", "--porcelain", ...OUTSIDE_LOOP]).trim() !== "";
}

export function runGit(args) {
  return spawnSync("git", args, { encoding: "utf8" });
}

// ループ用スクリプト（scripts/loop/*.mjs）をリポジトリのルートで動かす
export function chdirToRepoRoot(scriptUrl) {
  process.chdir(path.resolve(path.dirname(fileURLToPath(scriptUrl)), "../.."));
}
