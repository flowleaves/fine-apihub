"use client";
// 全局 Provider：Claude 风设计 token（深浅色）+ PWA SW 注册
// 主题键沿用 v1 的 localStorage "app-shell-theme"（向后兼容，老用户偏好不丢）
import { createContext, useContext, useEffect, useState } from "react";
import { ConfigProvider, App, theme as antdTheme } from "antd";
import zhCN from "antd/locale/zh_CN";
import { antdTheme as buildTheme, cssVars, type Mode } from "./theme";

const ThemeCtx = createContext<{ dark: boolean; mode: Mode; toggle: () => void }>({
  dark: false,
  mode: "light",
  toggle: () => {},
});

export const useThemeMode = () => useContext(ThemeCtx);

export default function Providers({ children }: { children: React.ReactNode }) {
  const [dark, setDark] = useState(false);
  const mode: Mode = dark ? "dark" : "light";

  useEffect(() => {
    const saved = localStorage.getItem("app-shell-theme");
    if (saved === "dark") setDark(true);
    else if (!saved && window.matchMedia?.("(prefers-color-scheme: dark)").matches) setDark(true);
    if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
  }, []);

  // 把设计变量写到 :root —— 自定义样式（月历、卡片等）只依赖 --cl-* 变量，
  // 这样深浅色切换不需要改任何组件代码。
  useEffect(() => {
    const vars = cssVars(mode);
    for (const [k, v] of Object.entries(vars)) document.documentElement.style.setProperty(k, v);
    document.documentElement.dataset.theme = mode;
    document.documentElement.style.colorScheme = mode;
  }, [mode]);

  const toggle = () =>
    setDark((d) => {
      const next = !d;
      localStorage.setItem("app-shell-theme", next ? "dark" : "light");
      return next;
    });

  return (
    <ThemeCtx.Provider value={{ dark, mode, toggle }}>
      <ConfigProvider
        locale={zhCN}
        theme={{
          algorithm: dark ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
          ...buildTheme(mode),
        }}
      >
        <App>{children}</App>
      </ConfigProvider>
    </ThemeCtx.Provider>
  );
}
