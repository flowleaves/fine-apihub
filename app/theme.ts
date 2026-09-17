// Claude 官网风格设计 token（Claude / Anthropic 视觉语言）
//
// 取色与排版依据（claude.ai 观感）：
//   · 底色是**暖白/象牙**，不是纯白；次级面用更深的暖灰米色分层
//   · 正文近黑而非纯黑（#1F1E1D），次级文字是**暖灰**（#6B6862）
//   · 强调色是**陶土橙 / 珊瑚**（#D97757 系），不用 Ant Design 蓝
//   · 边框极浅（#E5E3DC）、阴影极轻且带暖调、圆角偏大（10~14px）
//   · 标题用**衬线体**、正文用无衬线体；行高宽松
//
// 用法：只在 app/providers.tsx 里消费，页面里请用 antd 组件 + `--cl-*` CSS 变量，
// 不要再硬编码颜色（深浅色切换要靠这里统一收口）。

export type Mode = "light" | "dark";

// 两端共用的量（与配色无关）
export const shape = {
  radius: 12,
  radiusSm: 8,
  radiusLg: 16,
  fontSans:
    '"Styrene B", "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Helvetica Neue", Arial, sans-serif',
  fontSerif:
    '"Tiempos Text", "Copernicus", Georgia, "Songti SC", "Noto Serif CJK SC", "Source Han Serif SC", "Times New Roman", serif',
};

export const palette = {
  light: {
    // 背景分层：页面底 → 卡片 → 悬浮
    bgLayout: "#FAF9F5",
    bgContainer: "#FFFFFF",
    bgElevated: "#F5F3EC",
    bgSubtle: "#F0EEE6",
    // 文字
    text: "#1F1E1D",
    textSecondary: "#6B6862",
    textTertiary: "#8C8880",
    // 线
    border: "#E5E3DC",
    borderStrong: "#D6D2C7",
    // 强调（陶土橙）
    primary: "#D97757",
    primaryHover: "#C96442",
    primaryActive: "#B4532F",
    primarySoft: "#F7EDE7",
    // 语义色（低饱和，克制）
    success: "#4F7A54",
    warning: "#B07A2B",
    error: "#B4453A",
    // 阴影：暖调、极轻
    shadow:
      "0 1px 2px rgba(31,30,29,0.04), 0 6px 20px -8px rgba(31,30,29,0.10)",
    shadowLg:
      "0 2px 6px rgba(31,30,29,0.05), 0 18px 44px -18px rgba(31,30,29,0.16)",
  },
  dark: {
    bgLayout: "#1F1E1D",
    bgContainer: "#262624",
    bgElevated: "#2D2C29",
    bgSubtle: "#33322E",
    text: "#EFEDE7",
    textSecondary: "#A8A49B",
    textTertiary: "#8C8880",
    border: "#3A3936",
    borderStrong: "#4A4844",
    primary: "#E08A6B",
    primaryHover: "#EBA088",
    primaryActive: "#F0B49F",
    primarySoft: "#3A2E28",
    success: "#7FA985",
    warning: "#D9A85C",
    error: "#E0887C",
    shadow: "0 1px 2px rgba(0,0,0,0.30), 0 6px 20px -8px rgba(0,0,0,0.45)",
    shadowLg: "0 2px 6px rgba(0,0,0,0.35), 0 18px 44px -18px rgba(0,0,0,0.60)",
  },
} as const;

/** 生成挂到 :root 的 CSS 变量（供自定义样式用；深浅色切换时整套替换）。 */
export function cssVars(mode: Mode) {
  const c = palette[mode];
  return {
    "--cl-bg-layout": c.bgLayout,
    "--cl-bg-container": c.bgContainer,
    "--cl-bg-elevated": c.bgElevated,
    "--cl-bg-subtle": c.bgSubtle,
    "--cl-text": c.text,
    "--cl-text-secondary": c.textSecondary,
    "--cl-text-tertiary": c.textTertiary,
    "--cl-border": c.border,
    "--cl-border-strong": c.borderStrong,
    "--cl-primary": c.primary,
    "--cl-primary-hover": c.primaryHover,
    "--cl-primary-soft": c.primarySoft,
    "--cl-success": c.success,
    "--cl-warning": c.warning,
    "--cl-error": c.error,
    "--cl-shadow": c.shadow,
    "--cl-shadow-lg": c.shadowLg,
    "--cl-radius": `${shape.radius}px`,
    "--cl-radius-sm": `${shape.radiusSm}px`,
    "--cl-radius-lg": `${shape.radiusLg}px`,
    "--cl-font-sans": shape.fontSans,
    "--cl-font-serif": shape.fontSerif,
  } as Record<string, string>;
}

/** 映射到 antd v6 ConfigProvider 的 token（组件级微调见 components）。 */
export function antdTheme(mode: Mode) {
  const c = palette[mode];
  return {
    token: {
      colorPrimary: c.primary,
      colorInfo: c.primary,
      colorSuccess: c.success,
      colorWarning: c.warning,
      colorError: c.error,
      colorTextBase: c.text,
      colorText: c.text,
      colorTextSecondary: c.textSecondary,
      colorTextTertiary: c.textTertiary,
      colorBgBase: c.bgContainer,
      colorBgLayout: c.bgLayout,
      colorBgContainer: c.bgContainer,
      colorBgElevated: c.bgContainer,
      colorFillQuaternary: c.bgSubtle,
      colorBorder: c.border,
      colorBorderSecondary: c.border,
      borderRadius: shape.radius,
      borderRadiusLG: shape.radiusLg,
      borderRadiusSM: shape.radiusSm,
      fontFamily: shape.fontSans,
      fontSize: 14,
      lineHeight: 1.65,
      controlHeight: 36,
      boxShadow: c.shadow,
      boxShadowSecondary: c.shadowLg,
      wireframe: false,
    },
    components: {
      // 卡片：去边框靠阴影分层，圆角更大（Claude 的卡片感）
      Card: { borderRadiusLG: shape.radiusLg, paddingLG: 20, headerFontSize: 15 },
      // 按钮：主按钮陶土橙、次级为浅底，圆角 10
      Button: { borderRadius: 10, controlHeight: 36, primaryShadow: "none", defaultShadow: "none", fontWeight: 500 },
      // 表格：表头用暖灰底、无竖线
      Table: { headerBg: c.bgSubtle, headerColor: c.textSecondary, borderColor: c.border, headerSplitColor: "transparent", rowHoverBg: c.bgSubtle },
      // 输入类
      Input: { borderRadius: 10, paddingBlock: 6 },
      Select: { borderRadius: 10 },
      Segmented: { borderRadius: 10, itemSelectedBg: c.bgContainer, trackBg: c.bgSubtle },
      Tabs: { itemSelectedColor: c.primary, inkBarColor: c.primary, horizontalItemPadding: "10px 0" },
      Tag: { borderRadiusSM: 999, defaultBg: c.bgSubtle, defaultColor: c.textSecondary },
      Statistic: { titleFontSize: 12.5, contentFontSize: 26 },
      Modal: { borderRadiusLG: shape.radiusLg, paddingContentHorizontalLG: 24 },
      Tooltip: { borderRadius: 8, colorBgSpotlight: mode === "dark" ? "#0F0F0E" : "#2B2A28" },
      Empty: { colorTextDescription: c.textTertiary },
    },
  } as const;
}
