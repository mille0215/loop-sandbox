// 和暦変換の仕様テスト（人間が書いたもの。ループは変更できない）
import { test } from "node:test";
import assert from "node:assert/strict";
import { toWareki, parseWareki } from "../src/wareki.mjs";

// 月は 1 始まりで書けるようにする
const d = (y, m, day, ...time) => new Date(y, m - 1, day, ...time);

function assertSameDate(actual, y, m, day) {
  assert.ok(actual instanceof Date, "Date を返すこと");
  assert.deepEqual(
    [actual.getFullYear(), actual.getMonth() + 1, actual.getDate(), actual.getHours(), actual.getMinutes()],
    [y, m, day, 0, 0],
  );
}

// ---------- toWareki ----------

test("toWareki: 令和の日付を変換する", () => {
  assert.equal(toWareki(d(2026, 10, 26)), "令和8年10月26日");
});

test("toWareki: 1年目は「元年」と書く", () => {
  assert.equal(toWareki(d(2019, 5, 1)), "令和元年5月1日");
  assert.equal(toWareki(d(2019, 12, 31)), "令和元年12月31日");
});

test("toWareki: 平成と令和の境界", () => {
  assert.equal(toWareki(d(2019, 4, 30)), "平成31年4月30日");
  assert.equal(toWareki(d(2019, 5, 1)), "令和元年5月1日");
});

test("toWareki: 昭和と平成の境界", () => {
  assert.equal(toWareki(d(1989, 1, 7)), "昭和64年1月7日");
  assert.equal(toWareki(d(1989, 1, 8)), "平成元年1月8日");
});

test("toWareki: 大正と昭和の境界", () => {
  assert.equal(toWareki(d(1926, 12, 24)), "大正15年12月24日");
  assert.equal(toWareki(d(1926, 12, 25)), "昭和元年12月25日");
});

test("toWareki: 明治と大正の境界", () => {
  assert.equal(toWareki(d(1912, 7, 29)), "明治45年7月29日");
  assert.equal(toWareki(d(1912, 7, 30)), "大正元年7月30日");
});

test("toWareki: 明治の初日は変換でき、それより前は RangeError", () => {
  assert.equal(toWareki(d(1868, 10, 23)), "明治元年10月23日");
  assert.throws(() => toWareki(d(1868, 10, 22)), RangeError);
});

test("toWareki: 時刻は結果に影響しない", () => {
  assert.equal(toWareki(d(2019, 4, 30, 23, 59, 59)), "平成31年4月30日");
  assert.equal(toWareki(d(2019, 5, 1, 0, 0, 0)), "令和元年5月1日");
});

test("toWareki: 不正な入力", () => {
  assert.throws(() => toWareki(new Date("not a date")), RangeError);
  assert.throws(() => toWareki("2026-10-26"), TypeError);
  assert.throws(() => toWareki(undefined), TypeError);
});

// ---------- parseWareki ----------

test("parseWareki: 漢字表記を読む", () => {
  assertSameDate(parseWareki("令和8年10月26日"), 2026, 10, 26);
  assertSameDate(parseWareki("昭和64年1月7日"), 1989, 1, 7);
  assertSameDate(parseWareki("明治元年10月23日"), 1868, 10, 23);
});

test("parseWareki: 1年目は「元年」「1年」のどちらでも読む", () => {
  assertSameDate(parseWareki("令和元年5月1日"), 2019, 5, 1);
  assertSameDate(parseWareki("令和1年5月1日"), 2019, 5, 1);
});

test("parseWareki: 略記（英字1文字.年.月.日）を読む", () => {
  assertSameDate(parseWareki("R8.10.26"), 2026, 10, 26);
  assertSameDate(parseWareki("H31.4.30"), 2019, 4, 30);
  assertSameDate(parseWareki("S64.1.7"), 1989, 1, 7);
  assertSameDate(parseWareki("T15.12.24"), 1926, 12, 24);
  assertSameDate(parseWareki("M45.7.29"), 1912, 7, 29);
  assertSameDate(parseWareki("r8.10.26"), 2026, 10, 26);
});

test("parseWareki: 全角数字と前後の空白を受け付ける", () => {
  assertSameDate(parseWareki("令和８年１０月２６日"), 2026, 10, 26);
  assertSameDate(parseWareki("  令和8年10月26日\n"), 2026, 10, 26);
});

test("parseWareki: その元号に存在しない日付は RangeError", () => {
  assert.throws(() => parseWareki("平成31年5月1日"), RangeError); // 令和に改元済み
  assert.throws(() => parseWareki("令和1年4月30日"), RangeError); // まだ平成
  assert.throws(() => parseWareki("S64.1.8"), RangeError);        // 平成に改元済み
  assert.throws(() => parseWareki("明治元年10月22日"), RangeError); // 明治より前
});

test("parseWareki: 暦にない日付・不正な書式は RangeError", () => {
  for (const s of ["令和5年2月30日", "令和5年13月1日", "令和0年1月1日", "令和5年2月", "2026-10-26", "X8.10.26", ""]) {
    assert.throws(() => parseWareki(s), RangeError, s);
  }
});

test("parseWareki: 文字列以外は TypeError", () => {
  assert.throws(() => parseWareki(20261026), TypeError);
  assert.throws(() => parseWareki(null), TypeError);
});

// ---------- 往復 ----------

test("往復: toWareki の結果を parseWareki に通すと元の日付に戻る", () => {
  for (let t = d(1868, 10, 23); t <= d(2035, 12, 31); t = d(t.getFullYear(), t.getMonth() + 1, t.getDate() + 97)) {
    assertSameDate(parseWareki(toWareki(t)), t.getFullYear(), t.getMonth() + 1, t.getDate());
  }
});
