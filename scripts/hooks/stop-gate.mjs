// 終了ゲート: エージェントが止まろうとしたときに呼ばれる。
// このセッションでループが実行中（loop/.run/active.json がある）のときだけ働く。
//   止める（ループ終了）: 周回・ツール呼び出しの上限到達 / 人間への質問あり / 設定エラー /
//                         verify 成功 & 全タスク完了 & レビュー OK（変更がレビュー後に変わっていない）
//   ブロック（次の周回へ）: 上記以外
// ループを終える判断はすべてここで行い、エージェントには active.json を消させない。
import { writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import {
  readHookInput, loadConfig, activeForSession, deactivate, readCounter, writeCounter,
  readState, countOpenTasks, openQuestions, reviewPassed, runVerify, workDiff, hashText,
  RUN_DIR, ITERATIONS, TOOL_CALLS, VERIFY_LOG, REVIEW_HASH,
} from "./lib.mjs";

const allow = (msg) => {
  process.stdout.write(JSON.stringify(msg ? { systemMessage: msg } : {}));
  process.exit(0);
};

const finish = (msg) => {
  deactivate();
  allow(msg);
};

const block = (reason) => {
  // ハーネスによって読むフィールドが違うため、両方の形式で返す
  process.stdout.write(JSON.stringify({
    decision: "block",
    reason,
    hookSpecificOutput: { hookEventName: "Stop", decision: "block", reason },
  }));
  process.exit(0);
};

const input = readHookInput();
const { config, error } = loadConfig();
const active = activeForSession(input, config);
if (!active) allow(); // このセッションでループ中でなければ何もしない

if (error) finish(`${error}。ループを停止しました。`);

const n = readCounter(ITERATIONS);
const max = config.maxIterations;
if (n >= max) {
  finish(`ループ上限（${max}周）に達したので停止しました。loop/STATE.md を確認してください。`);
}
if (readCounter(TOOL_CALLS) > config.maxToolCalls) {
  finish(`ツール呼び出し上限（${config.maxToolCalls} 回）に達したので停止しました。loop/STATE.md を確認してください。`);
}

const state = readState();
const questions = openQuestions(state);
if (questions.length > 0) {
  finish(`人間への質問が ${questions.length} 件あるため停止しました（未完了）。loop/STATE.md の「人間への質問」に回答してから /loop で再開してください。`);
}

// レビュー判定（verify が生成物を作っても影響しないよう、verify より先に差分を見る）
let reviewProblem = null;
if (config.requireReview) {
  if (!reviewPassed(state)) {
    reviewProblem = "レビューが未完了です。`node scripts/loop/snapshot.mjs` を実行してから Reviewer を呼び、判定を STATE.md の「レビュー」欄に `判定: OK` の形で記録してください。";
  } else {
    const reviewed = existsSync(REVIEW_HASH) ? readFileSync(REVIEW_HASH, "utf8").trim() : "";
    if (reviewed !== hashText(workDiff(active.baseCommit))) {
      reviewProblem = "レビュー後にコードが変わっています（または snapshot が取られていません）。`node scripts/loop/snapshot.mjs` を実行して Reviewer にレビューし直させ、「レビュー」欄を更新してください。";
    }
  }
}

const { ok, out } = await runVerify(config);
mkdirSync(RUN_DIR, { recursive: true });
writeFileSync(VERIFY_LOG, out);

const remaining = countOpenTasks(state);

if (ok && remaining === 0 && !reviewProblem) {
  finish("検証成功・全タスク完了・レビュー OK。ループ終了です。");
}

writeCounter(ITERATIONS, n + 1);

const tail = out.slice(-2000);
const reasons = [];
if (!ok) reasons.push(`verify（${config.verify}）が失敗しています。全文は ${VERIFY_LOG}。出力の末尾:\n${tail}`);
if (remaining > 0) reasons.push(`loop/STATE.md に未完了タスクが ${remaining} 件残っています。`);
if (ok && remaining === 0 && reviewProblem) reasons.push(reviewProblem);

block(
  `まだ終了できません（${n + 1}/${max} 周目）。\n` +
  reasons.join("\n\n") +
  `\n\n次の周回: STATE.md を読み直し、上記を1つずつ解消してください。` +
  `人間の判断が必要な場合は「人間への質問」に書いてから終了してください（ゲートが停止させます）。`
);
