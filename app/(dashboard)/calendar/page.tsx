"use client";
// 月历消耗页：一个月里每天花了多少（上游权威口径）+ 今天的实时消耗
// 数据来源 GET /api/calendar（日粒度来自上游用量接口；超出上游保留期的日期留空并标注）
import { useCallback, useEffect, useMemo, useState } from "react";
import { PageContainer } from "@ant-design/pro-components";
import { Button, Segmented, Skeleton, Space, Tag, Tooltip, Typography, theme } from "antd";
import { LeftOutlined, ReloadOutlined, RightOutlined } from "@ant-design/icons";
import { api, cny, usd } from "../../../lib/client";

const { Text } = Typography;

type DayCell = { date: string; usd: number; cny: number; tokens: number; requests: number };
type StationCal = {
  id: string; name: string; type: string; cnyPerUsd: number | null;
  ok: boolean; available?: boolean; reason?: string | null; error?: string;
  source?: string | null; coverageFrom?: string | null;
  totalUsd: number; totalCny: number; todayUsd: number;
  days: DayCell[]; hours: { t: number; usd: number }[];
};
type CalPayload = {
  month: string; tz: string; calendarDays: string[]; todayLabel: string;
  daily: DayCell[]; hours: { t: number; usd: number }[];
  today: DayCell | null; stations: StationCal[];
  coverageFrom: string | null; notes: string[]; generatedAt: string;
};

const DOW = ["日", "一", "二", "三", "四", "五", "六"];

const money = (v: number) => `$${Number(v || 0).toFixed(2)}`;

// "2026-09" 的前后月
function shiftMonth(month: string, delta: number) {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

export default function CalendarPage() {
  const { token } = theme.useToken();
  const [month, setMonth] = useState(() => {
    const n = new Date();
    return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, "0")}`;
  });
  const [data, setData] = useState<CalPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [metric, setMetric] = useState<"usd" | "cny">("usd");
  const [picked, setPicked] = useState<string | null>(null);
  const [tz] = useState(() => Intl.DateTimeFormat().resolvedOptions().timeZone);

  const load = useCallback(async (m: string) => {
    setLoading(true);
    setErr(null);
    try {
      const r = await api(`/api/calendar?month=${m}&tz=${encodeURIComponent(tz)}`);
      setData(r);
      setPicked(null);
    } catch (e: any) {
      setErr(e?.message || String(e));
    } finally {
      setLoading(false);
    }
  }, [tz]);

  useEffect(() => { load(month); }, [month, load]);

  // 用「该月全部日期 + 有数据的日」铺格子；已知日期 → 花费，未知 → null（区别于 0）
  const byDate = useMemo(() => {
    const m = new Map<string, DayCell>();
    for (const d of data?.daily || []) m.set(d.date, d);
    return m;
  }, [data]);

  const maxUsd = useMemo(
    () => Math.max(1e-9, ...[...(data?.daily || [])].map((d) => d.usd)),
    [data]
  );

  const monthTotal = useMemo(
    () => (data?.daily || []).reduce((a, d) => a + d.usd, 0),
    [data]
  );
  const monthDays = data?.daily?.length || 0;

  const cells = useMemo(() => {
    const days = data?.calendarDays || [];
    if (!days.length) return [] as (string | null)[];
    const first = new Date(`${days[0]}T00:00:00Z`);
    const pad = first.getUTCDay(); // 该月 1 日是周几 → 前置空格
    return [...Array(pad).fill(null), ...days] as (string | null)[];
  }, [data]);

  const pickedStations = useMemo(() => {
    if (!picked || !data) return [];
    return data.stations
      .filter((s) => s.ok)
      .map((s) => ({ s, d: s.days.find((x) => x.date === picked) }))
      .filter((x) => x.d)
      .sort((a, b) => (b.d!.usd - a.d!.usd));
  }, [picked, data]);

  const hourMax = Math.max(1e-9, ...(data?.hours || []).map((h) => h.usd));

  return (
    <PageContainer
      header={{ title: null, breadcrumb: {} }}
      title={false}
      style={{ paddingInline: 0 }}
    >
      {/* ---- 页头：Claude 风大标题 + 月份切换 ---- */}
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "flex-end", gap: 16, marginBottom: 20 }}>
        <div style={{ flex: "1 1 320px", minWidth: 0 }}>
          <div className="cl-eyebrow">消耗月历</div>
          <div className="cl-display cl-display-xl" style={{ marginTop: 4 }}>每日消耗</div>
          <Text type="secondary" style={{ fontSize: 13 }}>
            按日汇总各站点实际扣费（上游用量接口口径）· 时区 {tz}
          </Text>
        </div>
        <Space>
          <Button icon={<LeftOutlined />} onClick={() => setMonth((m) => shiftMonth(m, -1))} />
          <div className="cl-display cl-display-md cl-num" style={{ minWidth: 118, textAlign: "center" }}>{data?.month || month}</div>
          <Button
            icon={<RightOutlined />}
            disabled={data ? data.month >= `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, "0")}` : false}
            onClick={() => setMonth((m) => shiftMonth(m, 1))}
          />
          <Button icon={<ReloadOutlined />} loading={loading} onClick={() => load(month)} />
        </Space>
      </div>

      {err && (
        <div className="cl-card" style={{ borderColor: token.colorError, marginBottom: 16 }}>
          <Text type="danger">加载失败：{err}</Text>
        </div>
      )}

      {/* ---- 顶部三个数：本月合计 / 今日实时 / 覆盖范围 ---- */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12, marginBottom: 16 }}>
        <div className="cl-card">
          <div className="cl-eyebrow">本月合计（已返回 {monthDays} 天）</div>
          <div className="cl-display cl-display-lg cl-num" style={{ marginTop: 6 }}>{money(monthTotal)}</div>
          <Text type="secondary" style={{ fontSize: 12 }}>
            日均 {monthDays ? money(monthTotal / monthDays) : "—"}
          </Text>
        </div>
        <div className="cl-card">
          <div className="cl-eyebrow">今日实时消耗</div>
          <div className="cl-display cl-display-lg cl-num" style={{ marginTop: 6, color: "var(--cl-primary)" }}>
            {money(data?.today?.usd || 0)}
          </div>
          <Text type="secondary" style={{ fontSize: 12 }}>
            {data?.today ? `${(data.today.tokens || 0).toLocaleString("en-US")} tokens · ${(data.today.requests || 0).toLocaleString("en-US")} 次请求` : "今日暂无数据"}
          </Text>
        </div>
        <div className="cl-card">
          <div className="cl-eyebrow">口径与覆盖</div>
          <div style={{ marginTop: 8, fontSize: 12.5, color: "var(--cl-text-secondary)", lineHeight: 1.7 }}>
            最早可查 <b className="cl-num">{data?.coverageFrom || "—"}</b>
            <br />
            上游保留期有限，更早日期<b>留空</b>而非记 0
          </div>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1.6fr) minmax(0, 1fr)", gap: 16, alignItems: "start" }}>
        {/* ---- 月历 ---- */}
        <div className="cl-card">
          {loading && !data ? (
            <Skeleton active paragraph={{ rows: 8 }} />
          ) : (
            <>
              <div className="cl-cal" style={{ marginBottom: 6 }}>
                {DOW.map((d) => <div key={d} className="cl-cal__dow">{d}</div>)}
              </div>
              <div className="cl-cal">
                {cells.map((date, i) => {
                  if (!date) return <div key={`p${i}`} className="cl-cal__cell cl-cal__cell--pad" />;
                  const rec = byDate.get(date);
                  const isToday = date === data?.todayLabel;
                  const isFuture = data ? date > data.todayLabel : false;
                  const ratio = rec ? rec.usd / maxUsd : 0;
                  return (
                    <div
                      key={date}
                      className={[
                        "cl-cal__cell",
                        isToday ? "cl-cal__cell--today" : "",
                        rec ? "cl-cal__cell--clickable" : "",
                      ].join(" ")}
                      onClick={() => rec && setPicked(date === picked ? null : date)}
                      title={rec ? `${date}\n$${rec.usd.toFixed(2)} · ${rec.tokens.toLocaleString("en-US")} tokens · ${rec.requests} 次` : `${date}（无数据）`}
                    >
                      {/* 热度底：色深 ∝ 当天花费 */}
                      <div className="cl-cal__heat" style={{ opacity: rec ? Math.min(0.14, ratio * 0.14) : 0 }} />
                      <div className="cl-cal__date">{Number(date.slice(8, 10))}</div>
                      {rec ? (
                        <>
                          <div className="cl-cal__cost cl-num">{money(rec.usd)}</div>
                          <div className="cl-cal__meta cl-num">{rec.requests} 次</div>
                        </>
                      ) : (
                        <div className="cl-cal__cost cl-cal__cost--zero">{isFuture ? "" : "—"}</div>
                      )}
                    </div>
                  );
                })}
              </div>
              {picked && (
                <div style={{ marginTop: 16 }}>
                  <hr className="cl-divider" />
                  <div className="cl-eyebrow" style={{ marginBottom: 8 }}>{picked} · 分站明细</div>
                  {pickedStations.length ? (
                    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                      {pickedStations.map(({ s, d }) => (
                        <div key={s.id} style={{ display: "flex", justifyContent: "space-between", gap: 12, fontSize: 13 }}>
                          <span>
                            {s.name}{" "}
                            <Tag style={{ marginLeft: 4 }}>{s.type}</Tag>
                          </span>
                          <span className="cl-num" style={{ fontWeight: 600 }}>{money(d!.usd)}</span>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <Text type="secondary" style={{ fontSize: 12.5 }}>该日上游无返回数据</Text>
                  )}
                </div>
              )}
            </>
          )}
        </div>

        {/* ---- 今日逐小时 + 站点拆分 ---- */}
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <div className="cl-card">
            <div className="cl-eyebrow">今日逐小时（实时）</div>
            <div className="cl-display cl-display-md cl-num" style={{ margin: "6px 0 2px" }}>
              {money(data?.today?.usd || 0)}
            </div>
            <Text type="secondary" style={{ fontSize: 12 }}>
              {data?.hours?.length ? `已记录 ${data.hours.length} 个小时点` : "今天还没有小时数据"}
            </Text>
            <div className="cl-bars" style={{ marginTop: 14 }}>
              {Array.from({ length: 24 }, (_, h) => {
                const hit = (data?.hours || []).filter((x) => new Date(x.t).getHours() === h);
                const v = hit.reduce((a, x) => a + x.usd, 0);
                const pct = Math.max(2, (v / hourMax) * 100);
                return (
                  <Tooltip key={h} title={`${h}:00 · ${money(v)}`}>
                    <div
                      className={`cl-bars__bar${v > 0 ? "" : " cl-bars__bar--empty"}`}
                      style={{ height: v > 0 ? `${pct}%` : "3px" }}
                    />
                  </Tooltip>
                );
              })}
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", marginTop: 6 }}>
              <span className="cl-faint" style={{ fontSize: 10.5 }}>00:00</span>
              <span className="cl-faint" style={{ fontSize: 10.5 }}>12:00</span>
              <span className="cl-faint" style={{ fontSize: 10.5 }}>23:00</span>
            </div>
          </div>

          <div className="cl-card">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
              <span className="cl-eyebrow">本月分站</span>
              <Segmented
                size="small"
                value={metric}
                onChange={(v) => setMetric(v as "usd" | "cny")}
                options={[{ label: "$", value: "usd" }, { label: "¥", value: "cny" }]}
              />
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {(data?.stations || []).map((s) => (
                <div key={s.id}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 10, fontSize: 13 }}>
                    <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {s.name}
                    </span>
                    <span className="cl-num" style={{ fontWeight: 600, whiteSpace: "nowrap" }}>
                      {s.ok && s.available ? (metric === "usd" ? money(s.totalUsd) : cny(s.totalCny)) : "—"}
                    </span>
                  </div>
                  {!(s.ok && s.available) && (
                    <Text type="secondary" style={{ fontSize: 11.5 }}>
                      {s.error || s.reason || "不可用"}
                    </Text>
                  )}
                  {s.ok && s.available && s.coverageFrom && (
                    <div className="cl-faint" style={{ fontSize: 11 }}>
                      可查自 {s.coverageFrom}
                    </div>
                  )}
                </div>
              ))}
              {!data?.stations?.length && <Text type="secondary" style={{ fontSize: 12.5 }}>没有可统计的站点</Text>}
            </div>
          </div>

          {data?.notes?.length ? (
            <div className="cl-card cl-card--pad-sm">
              <div className="cl-eyebrow" style={{ marginBottom: 6 }}>说明</div>
              {data.notes.map((n, i) => (
                <div key={i} style={{ fontSize: 11.5, color: "var(--cl-text-tertiary)", lineHeight: 1.7 }}>· {n}</div>
              ))}
            </div>
          ) : null}
        </div>
      </div>
    </PageContainer>
  );
}
