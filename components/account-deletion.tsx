"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { ArrowLeft, ArrowRight, LoaderCircle, ShieldCheck, Trash2 } from "lucide-react";

type RequestApi = <T>(path: string, body?: unknown, method?: string) => Promise<T>;

export function AccountDangerZone() {
  return (
    <section className="card account-danger-zone" aria-labelledby="account-danger-title">
      <span className="deletion-eyebrow">위험 영역</span>
      <h2 id="account-danger-title">회원 탈퇴</h2>
      <p>계정과 하루영양에 저장된 개인 데이터가 삭제됩니다. 이 작업은 되돌릴 수 없습니다.</p>
      <Link className="button deletion-outline" href="/settings/delete-account">
        <Trash2 size={17} />
        회원 탈퇴
      </Link>
    </section>
  );
}

export function AccountDeletion({
  request,
  onDeleted,
}: {
  request: RequestApi;
  onDeleted: () => void;
}) {
  const [step, setStep] = useState<"details" | "password" | "confirm">("details");
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [expiresAt, setExpiresAt] = useState<number | null>(null);
  const locked = useRef(false);
  const title = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    title.current?.focus();
  }, [step]);

  useEffect(() => {
    if (step !== "confirm" || expiresAt === null) return;
    const timer = window.setTimeout(
      () => {
        setStep("password");
        setConfirmed(false);
        setExpiresAt(null);
        setError("본인 확인 시간이 만료되었습니다. 현재 비밀번호를 다시 확인해주세요.");
      },
      Math.max(0, expiresAt - Date.now()),
    );
    return () => window.clearTimeout(timer);
  }, [step, expiresAt]);

  async function verify(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (locked.current) return;
    const form = event.currentTarget;
    locked.current = true;
    setBusy(true);
    setError("");
    try {
      const result = await request<{ verified: boolean; expiresIn: number }>(
        "/account/deletion/verify",
        { password: new FormData(form).get("password") },
      );
      if (!result.verified) throw new Error("본인 확인을 완료하지 못했습니다. 다시 시도해주세요.");
      setExpiresAt(Date.now() + result.expiresIn * 1000);
      setConfirmed(false);
      setStep("confirm");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "본인 확인을 완료하지 못했습니다.");
    } finally {
      form.reset();
      locked.current = false;
      setBusy(false);
    }
  }

  async function cancel() {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    setError("");
    try {
      await request("/account/deletion/cancel", {});
      window.location.replace("/settings");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "잠시 후 다시 시도해주세요.");
      locked.current = false;
      setBusy(false);
    }
  }

  async function complete(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (locked.current || !confirmed) return;
    locked.current = true;
    setBusy(true);
    setError("");
    try {
      const result = await request<{ deleted: boolean }>("/account/deletion/complete", {
        confirmed: true,
      });
      if (!result.deleted) throw new Error("회원 탈퇴가 완료되지 않았습니다. 다시 확인해주세요.");
      onDeleted();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "회원 탈퇴 처리 중 문제가 발생했습니다. 잠시 후 다시 시도해주세요.",
      );
      locked.current = false;
      setBusy(false);
    }
  }

  return (
    <div className="form-width account-deletion">
      <div className="page-heading">
        <div>
          <div className="eyebrow">ACCOUNT</div>
          <h1>회원 탈퇴</h1>
          <p>결정하기 전에 삭제되는 정보를 확인해 주세요.</p>
        </div>
      </div>
      <ol className="deletion-steps" aria-label="회원 탈퇴 진행 단계">
        <li aria-current={step === "details" ? "step" : undefined}>1. 삭제 범위 확인</li>
        <li aria-current={step === "password" ? "step" : undefined}>2. 본인 확인</li>
        <li aria-current={step === "confirm" ? "step" : undefined}>3. 최종 확인</li>
      </ol>
      <section className="card form-card deletion-card" aria-busy={busy}>
        <h2 ref={title} tabIndex={-1}>
          {step === "details" && (
            <>
              <Trash2 size={21} /> 탈퇴하면 다음 정보가 삭제됩니다
            </>
          )}
          {step === "password" && (
            <>
              <ShieldCheck size={21} /> 현재 비밀번호를 확인해주세요
            </>
          )}
          {step === "confirm" && (
            <>
              <Trash2 size={21} /> 정말 회원 탈퇴하시겠습니까?
            </>
          )}
        </h2>
        {error && (
          <div className="alert error" role="alert">
            {error}
          </div>
        )}
        {step === "details" && (
          <>
            <ul className="deletion-data-list">
              <li>계정과 이름·나이·이메일 등 프로필</li>
              <li>등록한 영양제·성분·복용 일정과 과거 복용 기록</li>
              <li>설문 응답과 개인화된 관심 성분 정보</li>
              <li>보호자 이메일·동의 및 본인·보호자 알림 설정</li>
              <li>알림 기록·대기 상태와 비밀번호 재설정 인증 정보</li>
              <li>현재 기기를 포함한 모든 로그인 세션</li>
            </ul>
            <div className="deletion-warning">
              회원 탈퇴 후 계정과 저장된 하루영양 데이터는 복구할 수 없습니다. 같은 이메일로 다시
              가입해도 이전 데이터는 연결되지 않습니다.
            </div>
            <p className="field-help">
              탈퇴가 완료되면 추가 알림 발송 대상에서 제외됩니다. 이미 이메일 제공자에 전달된 메일은
              취소할 수 없습니다.
            </p>
            <div className="form-actions">
              <button type="button" className="button secondary" onClick={cancel} disabled={busy}>
                <ArrowLeft size={17} />
                취소
              </button>
              <button
                type="button"
                className="button primary"
                disabled={busy}
                onClick={() => setStep("password")}
              >
                계속
                <ArrowRight size={17} />
              </button>
            </div>
          </>
        )}
        {step === "password" && (
          <form onSubmit={verify}>
            <p className="deletion-description">로그인한 계정의 비밀번호를 서버에서 확인합니다.</p>
            <label>
              현재 비밀번호
              <input
                type="password"
                name="password"
                autoComplete="current-password"
                required
                minLength={10}
                maxLength={128}
                disabled={busy}
              />
            </label>
            <Link className="text-link" href="/forgot-password">
              비밀번호를 잊으셨나요? 비밀번호 재설정
            </Link>
            <div className="form-actions">
              <button type="button" className="button secondary" onClick={cancel} disabled={busy}>
                탈퇴 취소
              </button>
              <button className="button primary" disabled={busy}>
                {busy ? <LoaderCircle className="spin" size={17} /> : <ShieldCheck size={17} />}본인
                확인
              </button>
            </div>
          </form>
        )}
        {step === "confirm" && (
          <form onSubmit={complete}>
            <p className="deletion-description" role="status">
              비밀번호 확인을 마쳤습니다. 5분 안에 최종 확인해 주세요.
            </p>
            <div className="deletion-warning">
              계정과 모든 개인 복용 기록이 삭제됩니다. 이 작업은 취소하거나 복구할 수 없습니다.
            </div>
            <label className="checkbox-label deletion-confirm">
              <input
                type="checkbox"
                checked={confirmed}
                disabled={busy}
                required
                onChange={(event) => setConfirmed(event.currentTarget.checked)}
              />
              <span>삭제 범위를 확인했으며, 복구할 수 없다는 점을 이해했습니다.</span>
            </label>
            <div className="form-actions">
              <button type="button" className="button secondary" onClick={cancel} disabled={busy}>
                취소
              </button>
              <button className="button deletion-submit" disabled={busy || !confirmed}>
                {busy ? <LoaderCircle className="spin" size={17} /> : <Trash2 size={17} />}
                {busy ? "탈퇴 처리 중…" : "탈퇴하기"}
              </button>
            </div>
          </form>
        )}
      </section>
    </div>
  );
}
