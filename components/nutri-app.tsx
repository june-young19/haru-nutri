"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  ArrowRight,
  ArrowUpRight,
  Bell,
  CalendarDays,
  Check,
  CheckCheck,
  ChevronLeft,
  ChevronRight,
  CircleHelp,
  Clock3,
  FlaskConical,
  Heart,
  LayoutDashboard,
  Leaf,
  LoaderCircle,
  LogOut,
  Mail,
  Menu,
  Pill,
  Plus,
  Settings2,
  ShieldCheck,
  Sparkles,
  Sun,
  Trash2,
  TrendingUp,
  X,
} from "lucide-react";
import { duplicateGroups, surveyQuestions, surveyResults } from "@/lib/domain";
import type { Dashboard, DayHistory, Settings, Supplement, TodayItem, User } from "@/lib/types";
import type { SafetyAnalysis } from "@/lib/safety";
import { SafetyResults } from "./safety-results";

const sessionChangeKey = "haru:session-change";
const sessionExpiredEvent = "haru:session-expired";
let sessionRevision = 0;

class ApiRequestError extends Error {
  constructor(
    public status: number,
    text: string,
  ) {
    super(text);
  }
}

function hidePrivateView() {
  document.documentElement.dataset.haruSessionPending = "true";
}

function showVerifiedView() {
  // A request started in the foreground may finish after the tab was hidden.
  // Keep its private DOM hidden until a fresh foreground verification completes.
  if (document.visibilityState === "visible") {
    delete document.documentElement.dataset.haruSessionPending;
  }
}

function publishSessionChange() {
  // Only a timestamp is shared between tabs. Session tokens remain HttpOnly.
  try {
    const stored = Number(localStorage.getItem(sessionChangeKey));
    const previous = Number.isSafeInteger(stored) && stored >= 0 ? stored : 0;
    localStorage.setItem(sessionChangeKey, String(Math.max(Date.now(), previous + 1)));
  } catch {
    // Focus/visibility checks still validate the session when storage is disabled.
  }
}

async function api<T>(
  path: string,
  body?: unknown,
  method?: string,
  signal?: AbortSignal,
): Promise<T> {
  const revision = sessionRevision;
  const response = await fetch(`/api${path}`, {
    method: method || (body ? "POST" : "GET"),
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    cache: "no-store",
    signal,
  });
  const result = await response.json();
  if (revision !== sessionRevision) throw new DOMException("Session changed", "AbortError");
  if (response.status === 401 && !["/me", "/auth/login", "/auth/signup"].includes(path)) {
    hidePrivateView();
    window.dispatchEvent(new Event(sessionExpiredEvent));
  }
  if (!response.ok)
    throw new ApiRequestError(
      response.status,
      result.error || "요청을 처리하지 못했어요. 다시 시도해 주세요.",
    );
  return result.data as T;
}

function useResource<T>(path: string) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const mounted = useRef(false);
  const requestNumber = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const reload = useCallback(async () => {
    controller.current?.abort();
    const currentController = new AbortController();
    controller.current = currentController;
    const currentRequest = ++requestNumber.current;
    const isCurrent = () =>
      mounted.current &&
      currentRequest === requestNumber.current &&
      !currentController.signal.aborted;
    setError("");
    try {
      const next = await api<T>(path, undefined, undefined, currentController.signal);
      if (isCurrent()) setData(next);
    } catch (e) {
      if (isCurrent() && !(e instanceof DOMException && e.name === "AbortError")) {
        setData(null);
        setError(message(e));
      }
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }, [path]);
  useEffect(() => {
    mounted.current = true;
    setData(null);
    setLoading(true);
    void reload();
    return () => {
      mounted.current = false;
      requestNumber.current += 1;
      controller.current?.abort();
    };
  }, [reload]);
  return { data, error, loading, reload };
}
function message(e: unknown) {
  return e instanceof Error ? e.message : "잠시 후 다시 시도해 주세요.";
}
const colors = ["blue", "orange", "green", "purple"];
const disclaimer =
  "이 서비스는 의학적 진단이나 치료를 제공하지 않습니다. 설문과 성분 정보는 참고용이며, 개인의 상태에 따른 판단은 전문가에게 확인하세요.";

function Logo() {
  return (
    <span className="logo">
      <span className="logo-mark">
        <Pill size={22} strokeWidth={2.5} />
      </span>
      하루영양<span className="logo-dot">.</span>
    </span>
  );
}
function Spinner() {
  return (
    <div className="loading" role="status">
      <LoaderCircle className="spin" /> 불러오는 중이에요
    </div>
  );
}
function ErrorBox({ error }: { error?: string }) {
  return error ? (
    <div className="alert error" role="alert">
      {error}
    </div>
  ) : null;
}
function Notice({ children }: { children: ReactNode }) {
  return (
    <div className="notice">
      <ShieldCheck size={18} />
      <span>{children}</span>
    </div>
  );
}
function Heading({
  eyebrow,
  title,
  subtitle,
  action,
}: {
  eyebrow?: string;
  title: string;
  subtitle?: string;
  action?: ReactNode;
}) {
  return (
    <div className="page-heading">
      <div>
        {eyebrow && <div className="eyebrow">{eyebrow}</div>}
        <h1>{title}</h1>
        {subtitle && <p>{subtitle}</p>}
      </div>
      {action}
    </div>
  );
}
function Empty({
  title,
  children,
  href = "/supplements/new",
  label = "첫 영양제 등록하기",
}: {
  title: string;
  children: ReactNode;
  href?: string;
  label?: string;
}) {
  return (
    <div className="empty">
      <div className="empty-icon">
        <Pill size={30} />
      </div>
      <h3>{title}</h3>
      <p>{children}</p>
      <Link className="button primary" href={href}>
        <Plus size={18} />
        {label}
      </Link>
    </div>
  );
}
function Bottle({ color = "blue" }: { color?: string }) {
  return (
    <span className={`pill-icon ${colors.includes(color) ? color : "blue"}`}>
      <Pill size={24} />
    </span>
  );
}

export default function NutriApp() {
  const path = usePathname();
  const [user, setUser] = useState<User | null>(null);
  const [checking, setChecking] = useState(true);
  const [menuOpen, setMenuOpen] = useState(false);
  const [authError, setAuthError] = useState("");
  const [loggingOut, setLoggingOut] = useState(false);
  const userRef = useRef<User | null>(null);
  const sessionCheck = useRef<AbortController | null>(null);
  const leaving = useRef(false);

  const replaceSessionView = useCallback((destination: string, announce = false) => {
    if (leaving.current) return;
    leaving.current = true;
    sessionRevision += 1;
    sessionCheck.current?.abort();
    hidePrivateView();
    userRef.current = null;
    setUser(null);
    setChecking(true);
    setMenuOpen(false);
    if (announce) publishSessionChange();
    // A full navigation discards the Next router cache and all account-scoped state.
    window.location.replace(destination);
  }, []);

  const verifySession = useCallback(async () => {
    if (leaving.current) return;
    sessionCheck.current?.abort();
    const controller = new AbortController();
    sessionCheck.current = controller;
    const current = userRef.current;
    const publicPage = ["/", "/login", "/signup"].includes(window.location.pathname);
    setAuthError("");
    if (!current) setChecking(true);
    if (!publicPage) hidePrivateView();
    try {
      const result = await api<{ user: User }>("/me", undefined, undefined, controller.signal);
      if (controller.signal.aborted || leaving.current) return;
      if (current && current.id !== result.user.id) {
        replaceSessionView("/dashboard");
        return;
      }
      if (["/login", "/signup"].includes(window.location.pathname)) {
        replaceSessionView(result.user.onboarded ? "/dashboard" : "/onboarding", true);
        return;
      }
      userRef.current = result.user;
      setUser(result.user);
      setAuthError("");
      setChecking(false);
      showVerifiedView();
    } catch (error) {
      if (
        controller.signal.aborted ||
        leaving.current ||
        (error instanceof DOMException && error.name === "AbortError")
      )
        return;
      userRef.current = null;
      setUser(null);
      if (!publicPage) {
        if (error instanceof ApiRequestError && error.status === 401) {
          replaceSessionView("/login", true);
        } else {
          // A failed network request does not prove that the session expired.
          // Clear the private component tree and retry without redirect loops.
          sessionRevision += 1;
          setChecking(false);
          setAuthError("로그인 상태를 확인하지 못했어요. 연결을 확인한 뒤 다시 시도해 주세요.");
        }
        return;
      }
      setChecking(false);
      showVerifiedView();
    }
  }, [replaceSessionView]);

  useEffect(() => {
    const expired = () => replaceSessionView("/login", true);
    const changedInAnotherTab = (event: StorageEvent) => {
      if (event.key === sessionChangeKey && event.newValue !== event.oldValue) {
        // The server resolves whether the new session is signed in or signed out.
        replaceSessionView("/dashboard");
      }
    };
    const pageHidden = () => {
      // Hide private content before it can enter the back/forward cache snapshot.
      hidePrivateView();
    };
    const pageShown = (event: PageTransitionEvent) => {
      if (event.persisted) {
        leaving.current = false;
        replaceSessionView(window.location.pathname + window.location.search);
      }
    };
    const focused = () => void verifySession();
    const visibilityChanged = () => {
      if (document.visibilityState === "visible") void verifySession();
      else hidePrivateView();
    };
    window.addEventListener(sessionExpiredEvent, expired);
    window.addEventListener("storage", changedInAnotherTab);
    window.addEventListener("pagehide", pageHidden);
    window.addEventListener("pageshow", pageShown);
    window.addEventListener("focus", focused);
    document.addEventListener("visibilitychange", visibilityChanged);
    return () => {
      sessionCheck.current?.abort();
      window.removeEventListener(sessionExpiredEvent, expired);
      window.removeEventListener("storage", changedInAnotherTab);
      window.removeEventListener("pagehide", pageHidden);
      window.removeEventListener("pageshow", pageShown);
      window.removeEventListener("focus", focused);
      document.removeEventListener("visibilitychange", visibilityChanged);
    };
  }, [replaceSessionView, verifySession]);

  useEffect(() => {
    setMenuOpen(false);
    void verifySession();
  }, [path, verifySession]);
  async function logout() {
    if (loggingOut) return;
    setLoggingOut(true);
    setAuthError("");
    try {
      await api("/auth/logout", {});
      replaceSessionView("/login", true);
    } catch (e) {
      setAuthError(message(e));
      setLoggingOut(false);
    }
  }
  function signedIn(next: User) {
    replaceSessionView(next.onboarded ? "/dashboard" : "/onboarding", true);
  }
  if (path === "/") return <Landing user={user} />;
  if (path === "/login" || path === "/signup")
    return <AuthPage key={path} signup={path === "/signup"} onSuccess={signedIn} />;
  if (checking || !user)
    return (
      <div className="standalone">
        <Logo />
        {authError ? (
          <>
            <ErrorBox error={authError} />
            <button className="button primary" onClick={() => void verifySession()}>
              로그인 상태 다시 확인
            </button>
          </>
        ) : (
          <Spinner />
        )}
      </div>
    );
  const navigation = [
    { href: "/dashboard", label: "오늘의 영양제", icon: LayoutDashboard },
    { href: "/supplements", label: "내 영양제", icon: Pill },
    { href: "/duplicates", label: "성분 안전 확인", icon: FlaskConical },
    { href: "/history", label: "복용 기록", icon: CalendarDays },
  ];
  let page: ReactNode;
  if (path === "/dashboard") page = <DashboardPage />;
  else if (path === "/onboarding")
    page = (
      <Onboarding
        onComplete={() =>
          setUser((current) =>
            current?.id === user.id ? { ...current, onboarded: true } : current,
          )
        }
      />
    );
  else if (path === "/survey")
    page = (
      <Survey
        onComplete={() =>
          setUser((current) =>
            current?.id === user.id ? { ...current, onboarded: true } : current,
          )
        }
      />
    );
  else if (path === "/survey/results") page = <SurveyResults />;
  else if (path === "/supplements") page = <SupplementsPage />;
  else if (path === "/supplements/new") page = <SupplementEditor />;
  else if (/^\/supplements\/[^/]+$/.test(path)) page = <SupplementEditor id={path.split("/")[2]} />;
  else if (path === "/duplicates") page = <DuplicatesPage />;
  else if (path === "/history") page = <HistoryPage />;
  else if (path === "/settings" || path === "/settings/guardian")
    page = (
      <SettingsPage
        guardian={path.endsWith("guardian")}
        onSave={(name, age) =>
          setUser((current) => (current?.id === user.id ? { ...current, name, age } : current))
        }
        onLogout={logout}
        loggingOut={loggingOut}
      />
    );
  else if (path === "/notifications") page = <NotificationsPage />;
  else
    page = (
      <Empty title="페이지를 찾을 수 없어요" href="/dashboard" label="오늘의 영양제로">
        주소를 다시 확인해 주세요.
      </Empty>
    );
  return (
    <div className="app-shell" key={user.id}>
      {menuOpen && (
        <button className="menu-scrim" aria-label="메뉴 닫기" onClick={() => setMenuOpen(false)} />
      )}
      <aside className={`sidebar ${menuOpen ? "open" : ""}`}>
        <Link href="/dashboard" aria-label="하루영양 홈">
          <Logo />
        </Link>
        <div className="nav-caption">MY DAILY ROUTINE</div>
        <nav aria-label="주요 메뉴">
          {navigation.map(({ href, label, icon: Icon }) => (
            <Link
              key={href}
              href={href}
              className={`nav-link ${(href === "/supplements" ? path.startsWith(href) : path === href) ? "active" : ""}`}
            >
              <Icon size={20} />
              {label}
              {href === "/dashboard" && <span className="nav-live" />}
            </Link>
          ))}
        </nav>
        <Link className="survey-promo" href="/survey">
          <span className="promo-icon">
            <Sparkles size={21} />
          </span>
          <strong>나에게 맞는 영양 습관</strong>
          <p>
            가벼운 생활습관 설문으로
            <br />
            관심 성분을 알아보세요.
          </p>
          <span>
            1분 설문 시작하기 <ArrowRight size={16} />
          </span>
        </Link>
        <div className="sidebar-bottom">
          <Link
            className={`nav-link ${path === "/notifications" ? "active" : ""}`}
            href="/notifications"
          >
            <Bell size={20} />
            알림 보관함
          </Link>
          <Link
            className={`nav-link ${path.startsWith("/settings") ? "active" : ""}`}
            href="/settings"
          >
            <Settings2 size={20} />
            설정
          </Link>
          <div className="profile">
            <span className="avatar">{user.name.slice(0, 1)}</span>
            <div>
              <strong>{user.name}</strong>
              <span>나의 건강한 하루</span>
            </div>
            <button
              aria-label="로그아웃"
              className="icon-button"
              onClick={logout}
              disabled={loggingOut}
            >
              <LogOut size={18} />
            </button>
          </div>
        </div>
      </aside>
      <div className="app-body">
        <header className="topbar">
          <div className="mobile-brand">
            <button
              className="icon-button"
              aria-label="메뉴 열기"
              onClick={() => setMenuOpen(true)}
            >
              <Menu />
            </button>
            <Logo />
          </div>
          <span className="topbar-label">작은 습관이 만드는 건강한 일상</span>
          <div className="topbar-right">
            <span className="timezone">
              <Sun size={16} /> 오늘도, 하루영양
            </span>
            <Link
              className={`topbar-settings ${path.startsWith("/settings") ? "active" : ""}`}
              href="/settings"
              aria-current={path.startsWith("/settings") ? "page" : undefined}
            >
              <Settings2 size={18} />
              <span>설정</span>
            </Link>
            <Link
              className="icon-button notification-button"
              href="/notifications"
              aria-label="알림 보관함"
            >
              <Bell size={21} />
            </Link>
            <span className="avatar small">{user.name.slice(0, 1)}</span>
          </div>
        </header>
        <main className="main-content" key={`${user.id}:${path}`}>
          <ErrorBox error={authError} />
          {page}
          <footer className="app-footer">
            <Logo />
            <p>{disclaimer}</p>
            <span>© {new Date().getFullYear()} 하루영양</span>
          </footer>
        </main>
      </div>
    </div>
  );
}

function Landing({ user }: { user: User | null }) {
  return (
    <div className="landing">
      <header className="landing-nav">
        <Link href="/">
          <Logo />
        </Link>
        <nav>
          <Link href="/login">로그인</Link>
          <Link className="button primary small-btn" href={user ? "/dashboard" : "/signup"}>
            {user ? "내 대시보드" : "무료로 시작하기"}
            <ArrowUpRight size={16} />
          </Link>
        </nav>
      </header>
      <main>
        <div className="landing-hero">
          <div>
            <span className="badge blue-badge">
              <Leaf size={15} /> 나를 돌보는 가장 작은 습관
            </span>
            <h1>
              오늘의 영양제,
              <br />
              <em>잊지 않는 하루.</em>
            </h1>
            <p>
              챙겨 먹는 일부터 겹치는 성분 확인까지.
              <br />
              흩어져 있던 영양제 관리를 하루영양에서 시작하세요.
            </p>
            <div className="hero-actions">
              <Link className="button primary" href={user ? "/dashboard" : "/signup"}>
                내 영양제 관리 시작하기 <ArrowRight size={19} />
              </Link>
              <span>간단한 가입으로 시작해요</span>
            </div>
            <div className="hero-trust">
              <ShieldCheck size={17} /> 내 기록은 나에게만 · 이메일로 편안하게
            </div>
          </div>
          <div className="landing-preview">
            <div className="preview-head">
              <span className="badge">YOUR DAILY CARE</span>
              <Sun size={28} />
            </div>
            <h2>
              건강한 하루를
              <br />
              차곡차곡.
            </h2>
            <div className="preview-routine">
              <span>
                <CheckCheck size={25} />
              </span>
              <div>
                <strong>나만의 복용 루틴</strong>
                <p>시간에 맞춰 확인하고 기록해요</p>
              </div>
              <Check size={20} />
            </div>
            <div className="preview-routine">
              <span>
                <FlaskConical size={25} />
              </span>
              <div>
                <strong>한눈에 보는 영양성분</strong>
                <p>여러 제품의 중복 성분을 알아봐요</p>
              </div>
              <Plus size={20} />
            </div>
            <div className="preview-bottom">
              <Heart size={17} /> 매일의 작은 실천, 나를 위한 좋은 변화
            </div>
          </div>
        </div>
        <div className="landing-features">
          {[
            {
              icon: Clock3,
              title: "하루 일정은 간단하게",
              desc: "내가 정한 복용 시간과 완료 상태를 한눈에.",
            },
            {
              icon: FlaskConical,
              title: "겹치는 성분은 꼼꼼하게",
              desc: "제품별 함량과 등록한 하루 총량을 함께 확인.",
            },
            {
              icon: Mail,
              title: "놓친 확인은 다정하게",
              desc: "복용 확인이 늦어지면 이메일로 안내.",
            },
          ].map(({ icon: Icon, title, desc }) => (
            <article key={title}>
              <Icon size={25} />
              <h3>{title}</h3>
              <p>{desc}</p>
            </article>
          ))}
        </div>
        <Notice>{disclaimer}</Notice>
      </main>
      <footer className="landing-footer">
        <Logo />
        <span>매일의 작은 건강 습관</span>
      </footer>
    </div>
  );
}

function AuthPage({ signup, onSuccess }: { signup: boolean; onSuccess: (user: User) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const f = new FormData(e.currentTarget);
    try {
      const r = await api<{ user: User }>(`/auth/${signup ? "signup" : "login"}`, {
        email: f.get("email"),
        password: f.get("password"),
        name: f.get("name"),
        age: signup ? Number(f.get("age")) : undefined,
      });
      onSuccess(r.user);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="auth-layout">
      <section className="auth-story">
        <Link href="/">
          <Logo />
        </Link>
        <div>
          <span className="eyebrow">A LITTLE CARE, EVERY DAY</span>
          <h1>
            좋은 습관 하나,
            <br />
            나를 위한 하루.
          </h1>
          <p>
            영양제 챙기는 일, 이제 조금 더 가볍게.
            <br />
            하루영양이 당신의 일상을 함께할게요.
          </p>
          <div className="auth-symbol">
            <Pill size={62} />
            <Plus size={24} />
            <Heart size={48} />
          </div>
        </div>
        <span>작은 실천이 쌓이는 나만의 건강 기록</span>
      </section>
      <section className="auth-panel">
        <Link className="back-link" href="/">
          <ChevronLeft size={16} />
          홈으로
        </Link>
        <div className="auth-form">
          <span className="badge blue-badge">MY DAILY CARE</span>
          <h1>{signup ? "반가워요, 시작해 볼까요?" : "다시 만나서 반가워요"}</h1>
          <p>
            {signup
              ? "나만의 영양 루틴을 만드는 첫걸음이에요."
              : "오늘의 작은 건강 습관을 이어가 보세요."}
          </p>
          <form onSubmit={submit}>
            <ErrorBox error={error} />
            {signup && (
              <>
                <label>
                  이름
                  <input
                    name="name"
                    placeholder="어떻게 불러드릴까요?"
                    required
                    minLength={1}
                    maxLength={30}
                    autoComplete="name"
                  />
                </label>
                <label>
                  만 나이
                  <input
                    name="age"
                    type="number"
                    min={1}
                    max={120}
                    step={1}
                    inputMode="numeric"
                    required
                    placeholder="예: 20"
                  />
                  <span className="field-help">
                    1~120세의 정수로 입력해 주세요. 연령별 참고 상한선 확인에 사용해요.
                  </span>
                </label>
              </>
            )}
            <label>
              이메일
              <input
                name="email"
                type="email"
                placeholder="hello@example.com"
                required
                maxLength={254}
                autoComplete="email"
              />
            </label>
            <label>
              비밀번호
              <input
                name="password"
                type="password"
                placeholder={signup ? "10자 이상으로 입력해 주세요" : "비밀번호를 입력해 주세요"}
                required
                minLength={signup ? 10 : 1}
                maxLength={128}
                autoComplete={signup ? "new-password" : "current-password"}
              />
            </label>
            {signup && (
              <p className="field-help">
                비밀번호는 안전하게 해시 처리되며, 다른 사용자에게 내 기록이 공개되지 않습니다.
              </p>
            )}
            <button className="button primary full" disabled={busy}>
              {busy ? <LoaderCircle className="spin" size={18} /> : null}
              {signup ? "회원가입" : "로그인"}
              <ArrowRight size={18} />
            </button>
          </form>
          <p className="auth-switch">
            {signup ? "이미 계정이 있나요?" : "아직 계정이 없나요?"}{" "}
            <Link href={signup ? "/login" : "/signup"}>{signup ? "로그인" : "회원가입"}</Link>
          </p>
          <Notice>
            생활습관 관리와 정보 확인을 위한 서비스입니다. 의료 진단이나 치료를 제공하지 않습니다.
          </Notice>
        </div>
      </section>
    </main>
  );
}

function Onboarding({ onComplete }: { onComplete: () => void }) {
  const router = useRouter();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function choose(choice: "survey" | "direct") {
    if (choice === "survey") {
      router.push("/survey");
      return;
    }
    setBusy(true);
    try {
      await api("/onboarding", { choice });
      onComplete();
      router.push("/supplements/new");
    } catch (e) {
      setError(message(e));
      setBusy(false);
    }
  }
  return (
    <div className="narrow">
      <Heading
        eyebrow="WELCOME TO HARU"
        title="어떤 하루를 시작해 볼까요?"
        subtitle="지금 나에게 맞는 쪽을 골라 주세요. 언제든 다시 바꿀 수 있어요."
      />
      <ErrorBox error={error} />
      <div className="choice-grid">
        <button className="choice-card" disabled={busy} onClick={() => choose("survey")}>
          <span className="large-icon purple">
            <Sparkles size={32} />
          </span>
          <span className="badge">가볍게 알아보기</span>
          <h2>
            어떤 영양제를 먹어야 할지
            <br />
            모르겠어요
          </h2>
          <p>
            7가지 생활습관 질문으로 관심 있게
            <br />
            확인해볼 영양성분을 알아보세요.
          </p>
          <span className="text-link">
            1분 설문 시작 <ArrowRight size={18} />
          </span>
        </button>
        <button className="choice-card" disabled={busy} onClick={() => choose("direct")}>
          <span className="large-icon blue">
            <Pill size={32} />
          </span>
          <span className="badge">바로 관리하기</span>
          <h2>
            이미 먹고 있는
            <br />
            영양제가 있어요
          </h2>
          <p>
            내 영양제를 등록하고 복용 일정과
            <br />
            겹치는 성분을 한 번에 관리해요.
          </p>
          <span className="text-link">
            내 영양제 등록 <ArrowRight size={18} />
          </span>
        </button>
      </div>
      <Notice>{disclaimer}</Notice>
    </div>
  );
}

function DashboardPage() {
  const { data, error, loading, reload } = useResource<Dashboard>("/dashboard");
  const supplements = useResource<Supplement[]>("/supplements");
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState("");
  async function toggle(item: TodayItem) {
    if (!data) return;
    setBusy(item.scheduleId);
    setActionError("");
    try {
      await api(
        "/intakes",
        { scheduleId: item.scheduleId, date: data.date, completed: !item.completedAt },
        "PUT",
      );
      await reload();
    } catch (e) {
      setActionError(message(e));
    } finally {
      setBusy(null);
    }
  }
  if (loading) return <Spinner />;
  if (!data) return <ErrorBox error={error} />;
  const percent = data.total ? Math.round((data.completed / data.total) * 100) : 0;
  const duplicates = duplicateGroups(supplements.data || []);
  const dateLabel = new Date(data.date + "T12:00:00+09:00").toLocaleDateString("ko-KR", {
    month: "long",
    day: "numeric",
    weekday: "long",
    timeZone: "Asia/Seoul",
  });
  return (
    <>
      <Heading
        eyebrow="MY DAILY ROUTINE"
        title={`${data.name}님, 오늘도 건강한 하루 ☀`}
        subtitle="나를 위한 작은 습관, 하나씩 채워 볼까요?"
        action={
          <Link className="button primary" href="/supplements/new">
            <Plus size={18} />
            영양제 등록
          </Link>
        }
      />
      <ErrorBox error={error || actionError} />
      <section className="daily-banner">
        <div>
          <span className="banner-label">
            <CalendarDays size={15} />
            {dateLabel}
          </span>
          <h2>
            {data.total && percent === 100
              ? "오늘의 루틴을 모두 채웠어요!"
              : "오늘도 나를 챙기는 시간"}
          </h2>
          <p>
            {data.total ? (
              <>
                총 <strong>{data.total}개</strong>의 복용 일정 중{" "}
                <strong>{data.completed}개</strong>를 완료했어요.
              </>
            ) : (
              "첫 영양제를 등록하고 나만의 루틴을 시작해 보세요."
            )}
          </p>
          <div className="banner-chips">
            <span>
              <CheckCheck size={15} />
              오늘의 작은 실천
            </span>
            <span>
              <Heart size={15} />
              내일의 좋은 습관
            </span>
          </div>
        </div>
        <div
          className="progress-circle"
          style={{ "--progress": `${percent}%` } as React.CSSProperties}
        >
          <div>
            <strong>
              {percent}
              <small>%</small>
            </strong>
            <span>오늘의 복용률</span>
          </div>
        </div>
      </section>
      <div className="dashboard-grid">
        <section className="card routine-card">
          <div className="section-title">
            <h2>
              오늘 먹을 영양제 <span className="count-badge">{data.total}</span>
            </h2>
            <span className="muted">
              <Clock3 size={14} /> 한국 시간 기준
            </span>
          </div>
          {!data.items.length ? (
            <>
              <Empty title="아직 등록한 영양제가 없어요">
                이름과 복용 시간을 등록하면
                <br />
                오늘의 일정이 여기에 나타나요.
              </Empty>
              <Link className="demo-button" href="/supplements/new?example=multivitamin">
                <Sparkles size={15} />
                예시 성분을 확인하고 등록하기
              </Link>
            </>
          ) : (
            <div className="intake-list">
              {data.items.map((item) => (
                <IntakeRow
                  key={item.scheduleId}
                  item={item}
                  busy={busy === item.scheduleId}
                  onToggle={() => toggle(item)}
                />
              ))}
            </div>
          )}
          <div className="routine-bottom">
            <span>
              <CircleHelp size={15} /> 복용했다면 완료 버튼을 눌러 주세요.
            </span>
            <Link href="/supplements">
              내 영양제 보기 <ChevronRight size={15} />
            </Link>
          </div>
        </section>
        <div className="dashboard-aside">
          <section className="card streak-card">
            <span className="round-icon orange">
              <TrendingUp size={22} />
            </span>
            <span className="muted">차곡차곡 쌓인 나의 습관</span>
            <h3>
              {data.streak}
              <span>일 연속 완료</span>
            </h3>
            <p>{data.streak ? "꾸준히 나를 챙기고 있어요." : "오늘부터 첫 기록을 쌓아 보세요."}</p>
            <Link href="/history">
              복용 기록 살펴보기 <ArrowUpRight size={16} />
            </Link>
          </section>
          <section
            className={`card duplicate-summary ${duplicates.length ? "has-duplicates" : ""}`}
          >
            <div className="section-title">
              <span className="round-icon blue">
                <FlaskConical size={21} />
              </span>
              <span className={`badge ${duplicates.length ? "amber-badge" : "blue-badge"}`}>
                {duplicates.length ? "확인해 주세요" : "성분 체크"}
              </span>
            </div>
            <h3>
              {duplicates.length ? `${duplicates.length}가지 성분이 겹쳐요` : "내 영양성분, 한눈에"}
            </h3>
            <p>
              {duplicates.length
                ? `${duplicates
                    .map((d) => d.name)
                    .slice(0, 2)
                    .join(", ")} 성분이 여러 제품에 포함되어 있어요.`
                : "등록한 제품 사이에 같은 성분이 있는지 확인해요."}
            </p>
            <Link href="/duplicates">
              성분 안전 확인 <ArrowRight size={16} />
            </Link>
          </section>
        </div>
      </div>
      <section className="bottom-tip">
        <span className="tip-icon">
          <Leaf size={25} />
        </span>
        <div>
          <strong>건강한 습관은, 나를 알아가는 것부터</strong>
          <p>식사와 생활습관을 돌아보고 관심 있게 확인해볼 성분을 알아보세요.</p>
        </div>
        <Link href="/survey">
          생활습관 설문 <ArrowRight size={17} />
        </Link>
      </section>
    </>
  );
}
function IntakeRow({
  item,
  busy,
  onToggle,
  readonly = false,
}: {
  item: TodayItem;
  busy?: boolean;
  onToggle?: () => void;
  readonly?: boolean;
}) {
  return (
    <div className={`intake-row ${item.completedAt ? "completed" : ""}`}>
      <div className="intake-time">
        <span>{item.time}</span>
        <span>
          {Number(item.time.slice(0, 2)) < 12
            ? "오전"
            : Number(item.time.slice(0, 2)) < 18
              ? "오후"
              : "저녁"}
        </span>
      </div>
      <Bottle color={item.color} />
      <div className="intake-name">
        {item.archived ? (
          <strong>
            {item.name} <span className="muted">삭제된 제품 · 과거 기록</span>
          </strong>
        ) : (
          <Link href={`/supplements/${item.supplementId}`}>
            <strong>{item.name}</strong>
          </Link>
        )}
        <span>
          {item.completedAt
            ? `${new Date(item.completedAt).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Seoul" })} 완료`
            : item.brand || "나를 위한 영양 습관"}
        </span>
      </div>
      {readonly || item.archived ? (
        <span className={`badge ${item.completedAt ? "green-badge" : ""}`}>
          {item.completedAt ? "완료" : "미확인"}
        </span>
      ) : (
        <button
          className={`intake-check ${item.completedAt ? "checked" : ""}`}
          disabled={busy}
          aria-pressed={!!item.completedAt}
          onClick={onToggle}
        >
          {busy ? (
            <LoaderCircle size={17} className="spin" />
          ) : item.completedAt ? (
            <Check size={18} />
          ) : (
            <span className="check-empty" />
          )}
          {item.completedAt ? "복용 완료" : "완료 체크"}
        </button>
      )}
    </div>
  );
}

function SupplementsPage() {
  const { data, error, loading } = useResource<Supplement[]>("/supplements");
  return (
    <>
      <Heading
        eyebrow="MY SUPPLEMENTS"
        title="내 영양제"
        subtitle="매일 챙기는 영양제와 복용 시간을 관리해요."
        action={
          <Link href="/supplements/new" className="button primary">
            <Plus size={18} />
            영양제 등록
          </Link>
        }
      />
      <ErrorBox error={error} />
      {loading ? (
        <Spinner />
      ) : !data?.length ? (
        <section className="card">
          <Empty title="나만의 영양제 목록을 만들어 보세요">
            제품 라벨을 보면서 성분과 하루 함량을 입력해 주세요.
          </Empty>
        </section>
      ) : (
        <div className="supplement-grid">
          {data.map((item) => (
            <Link className="card supplement-card" href={`/supplements/${item.id}`} key={item.id}>
              <div className="section-title">
                <Bottle color={item.color} />
                <ArrowUpRight size={20} />
              </div>
              <h2>{item.name}</h2>
              <p>{item.brand || "직접 등록한 영양제"}</p>
              <div className="ingredient-pills">
                {item.ingredients.slice(0, 3).map((v, i) => (
                  <span key={i}>{v.name}</span>
                ))}
                {item.ingredients.length > 3 && <span>+{item.ingredients.length - 3}</span>}
              </div>
              <div className="supplement-card-bottom">
                <Clock3 size={16} />
                <span>
                  {item.schedules
                    .filter((s) => !s.endDate)
                    .map((s) => s.time)
                    .join(" · ")}
                </span>
                <strong>관리하기</strong>
              </div>
            </Link>
          ))}
        </div>
      )}
      <Notice>등록 함량은 제품 라벨에 표시된 하루 섭취량을 기준으로 입력해 주세요.</Notice>
    </>
  );
}

type IngredientInput = { name: string; amount: number | string; unit: string };
function SupplementEditor({ id }: { id?: string }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [brand, setBrand] = useState("");
  const [color, setColor] = useState("blue");
  const [times, setTimes] = useState(["09:00"]);
  const [ingredients, setIngredients] = useState<IngredientInput[]>([
    { name: "", amount: "", unit: "mg" },
  ]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(!!id);
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [saved, setSaved] = useState("");
  const [preview, setPreview] = useState<{ signature: string; analysis: SafetyAnalysis } | null>(
    null,
  );
  const [checkingSafety, setCheckingSafety] = useState(false);
  const [acknowledgedSignature, setAcknowledgedSignature] = useState("");
  const draft = {
    name,
    brand,
    color,
    times,
    ingredients: ingredients.map((v) => ({ ...v, amount: Number(v.amount) })),
  };
  const signature = JSON.stringify(draft);
  const analysis = preview?.signature === signature ? preview.analysis : null;
  const acknowledged = !!analysis && acknowledgedSignature === signature;
  useEffect(() => {
    setPreview(null);
    setAcknowledgedSignature("");
  }, [signature]);
  async function checkSafety() {
    setCheckingSafety(true);
    setError("");
    setSaved("");
    setAcknowledgedSignature("");
    try {
      const result = await api<SafetyAnalysis>("/safety/preview", {
        ...draft,
        excludeSupplementId: id,
      });
      setPreview({ signature, analysis: result });
    } catch (e) {
      setError(message(e));
    } finally {
      setCheckingSafety(false);
    }
  }
  useEffect(() => {
    if (!id) {
      if (new URLSearchParams(window.location.search).get("example") === "multivitamin") {
        setName("데일리 종합비타민");
        setBrand("시연용 예시 · 실제 제품 라벨로 수정해 주세요");
        setIngredients([
          { name: "비타민 C", amount: 100, unit: "mg" },
          { name: "비타민 D", amount: 20, unit: "μg" },
          { name: "아연", amount: 10, unit: "mg" },
        ]);
      }
      return;
    }
    api<Supplement[]>("/supplements")
      .then((items) => {
        const s = items.find((s) => s.id === id);
        if (!s)
          throw new Error(
            "영양제를 찾을 수 없어요. 삭제된 영양제의 이전 기록은 복용 기록에서 확인할 수 있습니다.",
          );
        setName(s.name);
        setBrand(s.brand || "");
        setColor(s.color);
        setTimes(s.schedules.filter((v) => !v.endDate).map((v) => v.time));
        setIngredients(s.ingredients);
      })
      .catch((e) => setError(message(e)))
      .finally(() => setLoading(false));
  }, [id]);
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!analysis || (analysis.hasExceedance && !acknowledged)) {
      setError("성분 검사 결과를 확인한 뒤 저장해 주세요.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const r = await api<Supplement & { scheduleChangeEffectiveDate?: string }>(
        id ? `/supplements/${id}` : "/supplements",
        {
          ...draft,
          safetyAcknowledged: acknowledged,
        },
        id ? "PUT" : "POST",
      );
      if (id)
        setSaved(
          `저장했어요. ${r.scheduleChangeEffectiveDate ? `변경된 일정은 ${r.scheduleChangeEffectiveDate}부터 적용됩니다.` : "복용 일정에 반영되었습니다."}`,
        );
      else router.push("/dashboard");
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  async function remove() {
    setBusy(true);
    try {
      await api(`/supplements/${id}`, undefined, "DELETE");
      router.push("/supplements");
    } catch (e) {
      setError(message(e));
      setBusy(false);
    }
  }
  function updateIngredient(index: number, key: keyof IngredientInput, value: string) {
    setIngredients((a) => a.map((v, i) => (i === index ? { ...v, [key]: value } : v)));
  }
  if (loading) return <Spinner />;
  return (
    <div className="form-width">
      <Link className="back-link" href="/supplements">
        <ChevronLeft size={16} />내 영양제
      </Link>
      <Heading
        eyebrow="MY SUPPLEMENTS"
        title={id ? "영양제 상세 · 수정" : "새로운 영양제 등록"}
        subtitle="제품 라벨을 보면서 하나씩 입력해 주세요."
      />
      <form onSubmit={submit}>
        <ErrorBox error={error} />
        {saved && (
          <div role="status" className="alert success">
            {saved} <Link href="/dashboard">오늘의 일정 확인 →</Link>
          </div>
        )}
        <section className="card form-card">
          <h2>
            <span className="step-badge">01</span>기본 정보
          </h2>
          <div className="two-fields">
            <label>
              영양제 이름 <b>*</b>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="예: 데일리 종합비타민"
                maxLength={80}
                required
              />
            </label>
            <label>
              제조사 또는 제품명 <span className="muted">선택</span>
              <input
                value={brand}
                onChange={(e) => setBrand(e.target.value)}
                placeholder="예: 제품 라벨의 제조사"
                maxLength={100}
              />
            </label>
          </div>
          <label>구분 색상</label>
          <div className="color-picker">
            {colors.map((c) => (
              <button
                type="button"
                aria-label={`${c} 색상`}
                aria-pressed={color === c}
                className={`color-swatch ${c}`}
                key={c}
                onClick={() => setColor(c)}
              >
                {color === c && <Check size={18} />}
              </button>
            ))}
          </div>
        </section>
        <section className="card form-card">
          <h2>
            <span className="step-badge">02</span>복용 일정
          </h2>
          <p className="section-description">
            매일 같은 시간에 복용할 일정을 등록해요. 한국 시간(Asia/Seoul) 기준입니다.
          </p>
          <label>
            하루 복용 횟수
            <select
              value={times.length}
              onChange={(e) => {
                const n = Number(e.target.value);
                setTimes((old) =>
                  Array.from(
                    { length: n },
                    (_, i) => old[i] || `${String((9 + i * 3) % 24).padStart(2, "0")}:00`,
                  ),
                );
              }}
            >
              {Array.from({ length: 8 }, (_, i) => (
                <option key={i} value={i + 1}>
                  하루 {i + 1}회
                </option>
              ))}
            </select>
          </label>
          <div className="time-fields">
            {times.map((time, i) => (
              <label key={i}>
                {i + 1}번째 복용 시간
                <input
                  type="time"
                  required
                  value={time}
                  onChange={(e) => setTimes((a) => a.map((v, j) => (j === i ? e.target.value : v)))}
                />
              </label>
            ))}
          </div>
          {id && (
            <p className="field-help">
              오늘 이미 완료한 일정이 있으면 변경 사항은 내일부터 적용되어 기존 기록을 보존합니다.
            </p>
          )}
        </section>
        <section className="card form-card">
          <h2>
            <span className="step-badge">03</span>성분과 하루 함량
          </h2>
          <div className="alert info">
            성분별 <strong>하루 총 섭취량</strong>을 입력해 주세요. 예: 1회 50mg을 하루 2회 복용하면
            100mg입니다. 복용 횟수를 다시 곱하지 않습니다.
          </div>
          <datalist id="ingredients">
            {[
              "비타민 A",
              "비타민 B군",
              "비타민 B1",
              "비타민 B2",
              "비타민 B6",
              "비타민 B12",
              "비타민 C",
              "비타민 D",
              "비타민 E",
              "비타민 K",
              "마그네슘",
              "오메가3",
              "아연",
              "칼슘",
              "철",
              "엽산",
            ].map((v) => (
              <option value={v} key={v} />
            ))}
          </datalist>
          <div className="ingredient-rows">
            {ingredients.map((v, i) => (
              <div className="ingredient-row" key={i}>
                <label>
                  성분 이름
                  <input
                    list="ingredients"
                    required
                    maxLength={60}
                    placeholder="예: 비타민 D"
                    value={v.name}
                    onChange={(e) => updateIngredient(i, "name", e.target.value)}
                  />
                </label>
                <label>
                  하루 함량
                  <input
                    required
                    type="number"
                    min="0.000001"
                    max="10000000"
                    step="any"
                    inputMode="decimal"
                    placeholder="20"
                    value={v.amount}
                    onChange={(e) => updateIngredient(i, "amount", e.target.value)}
                  />
                </label>
                <label>
                  단위
                  <select
                    value={v.unit}
                    onChange={(e) => updateIngredient(i, "unit", e.target.value)}
                  >
                    {["mg", "μg", "mcg", "g", "IU"].map((u) => (
                      <option key={u}>{u}</option>
                    ))}
                  </select>
                </label>
                <button
                  type="button"
                  className="icon-button remove-ingredient"
                  aria-label={`${i + 1}번째 성분 삭제`}
                  disabled={ingredients.length === 1}
                  onClick={() => setIngredients((a) => a.filter((_, j) => j !== i))}
                >
                  <Trash2 size={18} />
                </button>
              </div>
            ))}
          </div>
          <button
            type="button"
            className="button dashed full"
            disabled={ingredients.length >= 20}
            onClick={() => setIngredients((a) => [...a, { name: "", amount: "", unit: "mg" }])}
          >
            <Plus size={17} />
            성분 추가
          </button>
        </section>
        <section className="card form-card safety-preview">
          <h2>
            <span className="step-badge">04</span>기존 영양제와 성분 비교
          </h2>
          <p className="section-description">
            저장하기 전에 중복 성분과 연령별 참고 상한선을 확인해요. 수정할 때는 기존 제품을 새
            입력값으로 교체하여 계산합니다.
          </p>
          <button
            type="button"
            className="button secondary full"
            disabled={busy || checkingSafety}
            onClick={(e) => {
              if (e.currentTarget.form?.reportValidity()) void checkSafety();
            }}
          >
            {checkingSafety ? (
              <LoaderCircle size={18} className="spin" />
            ) : (
              <FlaskConical size={18} />
            )}
            성분 검사
          </button>
          {!analysis && (
            <p className="field-help">입력을 변경했다면 성분 검사를 다시 눌러 주세요.</p>
          )}
          {analysis && (
            <div aria-live="polite">
              <SafetyResults analysis={analysis} preview />
              {analysis.hasExceedance && (
                <label className="checkbox-label safety-ack">
                  <input
                    type="checkbox"
                    checked={acknowledged}
                    onChange={(e) => setAcknowledgedSignature(e.target.checked ? signature : "")}
                  />
                  <span>
                    <strong>내용을 확인했습니다</strong>
                    <small>
                      참고 상한선 초과 안내를 확인했으며, 필요한 경우 전문가에게 확인하겠습니다.
                    </small>
                  </span>
                </label>
              )}
            </div>
          )}
        </section>
        <div className="form-actions">
          <Link className="button secondary" href="/supplements">
            취소
          </Link>
          <button
            className="button primary"
            disabled={
              busy || checkingSafety || !analysis || (analysis.hasExceedance && !acknowledged)
            }
          >
            {busy ? <LoaderCircle className="spin" size={17} /> : <Check size={17} />}영양제{" "}
            {id ? "저장" : "등록"}
          </button>
        </div>
      </form>
      {id && (
        <div className="danger-zone">
          {!deleteConfirm ? (
            <button className="danger-link" onClick={() => setDeleteConfirm(true)}>
              <Trash2 size={16} />이 영양제 삭제하기
            </button>
          ) : (
            <div className="alert">
              <p>
                오늘과 앞으로의 일정 및 알림에서 삭제합니다. 저장된 과거 복용 완료 기록은
                보존됩니다.
              </p>
              <button className="button danger" disabled={busy} onClick={remove}>
                삭제 확인
              </button>
              <button className="button secondary" onClick={() => setDeleteConfirm(false)}>
                돌아가기
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function DuplicatesPage() {
  const { data, error, loading } = useResource<SafetyAnalysis>("/safety");
  return (
    <>
      <Heading
        eyebrow="INGREDIENT CHECK"
        title="성분 안전 확인"
        subtitle="성분 중복과 나이에 따른 참고 상한섭취량을 함께 확인해요."
      />
      <ErrorBox error={error} />
      {loading ? (
        <Spinner />
      ) : !data?.items.length ? (
        <section className="card">
          <Empty title="등록한 성분이 아직 없어요">
            영양제를 등록하면 성분별 하루 총량을 비교해 드려요.
          </Empty>
        </section>
      ) : (
        <SafetyResults analysis={data} />
      )}
    </>
  );
}
function HistoryPage() {
  const { data, error, loading, reload } = useResource<{ days: DayHistory[]; streak: number }>(
    "/history",
  );
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState("");
  async function correct(item: TodayItem, date: string) {
    setBusy(item.scheduleId);
    setActionError("");
    try {
      await api(
        "/intakes",
        { scheduleId: item.scheduleId, date, completed: !item.completedAt },
        "PUT",
      );
      await reload();
    } catch (e) {
      setActionError(message(e));
    } finally {
      setBusy(null);
    }
  }
  if (loading) return <Spinner />;
  if (!data) return <ErrorBox error={error} />;
  const active = data.days.find((d) => d.date === selected) || data.days[data.days.length - 1];
  const total = data.days.reduce((a, d) => a + d.total, 0);
  const done = data.days.reduce((a, d) => a + d.completed, 0);
  return (
    <>
      <Heading
        eyebrow="MY HEALTHY HABITS"
        title="복용 기록"
        subtitle="하나씩 쌓아온 나의 습관을 돌아보세요."
      />
      <ErrorBox error={error || actionError} />
      <div className="stats-grid">
        <section className="card stat">
          <span>최근 7일 복용률</span>
          <strong>
            {total ? Math.round((done / total) * 100) : 0}
            <small>%</small>
          </strong>
          <p>
            전체 {total}개 일정 중 {done}개 완료
          </p>
        </section>
        <section className="card stat">
          <span>연속 완료 기록</span>
          <strong>
            {data.streak}
            <small>일</small>
          </strong>
          <p>하루의 모든 일정을 완료한 날 기준</p>
        </section>
        <section className="card stat">
          <span>최근 7일 완료한 복용</span>
          <strong>
            {done}
            <small>회</small>
          </strong>
          <p>꾸준히 쌓아가는 나의 작은 실천</p>
        </section>
      </div>
      <section className="card history-chart">
        <div className="section-title">
          <h2>일주일의 기록</h2>
          <span className="muted">날짜를 눌러 자세히 확인해요</span>
        </div>
        <div className="week-bars">
          {data.days.map((d) => (
            <button
              key={d.date}
              className={`day-bar ${active?.date === d.date ? "selected" : ""}`}
              onClick={() => setSelected(d.date)}
              aria-label={`${d.date} 복용률 ${d.rate}%`}
              aria-pressed={active?.date === d.date}
            >
              <strong>{d.total ? `${d.rate}%` : "—"}</strong>
              <div className="bar-track">
                <div style={{ height: `${d.total ? Math.max(d.rate, 3) : 0}%` }} />
              </div>
              <span>
                {new Date(d.date + "T12:00:00+09:00").toLocaleDateString("ko-KR", {
                  weekday: "short",
                  timeZone: "Asia/Seoul",
                })}
              </span>
              <small>{d.date.slice(5).replace("-", ".")}</small>
            </button>
          ))}
        </div>
        <p className="field-help">일정이 없던 날은 — 로 표시하며 복용률에 포함하지 않습니다.</p>
      </section>
      {active && (
        <section className="card routine-card">
          <div className="section-title">
            <h2>{active.date.replaceAll("-", ".")} 복용 내역</h2>
            <span className="badge blue-badge">
              {active.completed} / {active.total} 완료
            </span>
          </div>
          {active.items.length ? (
            active.items.map((item) => (
              <IntakeRow
                key={item.scheduleId}
                item={item}
                busy={busy === item.scheduleId}
                onToggle={() => correct(item, active.date)}
              />
            ))
          ) : (
            <div className="empty compact">
              <CalendarDays size={30} />
              <p>이날은 등록된 복용 일정이 없어요.</p>
            </div>
          )}
          <div className="routine-bottom">
            <span>
              최근 7일의 빠뜨린 체크를 수정할 수 있어요. 완료 시각은 체크를 저장한 시각입니다.
            </span>
          </div>
        </section>
      )}
    </>
  );
}

function Survey({ onComplete }: { onComplete: () => void }) {
  const router = useRouter();
  const [step, setStep] = useState(0);
  const [answers, setAnswers] = useState<number[]>(Array(7).fill(-1));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const q = surveyQuestions[step];
  async function next() {
    if (step < surveyQuestions.length - 1) {
      setStep(step + 1);
      return;
    }
    setBusy(true);
    try {
      await api("/onboarding", { choice: "survey", answers });
      onComplete();
      router.push("/survey/results");
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="survey-width">
      <Heading
        eyebrow="LIFESTYLE CHECK"
        title="나를 알아가는 1분"
        subtitle="평소의 생활을 편하게 떠올려 주세요."
      />
      <section className="card survey-card">
        <div className="section-title">
          <span className="badge blue-badge">생활습관 설문</span>
          <span className="muted">
            {step + 1} / {surveyQuestions.length}
          </span>
        </div>
        <div className="survey-progress">
          <div style={{ width: `${((step + 1) / surveyQuestions.length) * 100}%` }} />
        </div>
        <span className="large-icon blue">
          <Leaf size={29} />
        </span>
        <h2>{q.title}</h2>
        <p>{q.hint}</p>
        <div className="survey-options">
          {q.options.map((o, i) => (
            <button
              className={answers[step] === i ? "selected" : ""}
              aria-pressed={answers[step] === i}
              key={o}
              onClick={() => setAnswers((a) => a.map((v, j) => (j === step ? i : v)))}
            >
              <span>{o}</span>
              {answers[step] === i ? <Check size={21} /> : <span className="radio-circle" />}
            </button>
          ))}
        </div>
        <ErrorBox error={error} />
        <div className="form-actions">
          <button
            className="button secondary"
            disabled={step === 0 || busy}
            onClick={() => setStep(step - 1)}
          >
            <ChevronLeft size={17} />
            이전
          </button>
          <button className="button primary" disabled={answers[step] < 0 || busy} onClick={next}>
            {busy ? "정리하는 중…" : step === 6 ? "결과 확인하기" : "다음 질문"}
            <ArrowRight size={17} />
          </button>
        </div>
      </section>
      <Notice>
        설문은 생활습관을 돌아보기 위한 참고 자료입니다. 영양 결핍을 판정하거나 특정 제품의 복용을
        권하지 않습니다.
      </Notice>
    </div>
  );
}
function SurveyResults() {
  const [answers, setAnswers] = useState<number[] | null>(null);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    api<{ answers: number[] | null }>("/onboarding")
      .then((r) => setAnswers(r.answers))
      .catch(() => setAnswers(null))
      .finally(() => setLoaded(true));
  }, []);
  if (!loaded) return <Spinner />;
  if (!answers)
    return (
      <Empty title="먼저 생활습관을 들려주세요" href="/survey" label="설문 시작하기">
        7가지 질문에 답하면 관심 성분을 확인할 수 있어요.
      </Empty>
    );
  const results = surveyResults(answers);
  return (
    <>
      <Heading
        eyebrow="YOUR LIFESTYLE NOTES"
        title="관심 있게 확인해볼 영양성분"
        subtitle="생활습관 응답을 바탕으로 알아보면 좋은 정보를 모았어요."
      />
      <Notice>
        이 결과는 참고용 정보이며 결핍 여부나 복용 필요성을 의미하지 않습니다. 균형 잡힌 식사와
        생활습관을 먼저 돌아보고, 필요하면 전문가와 상의하세요.
      </Notice>
      {!results.length ? (
        <section className="card positive-state">
          <Leaf size={38} />
          <h2>지금의 좋은 생활습관을 이어가 보세요</h2>
          <p>
            응답에 따른 특정 관심 성분은 없습니다. 이것이 영양 상태가 충분하다는 의학적 판단은
            아닙니다.
          </p>
        </section>
      ) : (
        <div className="results-grid">
          {results.map((r, i) => (
            <article className="card nutrient-result" key={r.name}>
              <span className={`large-icon ${colors[i % 4]}`}>
                <Leaf size={27} />
              </span>
              <span className="badge">살펴볼 영양성분</span>
              <h2>{r.name}</h2>
              <p>{r.reason}</p>
              <div className="food-note">
                <strong>식사에서도 만나보세요</strong>
                <p>{r.food}</p>
              </div>
              <a className="text-link" href={r.sourceUrl} target="_blank" rel="noreferrer">
                NIH 영양성분 정보 <ArrowUpRight size={15} />
              </a>
            </article>
          ))}
        </div>
      )}
      <div className="results-actions">
        <Link className="button primary" href="/supplements/new">
          <Plus size={18} />내 영양제 등록하기
        </Link>
        <Link className="button secondary" href="/survey">
          설문 다시 하기
        </Link>
      </div>
    </>
  );
}

function SettingsPage({
  guardian,
  onSave,
  onLogout,
  loggingOut,
}: {
  guardian: boolean;
  onSave: (name: string, age: number | null) => void;
  onLogout: () => Promise<void>;
  loggingOut: boolean;
}) {
  const { data, error, loading, reload } = useResource<Settings>("/settings");
  if (loading) return <Spinner />;
  if (!data) return <ErrorBox error={error} />;
  return (
    <SettingsForm
      key={String(guardian)}
      data={data}
      guardian={guardian}
      onLogout={onLogout}
      loggingOut={loggingOut}
      onSave={async (name, age) => {
        onSave(name, age);
        await reload();
      }}
    />
  );
}
function SettingsForm({
  data,
  guardian,
  onSave,
  onLogout,
  loggingOut,
}: {
  data: Settings;
  guardian: boolean;
  onSave: (name: string, age: number | null) => Promise<void>;
  onLogout: () => Promise<void>;
  loggingOut: boolean;
}) {
  const [name, setName] = useState(data.name);
  const [age, setAge] = useState<number | string>(data.age ?? "");
  const [enabled, setEnabled] = useState(data.reminderEnabled);
  const [delay, setDelay] = useState(data.delayMinutes);
  const [gDelay, setGDelay] = useState(data.guardianDelayMinutes);
  const [gEmail, setGEmail] = useState(data.guardianEmail || "");
  const [gEnabled, setGEnabled] = useState(data.guardianEnabled);
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    setSuccess("");
    try {
      await api(
        "/settings",
        guardian
          ? {
              guardianEmail: gEmail,
              guardianEnabled: gEnabled,
              guardianConsent: consent ? true : undefined,
              guardianDelayMinutes: gDelay,
            }
          : {
              name,
              ...(age !== "" ? { age: Number(age) } : {}),
              reminderEnabled: enabled,
              delayMinutes: delay,
            },
        "PATCH",
      );
      setSuccess("설정을 저장했어요.");
      await onSave(name, age === "" ? data.age : Number(age));
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="form-width">
      <Heading
        eyebrow="MY PREFERENCES"
        title={guardian ? "보호자 이메일 설정" : "설정"}
        subtitle={
          guardian
            ? "원하는 경우에만, 동의한 보호자와 복용 확인을 함께해요."
            : "내 생활에 맞게 하루영양을 설정하세요."
        }
      />
      <section className="card account-summary" aria-label="로그인한 계정">
        <span className="avatar">{data.name.slice(0, 1)}</span>
        <div className="account-summary-info">
          <strong>
            {data.name} <span>{data.age === null ? "나이 미설정" : `만 ${data.age}세`}</span>
          </strong>
          <p>{data.email}</p>
          <Link href="/settings/guardian">
            보호자 알림 {data.guardianEnabled ? "사용 중" : "꺼짐"} <ChevronRight size={14} />
          </Link>
        </div>
        <button
          type="button"
          className="button account-logout"
          onClick={onLogout}
          disabled={loggingOut}
        >
          {loggingOut ? <LoaderCircle className="spin" size={18} /> : <LogOut size={18} />}
          {loggingOut ? "로그아웃 중…" : "로그아웃"}
        </button>
      </section>
      <div className="settings-tabs">
        <Link href="/settings" className={!guardian ? "active" : ""}>
          기본 설정
        </Link>
        <Link href="/settings/guardian" className={guardian ? "active" : ""}>
          보호자 알림
        </Link>
      </div>
      <form onSubmit={submit}>
        <ErrorBox error={error} />
        {success && (
          <div role="status" className="alert success">
            {success}
          </div>
        )}
        {!guardian ? (
          <>
            <section className="card form-card">
              <h2>
                <span className="round-icon blue">
                  <Heart size={19} />
                </span>
                내 프로필
              </h2>
              <label>
                이름
                <input
                  value={name}
                  required
                  maxLength={30}
                  onChange={(e) => setName(e.target.value)}
                />
              </label>
              <label>
                만 나이
                <input
                  type="number"
                  min={1}
                  max={120}
                  step={1}
                  inputMode="numeric"
                  value={age}
                  required={data.age !== null}
                  onChange={(e) => setAge(e.target.value)}
                  placeholder="예: 20"
                />
                <span className="field-help">
                  나이가 없으면 연령별 상한선 비교를 하지 않습니다. 생일이 지나면 만 나이를 갱신해
                  주세요.
                </span>
              </label>
              <label>
                가입 이메일
                <input value={data.email} readOnly type="email" />
                <span className="field-help">이 이메일로 복용 확인 안내를 보내요.</span>
              </label>
              <label>
                시간대
                <input value="한국 표준시 (Asia/Seoul, UTC+09:00)" readOnly />
              </label>
            </section>
            <section className="card form-card">
              <h2>
                <span className="round-icon purple">
                  <Bell size={19} />
                </span>
                이메일 알림
              </h2>
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={enabled}
                  onChange={(e) => setEnabled(e.target.checked)}
                />
                <span>
                  <strong>복용 완료가 미확인일 때 알림 받기</strong>
                  <small>예정된 시간이 지난 뒤에도 완료 체크가 없으면 알려드려요.</small>
                </span>
              </label>
              <label>
                예정 시간으로부터 알림까지 (분)
                <input
                  type="number"
                  min={5}
                  max={240}
                  required
                  value={delay}
                  onChange={(e) => setDelay(Number(e.target.value))}
                />
              </label>
              <div className="alert info">
                현재 알림 모드:{" "}
                <strong>{data.emailMode === "brevo" ? "Brevo 이메일 발송" : "로컬 보관함"}</strong>
                <br />
                {data.emailMode === "brevo"
                  ? "Brevo에 등록한 발신 주소를 통해 안내 메일을 전송합니다."
                  : "외부 이메일을 보내지 않고 알림 보관함에 발송 내용을 기록합니다."}
              </div>
              <Link className="text-link" href="/notifications">
                알림 보관함 확인 <ArrowRight size={16} />
              </Link>
            </section>
          </>
        ) : (
          <section className="card form-card">
            <h2>
              <span className="round-icon purple">
                <ShieldCheck size={19} />
              </span>
              함께하는 복용 확인
            </h2>
            <p className="section-description">
              본인 알림 이후에도 일정 시간 동안 복용 완료가 확인되지 않으면, 동의하신 보호자에게
              안내합니다.
            </p>
            <label>
              보호자 이메일
              <input
                type="email"
                value={gEmail}
                maxLength={254}
                onChange={(e) => {
                  setGEmail(e.target.value);
                  setConsent(false);
                }}
                placeholder="guardian@example.com"
                required={gEnabled}
              />
            </label>
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={gEnabled}
                onChange={(e) => setGEnabled(e.target.checked)}
              />
              <span>
                <strong>복용 미확인 시 보호자에게 알림 보내기</strong>
                <small>체크를 해제하면 추가 보호자 알림이 중단됩니다.</small>
              </span>
            </label>
            <label>
              본인 알림 후 추가 대기 시간 (분)
              <input
                type="number"
                min={5}
                max={1440}
                value={gDelay}
                required
                onChange={(e) => setGDelay(Number(e.target.value))}
              />
            </label>
            {gEnabled && (
              <label className="checkbox-label consent-box">
                <input
                  type="checkbox"
                  checked={consent}
                  required={gEnabled && (!data.guardianEnabled || gEmail !== data.guardianEmail)}
                  onChange={(e) => setConsent(e.target.checked)}
                />
                <span>
                  <strong>보호자 알림과 정보 제공에 동의합니다</strong>
                  <small>
                    입력한 이메일의 수신자에게 알림 수신 동의를 받았으며, 복용 완료가 미확인이라는
                    정보를 해당 이메일로 보내는 데 동의합니다. 새 등록·주소 변경 시 반드시 동의해
                    주세요.
                  </small>
                </span>
              </label>
            )}
            {data.guardianConsentedAt && (
              <p className="field-help">
                동의 기록:{" "}
                {new Date(data.guardianConsentedAt).toLocaleString("ko-KR", {
                  timeZone: "Asia/Seoul",
                })}
              </p>
            )}
            <Notice>
              보호자 메일에는 영양제 이름이나 상세 성분을 담지 않습니다. 본인 알림을 끄면 보호자
              알림도 발송되지 않습니다.
            </Notice>
          </section>
        )}
        <div className="form-actions">
          <Link href="/dashboard" className="button secondary">
            대시보드로
          </Link>
          <button className="button primary" disabled={busy}>
            {busy ? <LoaderCircle className="spin" size={17} /> : <Check size={17} />}설정 저장
          </button>
        </div>
      </form>
    </div>
  );
}

type Notification = {
  id: string;
  channel: string;
  status: string;
  recipient: string;
  subject: string;
  body: string;
  createdAt?: string;
  created_at?: string;
  error?: string;
};
function NotificationsPage() {
  const { data, error, loading, reload } = useResource<Notification[]>("/notifications");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState("");
  const [actionError, setActionError] = useState("");
  async function run() {
    setBusy(true);
    setResult("");
    setActionError("");
    try {
      await api("/notifications/preview", {});
      await reload();
      setResult(
        "현재 시간을 기준으로 미확인 일정을 점검했어요. 알림 조건을 충족한 항목이 아래에 기록됩니다.",
      );
    } catch (e) {
      setActionError(message(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <Heading
        eyebrow="NOTIFICATION CENTER"
        title="알림 보관함"
        subtitle="복용 확인 안내와 전송 상태를 확인하세요."
        action={
          <button className="button primary" disabled={busy} onClick={run}>
            {busy ? <LoaderCircle className="spin" size={17} /> : <Bell size={17} />}지금 미확인
            일정 점검
          </button>
        }
      />
      <Notice>
        정기 알림은 서버의 알림 작업자가 실행할 때 처리됩니다. 로컬 보관함 모드의 ‘보관됨’은 실제
        이메일 전송을 의미하지 않습니다.
      </Notice>
      <ErrorBox error={error || actionError} />
      {result && (
        <div className="alert success" role="status">
          {result}
        </div>
      )}
      {loading ? (
        <Spinner />
      ) : !data?.length ? (
        <section className="card empty">
          <span className="empty-icon">
            <Mail size={30} />
          </span>
          <h3>아직 보낸 알림이 없어요</h3>
          <p>
            예정 시간과 설정한 대기 시간이 지나면 안내를 준비해요.
            <br />
            설정에서 이메일 알림을 켰는지 확인해 주세요.
          </p>
          <Link className="button secondary" href="/settings">
            알림 설정 확인
          </Link>
        </section>
      ) : (
        <div className="notification-list">
          {data.map((n) => (
            <article className="card notification-card" key={n.id}>
              <div className="section-title">
                <span className="badge blue-badge">
                  {n.channel === "guardian" ? "보호자 안내" : "본인 안내"}
                </span>
                <span
                  className={`badge ${n.status === "failed" ? "amber-badge" : n.status === "sent" ? "green-badge" : ""}`}
                >
                  {(
                    {
                      captured: "로컬 보관됨",
                      sent: "전송 요청 접수",
                      failed: "전송 실패",
                      pending: "처리 중",
                      processing: "처리 중",
                      skipped: "조건 변경으로 생략",
                      sending: "전송 중",
                    } as Record<string, string>
                  )[n.status] || n.status}
                </span>
              </div>
              <h3>{n.subject}</h3>
              <p className="muted">받는 사람: {n.recipient}</p>
              <div className="mail-body">{n.body}</div>
              {n.error && <ErrorBox error={n.error} />}
              <span className="muted">
                {n.createdAt || n.created_at
                  ? new Date(n.createdAt || n.created_at || "").toLocaleString("ko-KR", {
                      timeZone: "Asia/Seoul",
                    })
                  : ""}
              </span>
            </article>
          ))}
        </div>
      )}
    </>
  );
}
