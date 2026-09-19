"use client";

import { useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { ArrowRight, ChevronLeft, KeyRound, LoaderCircle, Mail, Pill } from "lucide-react";

type Request = <T>(
  path: string,
  body?: unknown,
  method?: string,
  signal?: AbortSignal,
) => Promise<T>;

/** Codes and passwords live only in the form; the reset grant is an HttpOnly cookie. */
export function PasswordReset({
  request,
  onComplete,
}: {
  request: Request;
  onComplete: () => void;
}) {
  const [step, setStep] = useState<"email" | "code" | "password">("email");
  const [email, setEmail] = useState("");
  const [requestId, setRequestId] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [resendAt, setResendAt] = useState(0);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (step !== "code") return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [step]);
  const remaining = Math.max(0, Math.ceil((resendAt - now) / 1000));

  async function send() {
    setBusy(true);
    setError("");
    try {
      const result = await request<{ requestId: string; resendAfter: number; message: string }>(
        "/auth/password-reset/request",
        { email },
      );
      setRequestId(result.requestId);
      setNotice(result.message);
      setCode("");
      setResendAt(Date.now() + result.resendAfter * 1000);
      setNow(Date.now());
      setStep("code");
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "현재 인증 메일을 전송할 수 없습니다. 잠시 후 다시 시도해주세요.",
      );
    } finally {
      setBusy(false);
    }
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (step === "email") return send();
    setBusy(true);
    setError("");
    const fields = new FormData(event.currentTarget);
    try {
      if (step === "code") {
        await request("/auth/password-reset/verify", { requestId, email, code });
        setCode("");
        setNotice("이메일 인증을 확인했습니다. 5분 안에 새 비밀번호를 저장해 주세요.");
        setStep("password");
      } else {
        if (fields.get("password") !== fields.get("passwordConfirm")) {
          throw new Error("새 비밀번호와 확인 입력이 일치하지 않습니다.");
        }
        await request("/auth/password-reset/complete", {
          password: fields.get("password"),
          passwordConfirm: fields.get("passwordConfirm"),
        });
        event.currentTarget?.reset();
        onComplete();
      }
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "요청을 처리하지 못했습니다. 다시 시도해주세요.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="auth-layout">
      <section className="auth-story">
        <Link href="/" className="logo">
          <Pill size={29} />
          하루영양<span>.</span>
        </Link>
        <div>
          <span className="eyebrow">BACK TO YOUR DAILY CARE</span>
          <h1>
            내 계정으로,
            <br />
            다시 이어가는 하루.
          </h1>
          <p>
            가입 이메일을 확인한 뒤<br />새 비밀번호를 설정해 주세요.
          </p>
          <div className="auth-symbol">
            <Mail size={56} />
            <KeyRound size={46} />
          </div>
        </div>
        <span>나의 기록은 그대로, 비밀번호만 새롭게</span>
      </section>
      <section className="auth-panel">
        <Link className="back-link" href="/login">
          <ChevronLeft size={16} />
          로그인으로
        </Link>
        <div className="auth-form">
          <span className="badge blue-badge">ACCOUNT RECOVERY</span>
          <h1>비밀번호 재설정</h1>
          <p>
            {step === "email"
              ? "가입할 때 사용한 이메일을 입력해 주세요."
              : step === "code"
                ? "이메일로 받은 6자리 인증번호를 입력해 주세요."
                : "새 비밀번호로 모든 기기에서 다시 로그인하게 됩니다."}
          </p>
          <ol className="reset-steps" aria-label="비밀번호 재설정 단계">
            {["이메일", "인증번호", "새 비밀번호"].map((label, index) => (
              <li
                key={label}
                aria-current={
                  index === ["email", "code", "password"].indexOf(step) ? "step" : undefined
                }
              >
                {index + 1}. {label}
              </li>
            ))}
          </ol>
          {notice && (
            <div className="notice" role="status">
              {notice}
            </div>
          )}
          <form onSubmit={submit}>
            {error && (
              <div className="alert error" role="alert">
                {error}
              </div>
            )}
            {step === "email" && (
              <label>
                가입 이메일
                <input
                  type="email"
                  autoComplete="email"
                  required
                  maxLength={254}
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="hello@example.com"
                />
              </label>
            )}
            {step === "code" && (
              <>
                <label>
                  인증번호
                  <input
                    className="reset-code"
                    name="code"
                    autoComplete="one-time-code"
                    inputMode="numeric"
                    pattern="[0-9]{6}"
                    minLength={6}
                    maxLength={6}
                    required
                    value={code}
                    onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                    placeholder="6자리 숫자"
                  />
                </label>
                <p className="field-help">
                  인증번호는 요청 후 10분 동안 유효하며, 5회 틀리면 사용할 수 없습니다. 메일이
                  보이지 않으면 스팸함도 확인해 주세요. 요청 접수는 메일 전달 완료를 뜻하지
                  않습니다.
                </p>
              </>
            )}
            {step === "password" && (
              <>
                <label>
                  새 비밀번호
                  <input
                    name="password"
                    type="password"
                    autoComplete="new-password"
                    minLength={10}
                    maxLength={128}
                    required
                    placeholder="10~128자로 입력해 주세요"
                  />
                </label>
                <label>
                  새 비밀번호 확인
                  <input
                    name="passwordConfirm"
                    type="password"
                    autoComplete="new-password"
                    minLength={10}
                    maxLength={128}
                    required
                    placeholder="한 번 더 입력해 주세요"
                  />
                </label>
              </>
            )}
            <button className="button primary full" disabled={busy}>
              {busy ? <LoaderCircle size={18} className="spin" /> : <ArrowRight size={18} />}
              {step === "email"
                ? "인증번호 요청"
                : step === "code"
                  ? "인증번호 확인"
                  : "새 비밀번호 저장"}
            </button>
          </form>
          {step === "code" && (
            <div className="reset-actions">
              <button
                type="button"
                className="text-link"
                disabled={busy || remaining > 0}
                onClick={() => void send()}
              >
                {remaining ? `${remaining}초 후 다시 요청` : "인증번호 다시 요청"}
              </button>
              <button
                type="button"
                className="text-link"
                disabled={busy}
                onClick={() => {
                  setStep("email");
                  setNotice("");
                  setError("");
                  setCode("");
                }}
              >
                다른 이메일 입력
              </button>
              <p className="field-help">
                이메일당 1시간에 최대 5회 요청할 수 있습니다. 새로 요청하면 이전 인증번호는 사용할
                수 없습니다.
              </p>
            </div>
          )}
        </div>
      </section>
    </main>
  );
}
