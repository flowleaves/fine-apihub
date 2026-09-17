# 预测模型

> 消费预测的实现细节：四模型等权组合 + 逐视界 conformal 经验区间。修改模型前必须附回测数据。

## 1. 问题背景

fine 需要预测中转站未来的消费金额，以支持：
- **耗尽预警**（ETA）：按当前速率余额还能撑多久
- **经营规划**：未来 7 天的预计消费区间，辅助采购决策

### 数据特点

- **日级**：每天一个消费总额（美元），样本量通常 30~60 天
- **小时级**：每小时一个消费额，样本量 24×N（N 为天数）
- **高方差**：AI API 消费受用户行为、促销活动、模型切换影响，单日波动可达数倍
- **趋势变化**：新模型上线、价格调整会导致消费结构突变
- **尖峰日**：某几天消费可能远高于平时（如批量任务），简单均值会被严重拉偏

## 2. 模型选型历程

### 回测数据（v1.15.0，60 天真实数据，1439 小时点）

| 模型 | 1 天 WAPE | 7 天 WAPE | 震荡段表现 | 结论 |
|------|----------|----------|-----------|------|
| 单模型对数阻尼 Holt | 最优 | 中等 | **崩坏**（早期段 WAPE 92%） | 淘汰 |
| 四模型等权组合 | 58% | 70% | 稳定 | **冠军** |
| 岭回归 + 星期因子 | 略优 | 落后 | 过拟合（几十个日样本） | 淘汰 |
| GBDT | 略优 | 落后 | 过拟合 | 淘汰 |
| 旧 48h 等权回归 | 62% | 82% | 稀释趋势 | 淘汰 |

**关键发现**：
- 单模型在趋势段最优，但在震荡段（消费无规律波动）崩坏
- ML 方法（ridge/GBDT）在几十个日样本上过拟合，全面落后
- **四模型等权组合**在全部时间段稳定，不依赖单一假设

## 3. 基模型

### 3.1 对数空间阻尼 Holt（乘性噪声 + 阻尼趋势）

```
level_t = α · log(v_t + 1) + (1-α) · (level_{t-1} + φ · trend_{t-1})
trend_t = β · (level_t - level_{t-1}) + (1-β) · φ · trend_{t-1}
forecast_k = exp(level_T + Σ(φ^i) · trend_T) - 1
```

- **默认参数**：α=0.5, β=0.1, φ=0.9
- **特点**：对数空间抑制尖峰，阻尼因子防止趋势无限外推
- **适用**：有明显趋势的消费数据

### 3.2 对数空间 Theta（SES 水平 + 半强度整体趋势）

```
线性回归斜率 b（对数空间）
水平 level = 0.4·lv_t + 0.6·level_{t-1}（指数平滑）
forecast_k = exp(level + 0.5·b·k) - 1
```

- **特点**：比 Holt 更保守，趋势强度减半
- **适用**：弱趋势、有噪声的数据

### 3.3 EWMA 水平平推

```
α = 1 - 0.5^(1/10)   // 半衰期 10 天
level_t = α·v_t + (1-α)·level_{t-1}
forecast_k = level_T
```

- **特点**：无趋势假设，纯指数平滑
- **适用**：无趋势或趋势不明的数据

### 3.4 近 7 天中位数平推

```
forecast_k = median(v_{T-6}, ..., v_T)
```

- **特点**：完全非参数，对尖峰日免疫
- **适用**：高方差、有异常值的数据

## 4. 冠军模型：四模型等权组合

```javascript
function ens4(vals, ts, h) {
  const ps = [
    logHolt(vals, ts, h),
    thetaLog(vals, ts, h),
    med7Flat(vals, ts, h),
    ewmaFlat(vals, ts, h),
  ];
  return ps[0].map((_, i) => (ps[0][i] + ps[1][i] + ps[2][i] + ps[3][i]) / 4);
}
```

**设计意图**：
- Holt 跟得上趋势 → 趋势段不落后
- Theta 比 Holt 保守 → 防止趋势过冲
- 中位数 + EWMA → 震荡段拖不垮
- **等权**：避免回测过拟合，简化超参

### 挑战者机制

当数据量 ≥ 14 天时，内部回测评估两个挑战者：
- `reg-dow`：加权回归 + 星期因子
- `ewma-dow`：EWMA 水平 × 收缩星期因子

**切换门槛**：挑战者需在内部回测中领先冠军 **20%** 才切换。历史证明周律弱时有害，所以门槛设得很高。

```javascript
// 内部回测评分：混合 1 天 + 3 天累计的加权绝对百分比误差
function backtestScore(fn, vals, ts) {
  // 对最近 14 天的每个原点，预测未来 3 天，与实际值比较
  // score = WAPE(1天) + WAPE(3天累计)
}
```

## 5. 区间估计：逐视界 conformal 校准

### 问题

点预测不够，需要给出「未来 7 天消费在 X~Y 之间」的区间。

### 旧方法的问题

「1 天比值分位 × √k 加宽」：
- 逐日覆盖 62%
- 区间宽度 2.76× 实际值（太宽，失去指导意义）

### 新方法：逐视界 conformal

**核心思想**：对最近 `maxOrigins` 个历史原点重放被选预测方法，收集各视界 k 的「实际/预测」比值分位。

```
对每个历史原点 i（从 start 到 n-1）：
  用前 i 天数据预测未来 h 天
  对每视界 k：
    如果预测值 > 0.01：
      记录 ratio = 实际值 / 预测值
  如果 i + h ≤ n：
    记录 sumRatio = sum(实际) / sum(预测)

分位：
  perK[k].lo = quantile(ratios, 0.1)  // 10% 分位
  perK[k].hi = quantile(ratios, 0.9)  // 90% 分位
  tot.lo = quantile(sumRatios, 0.1)
  tot.hi = quantile(sumRatios, 0.9)
```

**参数**：
- 名义覆盖 80%（10/90 分位）
- `maxOrigins = 28`（最近 28 个原点）
- 某视界样本 < 8 时，借全部视界的样本（提高稳定性）

### 回测结果

| 指标 | 旧方法 | 逐视界 conformal |
|------|--------|-----------------|
| 逐日覆盖 | 62% | 71% |
| 区间宽度 | 2.76× | 2.01× |
| 7 日合计覆盖 | 42% | 52% |
| 7 日合计宽度 | 1.74× | **1.30×** |

**7 日合计区间单独校准**：多日求和平均掉单日噪声，比逐日区间窄得多。

### 兜底策略

样本不足（< 8 天）时：
```
lo = max(0, p * (1 - 0.4 * widen))
hi = p * (1 + 0.4 * widen)
widen = min(sqrt(k+1), 1.8)  // 随距离温和加宽
```

## 6. 小时级预测

### 问题

日级预测太粗，需要预测未来 24 小时的逐小时消费。

### 方法

**形状 × 总量分离**：

1. **形状**：近 14 天递归加权小时画像（半衰期 3 天）
   ```
   对每个小时桶 h（0~23）：
     wsum[h] = Σ w_i · indicator(hour_i == h)
     vsum[h] = Σ w_i · v_i · indicator(hour_i == h)
     profile[h] = vsum[h] / wsum[h]
   w_i = 0.5^((lastT - t_i) / 86400000 / 3)  // 半衰期 3 天
   ```

2. **总量**：近 5 个滚动日总量的中位数（尖峰日免疫）
   ```
   dayTotals[d] = sum(v_{T-d·24}, ..., v_{T-(d-1)·24})
   total = median(dayTotals)
   ```

3. **合成**：
   ```
   forecast_k = profile[h_k] / sum(profile) * total
   ```

### conformal 校准

```
大预测值（> 0.5）：乘性区间  [p * rLo, p * rHi]
小预测值（≤ 0.5）：加性区间  [p + aLo, p + aHi]
```

**分桶原因**：小时级消费可能为 0 或接近 0，乘性区间会坍缩到 0，加性区间更合理。

### 回测结果

| 指标 | 旧方法 | 新方法 |
|------|--------|--------|
| 24h 总量 WAPE | 70% | **60%** |
| 逐小时 WAPE | 高 | 低 3~13 个百分点 |
| 区间宽度 | 2.60× | **1.55×** |

## 7. 接口

### `forecastDaily(daily, horizon = 7)`

**输入**：
```typescript
daily: { t: number, cost: number }[]  // 升序，缺日补 0，不含今天
horizon: number                        // 预测天数，默认 7
```

**输出**：
```typescript
{
  points: { t: number, cost: number, lo: number, hi: number }[],
  nextTotal: number,      // 未来 horizon 天合计
  nextLo: number,         // 合计区间下限
  nextHi: number,         // 合计区间上限
  method: string,         // "四模型组合" | "加权回归 + 星期因子" | "均线 + 星期因子"
  sampleDays: number,     // 用于预测的历史天数
  backtestWapePct: number | null,  // 内部回测 1 天 WAPE（%）
}
```

### `forecastHourly(points, hodOf, horizon = 24)`

**输入**：
```typescript
points: { t: number, cost: number }[]  // 升序，缺时补 0，不含当前未完小时
hodOf: (ms: number) => number          // 时区感知的"当地钟点"函数，返回 0~23
horizon: number                         // 预测小时数，默认 24
```

**输出**：
```typescript
{
  points: { t: number, cost: number, lo: number, hi: number }[],
  next24Total: number,      // 未来 24 小时合计
  backtestWapePct: number | null,
}
```

## 8. 修改指南

### 换模型门槛

1. 用 60 天真实数据做滚动回测
2. 新模型必须在 **1 天 WAPE** 和 **7 天 WAPE** 上同时优于四模型组合
3. 震荡段（前 30 天无趋势）不能崩坏
4. 附上回测脚本和结果

### 调参

- `logHolt` 的 α/β/φ：可在 `lib/forecast.js` 中修改，但建议保持默认（回测选定）
- `dailyConformal` 的 `maxOrigins`：增大提高稳定性，减小提高对新变化的敏感度
- `hourlyPredict` 的半衰期：3 天是当前最优，可尝试 2~5 天

### 新增基模型

1. 在 `lib/forecast.js` 中新增函数，签名：`function newModel(vals, ts, h)`
2. 返回数组长度必须等于 `h`
3. 在 `ens4` 中加入该模型，权重可调整（需回测验证）
4. 更新 `METHOD_LABEL` 字典
