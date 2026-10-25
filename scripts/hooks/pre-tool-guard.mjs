// ツール実行前のガード。
// 1) 危険なコマンドを止める
// 2) ループが自分の「採点基準」（フック・設定・GOAL・テスト設定など）を書き換えるのを止める
// 3) ループ実行中はツール呼び出し回数を数え、上限を超えたら止める
import {
  readHookInput, loadConfig, activeForSession, readCounter, writeCounter,
  normalizePath, globToRegExp, TOOL_CALLS,
} from "./lib.mjs";

// 人間だけが編集してよいもの（loop.config.json の protectedPaths で追加できる）
const CORE_PROTECTED = [
  ".github/hooks/**",
  ".github/agents/**",
  ".github/prompts/**",
  ".github/instructions/**",
  ".github/copilot-instructions.md",
  ".vscode/**",
  "scripts/hooks/**",
  "scripts/loop/**",
  "loop/loop.config.json",
  "loop/GOAL.md",
  "loop/STATE.template.md",
  "loop/.run/**",
];

// シェルで実行してはいけないもの
const DANGEROUS = [
  /\bgit\s+push\b/i,
  /\bgit\s+reset\s+--hard\b/i,
  /\bgit\s+clean\b.*\s-[a-z]*f/i,
  /\bgit\s+checkout\s+(--\s|\.(\s|$))/i,
  /\bgit\s+restore\b(?!.*--staged)/i,
  /\bgit\s+branch\s+.*-D\b/,
  /\brm\s+(\S+\s+)*(-[fFrRvViI]*[rR][fFrRvViI]*|--recursive)(\s|$)/,
  /\b(Remove-Item|ri|rm|del|erase|rd|rmdir)\b.*\s-r(ecurse)?\b/i,
  /\b(rd|rmdir|del|erase)\b.*\s\/s\b/i,
  /\b(drop|truncate)\s+(table|database|schema)\b/i,
  /--no-verify\b/i,
  /\bnpm\s+pkg\s+(set|delete)\b/i,
  /\b(npm|pnpm|yarn)\s+(install|i|add)\b(\s+-\S+)*\s+[^-\s]/i,
];

// ループ用スクリプトの呼び出しだけは、保護パスを含んでいても許可する
const LOOP_COMMAND = /^node\s+scripts[\\/]loop[\\/](start|checkpoint|snapshot)\.mjs(\s+[^;&|<>`$]*)?$/i;

// 保護パスを「読むだけ」のシェルコマンドは許可する
const READONLY_COMMANDS = new Set([
  "cat", "type", "get-content", "gc", "head", "tail", "less", "more", "ls", "dir",
  "get-childitem", "gci", "grep", "rg", "findstr", "select-string", "sls", "wc",
]);
const READONLY_GIT = new Set(["diff", "log", "show", "status", "blame", "ls-files"]);

const input = readHookInput();
const { config } = loadConfig();
const toolName = String(input.tool_name ?? input.toolName ?? "").toLowerCase();
const toolInput = input.tool_input ?? input.toolArgs ?? {};

const isWrite = /(edit|write|create|replace|patch|insert|delete|rename|apply|move)/.test(toolName);
const isShell = /(terminal|shell|bash|execute|run|command|powershell)/.test(toolName);

function deny(reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  }));
  process.exit(0);
}

const protectedGlobs = [...CORE_PROTECTED, ...(config.protectedPaths ?? [])];
const protectedPathRes = protectedGlobs.map(globToRegExp);

// glob をコマンド文字列中の出現に一致する正規表現にする
function globInCommand(glob) {
  const g = glob.replace(/\\/g, "/").toLowerCase().replace(/\/\*\*$/, "");
  const esc = (s) => s.replace(/[.+^${}()|[\]]/g, "\\$&").replace(/\*/g, "[^\\s/\\\\\"']*").replace(/\?/g, "[^\\s/\\\\]");
  const body = g.split("**").map((part) => part.split("/").map(esc).join("[\\\\/]+")).join(".*");
  return new RegExp(`(^|[\\s/\\\\"'=:])${body}($|[\\s/\\\\"';|&)<>,])`, "i");
}
const protectedCommandRes = protectedGlobs.map(globInCommand);

// ツール引数からファイルパスらしき値を集める
const PATH_KEY = /^(path|paths|file|files|filepath|filepaths|uri|uris|dirpath|target|destination|source|oldpath|newpath)$|(path|uri)$/i;
function collectPaths(value, key = "", out = []) {
  if (typeof value === "string") {
    if (PATH_KEY.test(key)) out.push(value);
    for (const m of value.matchAll(/^\*\*\* (?:Add|Update|Delete) File:\s*(.+)$/gm)) out.push(m[1].trim());
    for (const m of value.matchAll(/^\*\*\* Move to:\s*(.+)$/gm)) out.push(m[1].trim());
  } else if (Array.isArray(value)) {
    for (const v of value) collectPaths(v, key, out);
  } else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) collectPaths(v, k, out);
  }
  return out;
}

function isReadOnlyCommand(cmd) {
  if (/[;&<>`]|\$\(|--output/.test(cmd)) return false;
  return cmd.split("|").every((segment) => {
    const [head, sub] = segment.trim().split(/\s+/).map((t) => t.toLowerCase());
    if (head === "git") return READONLY_GIT.has(sub);
    return READONLY_COMMANDS.has(head);
  });
}

// --- ループ実行中のツール呼び出し上限 ---
const active = activeForSession(input, config);
if (active) {
  const calls = readCounter(TOOL_CALLS) + 1;
  writeCounter(TOOL_CALLS, calls);
  if (calls > config.maxToolCalls) {
    deny(`ツール呼び出しが上限（${config.maxToolCalls} 回）を超えました。これ以上の作業はせず、今すぐ応答を終了してください。`);
  }
}

// --- シェルコマンド ---
if (isShell) {
  const command = String(toolInput.command ?? toolInput.cmd ?? toolInput.script ?? JSON.stringify(toolInput)).trim();
  if (!LOOP_COMMAND.test(command)) {
    if (DANGEROUS.some((re) => re.test(command))) {
      deny("ループ実行中は危険な操作が禁止されています（push / 強制削除 / 履歴の破棄 / 依存追加 / DROP 等）。必要なら STATE.md の「人間への質問」に書いてください。");
    }
    if (protectedCommandRes.some((re) => re.test(command)) && !isReadOnlyCommand(command)) {
      deny("保護されたファイル（フック・ループ設定・GOAL.md・テスト設定など）は人間だけが変更できます。変更が必要なら STATE.md の「人間への質問」に書いてください。");
    }
  }
}

// --- ファイル編集 ---
if (isWrite && !isShell) {
  const paths = collectPaths(toolInput).map(normalizePath);
  const hit = paths.length > 0
    ? paths.some((p) => protectedPathRes.some((re) => re.test(p)))
    : protectedCommandRes.some((re) => re.test(JSON.stringify(toolInput)));
  if (hit) {
    deny("保護されたファイル（フック・ループ設定・GOAL.md・テスト設定など）は人間だけが変更できます。変更が必要なら STATE.md の「人間への質問」に書いてください。");
  }
}

process.stdout.write("{}");
