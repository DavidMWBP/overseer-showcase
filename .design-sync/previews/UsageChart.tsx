import { UsageChart } from '@overseer/web';

const models = ['claude-opus-5-5', 'gpt-5.6-terra', 'claude-sonnet-5', 'deepseek-v4-pro'];
// Deterministic per-day values, so the card is the same on every render.
const wave = (i: number, m: number) => Math.max(0, Math.round((Math.sin(i * 0.9 + m * 1.7) + 1) * (4 - m) * 100) / 100);
const days = (n: number, scale: number) => Array.from({ length: n }, (_, i) => {
  const day = new Date(Date.UTC(2026, 8, 24 - (n - 1 - i))).toISOString().slice(0, 10);
  const segments = models.map((key, m) => ({ key, value: wave(i, m) * scale, codex: key.startsWith('gpt') })).filter((s) => s.value > 0);
  return { day, total: segments.reduce((t, s) => t + s.value, 0), segments };
});
const stacks = (n: number, scale: number) => { const d = days(n, scale); return { series: models, days: d, max: Math.max(...d.map((x) => x.total)) }; };

export const CostThirtyDays = () => <div style={{ background: "var(--bg)", padding: 16, borderRadius: 6 }}><UsageChart stacks={stacks(30, 1)} measure="reported" label="Reported cost per day by model, last 30 days" /></div>;

export const TokensSevenDays = () => <div style={{ background: "var(--bg)", padding: 16, borderRadius: 6 }}><UsageChart stacks={stacks(7, 180_000)} measure="tokens" label="Tokens per day by model, last 7 days" /></div>;
