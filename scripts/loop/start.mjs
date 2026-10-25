// ループを開始する。Loop エージェントが最初に1回だけ実行する。
//   node scripts/loop/start.mjs          … STATE.md の続きから再開
//   node scripts/loop/start.mjs --fresh  … STATE.md をテンプレートに戻して新規開始
// 実行中のループがあるときは何もしない（カウンタのリセットによる上限回避を防ぐ）。
import { copyFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import {
  chdirToRepoRoot, loadConfig, readActive, writeActive, writeCounter, stateSection,
  headCommit, worktreeDirty, GOAL, STATE, STATE_TEMPLATE, ITERATIONS, TOOL_CALLS, REVIEW_HASH, ACTIVE,
} from "../hooks/lib.mjs";

chdirToRepoRoot(import.meta.url);
const fresh = process.argv.includes("--fresh");
const { config, error } = loadConfig();

if (error) {
  console.error(error);
  process.exit(1);
}

const goal = existsSync(GOAL) ? readFileSync(GOAL, "utf8") : "";
if (!stateSection(goal, "目的").trim()) {
  console.error("loop/GOAL.md の「目的」が空です。人間に GOAL.md を書いてもらってください。ループは開始していません。");
  process.exit(1);
}

const current = readActive();
if (current) {
  const started = Date.parse(current.startedAt ?? "");
  const stale = Number.isFinite(started) && Date.now() - started > config.staleHours * 3600_000;
  if (!stale) {
    console.error(`ループは既に実行中です（開始: ${current.startedAt}）。開始し直さずに作業を続けてください。` +
      `前回のループが異常終了して残っている場合は、人間が ${ACTIVE} を削除してください。`);
    process.exit(1);
  }
}

let checkpoint = Boolean(config.checkpointCommits);
const notes = [];
if (checkpoint && worktreeDirty()) {
  checkpoint = false;
  notes.push("ループ開始前の未コミット変更があるため、今回はチェックポイントコミットを無効にしました。");
}
if (checkpoint && !headCommit()) {
  checkpoint = false;
  notes.push("コミットが1つもないリポジトリのため、チェックポイントコミットを無効にしました。");
}

if (fresh) copyFileSync(STATE_TEMPLATE, STATE);

writeActive({
  startedAt: new Date().toISOString(),
  baseCommit: headCommit(),
  sessionId: null,
  checkpoint,
});
writeCounter(ITERATIONS, 0);
writeCounter(TOOL_CALLS, 0);
rmSync(REVIEW_HASH, { force: true });

console.log([
  `ループを開始しました（${fresh ? "新規: STATE.md を初期化" : "STATE.md の続きから再開"}）。`,
  `verify: ${config.verify} / 上限: ${config.maxIterations} 周・ツール呼び出し ${config.maxToolCalls} 回`,
  `チェックポイントコミット: ${checkpoint ? "有効" : "無効"}`,
  ...notes,
].join("\n"));
