// Thin uPlot wrapper: one chart per mount, data swapped in place (no re-create per tick).
import { useEffect, useRef } from "react";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";

export interface ChartSeries { label: string; stroke: string; dash?: number[] }

export function Chart({ data, series, height = 120, yRange, title, compact = false }: {
  data: (number | null)[][]; series: ChartSeries[]; height?: number; yRange?: [number, number]; title?: string; compact?: boolean;
}) {
  const el = useRef<HTMLDivElement>(null);
  const plot = useRef<uPlot | null>(null);
  const key = series.map((s) => s.label).join("|");
  useEffect(() => {
    if (!el.current) return;
    const width = Math.max(200, el.current.clientWidth || 400);
    const opts: uPlot.Options = {
      width, height, title,
      legend: { show: series.length > 1 },
      scales: { x: { time: false }, y: yRange ? { range: yRange } : {} },
      axes: compact ? [{ show: false }, { show: false }]
        : [{ stroke: "#8a93a3", grid: { stroke: "#262b36" } }, { stroke: "#8a93a3", grid: { stroke: "#262b36" }, size: 50 }],
      cursor: compact ? { show: false } : undefined,
      series: [{ label: "sim s" }, ...series.map((s) => ({ label: s.label, stroke: s.stroke, dash: s.dash, width: 1.5, spanGaps: false }))],
    };
    plot.current = new uPlot(opts, data as uPlot.AlignedData, el.current);
    const ro = new ResizeObserver(() => { if (el.current && plot.current) plot.current.setSize({ width: el.current.clientWidth, height }); });
    ro.observe(el.current);
    return () => { ro.disconnect(); plot.current?.destroy(); plot.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, height, compact]);
  useEffect(() => { plot.current?.setData(data as uPlot.AlignedData); }, [data]);
  return <div ref={el} className="chart" />;
}
