// Reviewer に渡す差分を書き出す。Reviewer を呼ぶ直前に実行する。
//   node scripts/loop/snapshot.mjs
// 差分のハッシュも記録し、レビュー後にコードが変わったら終了ゲートが再レビューを求める。
import { writeFileSync, mkdirSync } from "node:fs";
import {
  chdirToRepoRoot, readActive, workDiff, hashText, RUN_DIR, REVIEW_DIFF, REVIEW_HASH, VERIFY_LOG,
} from "../hooks/lib.mjs";

chdirToRepoRoot(import.meta.url);
const active = readActive();
if (!active) {
  console.error("ループが実行中ではありません。");
  process.exit(1);
}

const diff = workDiff(active.baseCommit);
mkdirSync(RUN_DIR, { recursive: true });
writeFileSync(REVIEW_DIFF,
  `# ループ開始時点（${active.baseCommit ?? "初回コミット前"}）からの変更。loop/ 配下は除く\n` +
  `# 最後の verify 出力: ${VERIFY_LOG}\n\n${diff}`);
writeFileSync(REVIEW_HASH, hashText(diff));

console.log(`${REVIEW_DIFF} に差分を書き出しました（${diff.split("\n").length} 行）。Reviewer にこのファイルを読ませてください。`);
