"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Activity, BrainCircuit, FlaskConical, Headset } from "lucide-react";

const navItems = [
  { href: "/", label: "科研咨询", icon: FlaskConical },
  { href: "/expert", label: "专家工作台", icon: Headset },
  { href: "/knowledge", label: "知识进化", icon: BrainCircuit },
  { href: "/operations", label: "运营评测", icon: Activity },
];

/** 顶栏主导航:客户端组件,高亮当前页面(aria-current + 墨色下划线)。 */
export function GlobalNav() {
  const pathname = usePathname();
  return (
    <nav className="global-nav" aria-label="主导航">
      {navItems.map(({ href, label, icon: Icon }) => {
        const current =
          href === "/" ? pathname === "/" : pathname.startsWith(href);
        return (
          <Link href={href} key={href} aria-current={current ? "page" : undefined}>
            <Icon size={15} aria-hidden="true" />
            {label}
          </Link>
        );
      })}
    </nav>
  );
}
