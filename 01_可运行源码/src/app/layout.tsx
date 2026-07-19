import type { Metadata } from "next";
import Link from "next/link";
import { Activity, BrainCircuit, FlaskConical, Headset, Orbit } from "lucide-react";
import "./globals.css";

export const metadata: Metadata = {
  title: "NovaPilot · 科研决策工作台",
  description: "有据才答，该转就转的科研客户技术支持智能体",
};

const navItems = [
  { href: "/", label: "科研咨询", icon: FlaskConical },
  { href: "/expert", label: "专家工作台", icon: Headset },
  { href: "/knowledge", label: "知识进化", icon: BrainCircuit },
  { href: "/operations", label: "运营评测", icon: Activity },
];

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>
        <div className="app-frame">
          <header className="topbar">
            <Link className="brand" href="/" aria-label="NovaPilot 首页">
              <span className="brand-mark"><Orbit size={20} strokeWidth={1.7} /></span>
              <span>
                <strong>NovaPilot</strong>
                <small>RESEARCH DECISION OS</small>
              </span>
            </Link>
            <nav className="global-nav" aria-label="主导航">
              {navItems.map(({ href, label, icon: Icon }) => (
                <Link href={href} key={href}>
                  <Icon size={15} />
                  {label}
                </Link>
              ))}
            </nav>
            <div className="system-signal">
              <span className="signal-dot" />
              可信 MVP · 影子环境
            </div>
          </header>
          {children}
        </div>
      </body>
    </html>
  );
}
