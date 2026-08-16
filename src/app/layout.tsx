import type { Metadata, Viewport } from "next";
import Link from "next/link";
import { Orbit } from "lucide-react";
import { GlobalNav } from "@/components/global-nav";
import "./globals.css";

export const metadata: Metadata = {
  title: "NovaPilot · 科研决策工作台",
  description: "有据才答，该转就转的科研客户技术支持智能体",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#f2efe7",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>
        <div className="app-frame">
          <header className="topbar">
            <Link className="brand" href="/" aria-label="NovaPilot 首页">
              <span className="brand-mark"><Orbit size={20} strokeWidth={1.7} aria-hidden="true" /></span>
              <span>
                <strong>NovaPilot</strong>
                <small>RESEARCH DECISION OS</small>
              </span>
            </Link>
            <GlobalNav />
            <div className="system-signal">
              <span className="signal-dot" aria-hidden="true" />
              可信 MVP · 影子环境
            </div>
          </header>
          {children}
        </div>
      </body>
    </html>
  );
}
