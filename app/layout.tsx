import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = {
  title: "하루영양 · 매일의 작은 건강 습관",
  description:
    "내 영양제, 복용 일정, 성분 중복을 한곳에서 관리하세요. 의학적 진단이나 치료를 제공하지 않습니다.",
  icons: { icon: "/icon.svg" },
  robots: { index: false, follow: false },
};
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}
