// 1周回が verify を通ったときに、ローカルにコミットして戻れる地点を作る（push はしない）。
//   node scripts/loop/checkpoint.mjs "やったことの要約"
import { chdirToRepoRoot, readActive, runGit } from "../hooks/lib.mjs";

chdirToRepoRoot(import.meta.url);
const message = process.argv.slice(2).join(" ").trim() || "周回の成果";
const active = readActive();

if (!active) {
  console.error("ループが実行中ではありません。");
  process.exit(1);
}
if (!active.checkpoint) {
  console.log("今回のループではチェックポイントコミットが無効です（開始時の表示を参照）。何もしません。");
  process.exit(0);
}

runGit(["add", "-A"]);
if (runGit(["diff", "--cached", "--quiet"]).status === 0) {
  console.log("コミットする変更がありません。");
  process.exit(0);
}
const result = runGit(["commit", "-m", `[loop] ${message}`]);
process.stdout.write(result.stdout ?? "");
process.stderr.write(result.stderr ?? "");
process.exit(result.status ?? 1);
