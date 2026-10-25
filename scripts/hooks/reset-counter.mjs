// 人間がプロンプトを送るたびに、実行中ループの周回・ツール呼び出しカウンタを0に戻す。
// （Stop フックによる自動継続はユーザー送信ではないので、ここは通らない）
import { readHookInput, loadConfig, activeForSession, writeCounter, ITERATIONS, TOOL_CALLS } from "./lib.mjs";

const input = readHookInput();
const { config } = loadConfig();
if (activeForSession(input, config)) {
  writeCounter(ITERATIONS, 0);
  writeCounter(TOOL_CALLS, 0);
}
process.stdout.write("{}");
