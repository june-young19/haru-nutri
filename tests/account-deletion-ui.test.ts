import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AccountDangerZone, AccountDeletion } from "../components/account-deletion";

test("account settings entry navigates to disclosure without submitting a deletion", () => {
  const html = renderToStaticMarkup(createElement(AccountDangerZone));
  assert.match(html, /위험 영역/);
  assert.match(html, /href="\/settings\/delete-account"/);
  assert.match(html, /되돌릴 수 없습니다/);
  assert.doesNotMatch(html, /<form|<button/);
});

test("initial deletion view discloses history and sessions with cancel and no destructive submit", () => {
  let called = false;
  const html = renderToStaticMarkup(
    createElement(AccountDeletion, {
      request: async <T>() => {
        called = true;
        return {} as T;
      },
      onDeleted: () => {
        called = true;
      },
    }),
  );
  for (const label of [
    "과거 복용 기록",
    "보호자",
    "설문",
    "모든 로그인 세션",
    "복구할 수 없습니다",
    "취소",
    "계속",
  ])
    assert.ok(html.includes(label));
  assert.doesNotMatch(html, /<form|탈퇴하기<|name="password"/);
  assert.equal(called, false);
});
