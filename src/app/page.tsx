"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";

type SamplePoint = {
  t: number;
  x: number;
  y: number;
  fx: number;
  fy: number;
  res: number;
  pressure: number;
  tiltX: number;
  tiltY: number;
};

type LiveMetrics = {
  sampleRate: number;
  tremorAmplitude: number;
  peakResidual: number;
  estimatedFrequency: number;
  rmseImprovement: number;
  pressure: number;
  tiltX: number;
  tiltY: number;
  pointerType: string;
  inTremorBand: boolean;
};

const EMA_ALPHA_DEFAULT = 0.18;
const STROKE_WINDOW_MS = 3000;
const TREMOR_BAND = [8, 12] as const;
const MAX_HISTORY = 4096;

function emptyMetrics(): LiveMetrics {
  return {
    sampleRate: 0,
    tremorAmplitude: 0,
    peakResidual: 0,
    estimatedFrequency: 0,
    rmseImprovement: 0,
    pressure: 0,
    tiltX: 0,
    tiltY: 0,
    pointerType: "--",
    inTremorBand: false,
  };
}

export default function TremorStylusPage() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const chartRef = useRef<HTMLCanvasElement | null>(null);
  const samplesRef = useRef<SamplePoint[]>([]);
  const activePointerRef = useRef<number | null>(null);
  const lastFilteredRef = useRef<{ x: number; y: number } | null>(null);
  const strokeStartRef = useRef<number>(0);
  const rafRef = useRef<number | null>(null);
  const metricsPointerTypeRef = useRef("--");

  const [showRaw, setShowRaw] = useState(true);
  const [showCompensated, setShowCompensated] = useState(true);
  const [alpha, setAlpha] = useState(EMA_ALPHA_DEFAULT);
  const [metrics, setMetrics] = useState<LiveMetrics>(emptyMetrics);
  const [isDrawing, setIsDrawing] = useState(false);
  const [strokes, setStrokes] = useState<number>(0);

  const alphaRef = useRef(alpha);
  useEffect(() => {
    alphaRef.current = alpha;
  }, [alpha]);

  const redrawAll = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const rect = canvas.getBoundingClientRect();
    ctx.clearRect(0, 0, rect.width, rect.height);

    ctx.save();
    ctx.strokeStyle = "rgba(255,255,255,0.04)";
    ctx.lineWidth = 1;
    const step = 40;
    for (let x = 0; x <= rect.width; x += step) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, rect.height);
      ctx.stroke();
    }
    for (let y = 0; y <= rect.height; y += step) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(rect.width, y);
      ctx.stroke();
    }
    ctx.restore();

    drawSamples(ctx, samplesRef.current, showRaw, showCompensated);
  }, [showRaw, showCompensated]);

  useEffect(() => {
    const sync = () => {
      const dpr = window.devicePixelRatio || 1;
      for (const c of [canvasRef.current, chartRef.current]) {
        if (!c) continue;
        const rect = c.getBoundingClientRect();
        c.width = Math.max(1, Math.floor(rect.width * dpr));
        c.height = Math.max(1, Math.floor(rect.height * dpr));
        const ctx = c.getContext("2d");
        if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      }
      redrawAll();
    };
    sync();
    window.addEventListener("resize", sync);
    return () => window.removeEventListener("resize", sync);
  }, [redrawAll]);

  useEffect(() => {
    redrawAll();
  }, [redrawAll]);

  const recomputeMetrics = useCallback(() => {
    const all = samplesRef.current;
    if (all.length < 4) {
      setMetrics({ ...emptyMetrics(), pointerType: metricsPointerTypeRef.current });
      return;
    }
    const tEnd = all[all.length - 1].t;
    const tStart = Math.max(0, tEnd - STROKE_WINDOW_MS);
    const window = all.filter((s) => s.t >= tStart);
    if (window.length < 4) return;

    const dur = window[window.length - 1].t - window[0].t;
    const sampleRate = dur > 0 ? ((window.length - 1) * 1000) / dur : 0;

    let sumSq = 0;
    let peak = 0;
    for (const s of window) {
      sumSq += s.res * s.res;
      if (s.res > peak) peak = s.res;
    }
    const tremorAmplitude = Math.sqrt(sumSq / window.length);

    let zc = 0;
    let prevSign = 0;
    for (let i = 1; i < window.length; i++) {
      const a = window[i - 1];
      const b = window[i];
      const rawDX = b.x - a.x;
      const rawDY = b.y - a.y;
      const fDX = b.fx - a.fx;
      const fDY = b.fy - a.fy;
      const cross = rawDX * fDY - rawDY * fDX;
      const sign = cross > 0.1 ? 1 : cross < -0.1 ? -1 : 0;
      if (sign !== 0 && prevSign !== 0 && sign !== prevSign) zc++;
      if (sign !== 0) prevSign = sign;
    }
    const estimatedFrequency = dur > 0 ? zc / 2 / (dur / 1000) : 0;

    let rawSumSq = 0;
    for (let i = 1; i < window.length; i++) {
      const dx = window[i].x - window[i - 1].x;
      const dy = window[i].y - window[i - 1].y;
      rawSumSq += dx * dx + dy * dy;
    }
    const rawRms = Math.sqrt(rawSumSq / Math.max(1, window.length - 1));
    const rmseImprovement =
      rawRms > 0.01 ? Math.max(0, Math.min(1, 1 - tremorAmplitude / rawRms)) : 0;

    const last = window[window.length - 1];
    setMetrics({
      sampleRate,
      tremorAmplitude,
      peakResidual: peak,
      estimatedFrequency,
      rmseImprovement,
      pressure: last.pressure,
      tiltX: last.tiltX,
      tiltY: last.tiltY,
      pointerType: metricsPointerTypeRef.current,
      inTremorBand:
        estimatedFrequency >= TREMOR_BAND[0] && estimatedFrequency <= TREMOR_BAND[1],
    });
  }, []);

  const drawCharts = useCallback(() => {
    const chart = chartRef.current;
    if (!chart) return;
    const ctx = chart.getContext("2d");
    if (!ctx) return;
    const rect = chart.getBoundingClientRect();
    ctx.clearRect(0, 0, rect.width, rect.height);
    ctx.fillStyle = "rgba(255,255,255,0.02)";
    ctx.fillRect(0, 0, rect.width, rect.height);

    const all = samplesRef.current;
    if (all.length < 2) {
      ctx.fillStyle = "rgba(255,255,255,0.4)";
      ctx.font = "12px var(--font-geist-mono), monospace";
      ctx.fillText("draw to start streaming…", 12, 20);
      return;
    }
    const tEnd = all[all.length - 1].t;
    const tStart = Math.max(0, tEnd - STROKE_WINDOW_MS);
    const visible = all.filter((s) => s.t >= tStart);
    if (visible.length < 2) return;

    const peak = Math.max(4, ...visible.map((s) => s.res));
    const xScale = (t: number) => ((t - tStart) / STROKE_WINDOW_MS) * rect.width;
    const yScale = (v: number) => rect.height - (v / peak) * (rect.height - 16) - 8;

    ctx.fillStyle = "rgba(255,255,255,0.45)";
    ctx.font = "10px var(--font-geist-mono), monospace";
    ctx.fillText(`residual (px), peak ${peak.toFixed(1)}`, 8, 12);

    ctx.strokeStyle = "rgba(244,114,182,0.9)";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    visible.forEach((s, i) => {
      const x = xScale(s.t);
      const y = yScale(s.res);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();

    ctx.strokeStyle = "rgba(56,189,248,0.6)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    visible.forEach((s, i) => {
      const x = xScale(s.t);
      const y = rect.height - s.pressure * (rect.height - 16) - 8;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
  }, []);

  useEffect(() => {
    if (!isDrawing) {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      return;
    }
    const tick = () => {
      recomputeMetrics();
      drawCharts();
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    };
  }, [isDrawing, recomputeMetrics, drawCharts]);

  useEffect(() => {
    if (!isDrawing) drawCharts();
  }, [isDrawing, drawCharts]);

  const handlePointerDown = useCallback(
    (e: ReactPointerEvent<HTMLCanvasElement>) => {
      e.currentTarget.setPointerCapture(e.pointerId);
      activePointerRef.current = e.pointerId;
      strokeStartRef.current = performance.now();
      samplesRef.current = [];
      lastFilteredRef.current = null;
      metricsPointerTypeRef.current = e.pointerType || "--";
      setIsDrawing(true);
    },
    [],
  );

  const ingestSample = useCallback(
    (e: ReactPointerEvent<HTMLCanvasElement>, coalesced?: PointerEvent) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const src = coalesced ?? (e.nativeEvent as PointerEvent);
      const rect = canvas.getBoundingClientRect();
      const x = src.clientX - rect.left;
      const y = src.clientY - rect.top;
      const t = performance.now() - strokeStartRef.current;
      const a = alphaRef.current;
      const prev = lastFilteredRef.current ?? { x, y };
      const fx = a * x + (1 - a) * prev.x;
      const fy = a * y + (1 - a) * prev.y;
      lastFilteredRef.current = { x: fx, y: fy };
      const res = Math.hypot(x - fx, y - fy);
      const sample: SamplePoint = {
        t,
        x,
        y,
        fx,
        fy,
        res,
        pressure: src.pressure ?? 0,
        tiltX: src.tiltX ?? 0,
        tiltY: src.tiltY ?? 0,
      };
      samplesRef.current.push(sample);
      if (samplesRef.current.length > MAX_HISTORY) {
        samplesRef.current.splice(0, samplesRef.current.length - MAX_HISTORY);
      }

      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      const n = samplesRef.current.length;
      if (n < 2) return;
      const a0 = samplesRef.current[n - 2];
      const b0 = samplesRef.current[n - 1];

      if (showRaw) {
        ctx.strokeStyle = "rgba(248,113,113,0.55)";
        ctx.lineWidth = 1.2;
        ctx.lineCap = "round";
        ctx.beginPath();
        ctx.moveTo(a0.x, a0.y);
        ctx.lineTo(b0.x, b0.y);
        ctx.stroke();
      }
      if (showCompensated) {
        ctx.strokeStyle = "rgba(96,165,250,0.95)";
        ctx.lineWidth = 2.2;
        ctx.lineCap = "round";
        ctx.beginPath();
        ctx.moveTo(a0.fx, a0.fy);
        ctx.lineTo(b0.fx, b0.fy);
        ctx.stroke();
      }
    },
    [showRaw, showCompensated],
  );

  const handlePointerMove = useCallback(
    (e: ReactPointerEvent<HTMLCanvasElement>) => {
      if (activePointerRef.current !== e.pointerId) return;
      const native = e.nativeEvent as PointerEvent;
      const events = native.getCoalescedEvents?.();
      if (events && events.length > 0) {
        for (const c of events) ingestSample(e, c);
      } else {
        ingestSample(e);
      }
    },
    [ingestSample],
  );

  const finishStroke = useCallback((e: ReactPointerEvent<HTMLCanvasElement>) => {
    if (activePointerRef.current !== e.pointerId) return;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      // ignore
    }
    activePointerRef.current = null;
    setIsDrawing(false);
    setStrokes((s) => s + 1);
  }, []);

  const handleClear = useCallback(() => {
    samplesRef.current = [];
    lastFilteredRef.current = null;
    setStrokes(0);
    setMetrics(emptyMetrics());
    redrawAll();
    drawCharts();
  }, [redrawAll, drawCharts]);

  const verdict = useMemo(() => {
    if (metrics.sampleRate === 0) return "idle, awaiting stylus input";
    if (metrics.inTremorBand) {
      return `tremor detected in ${TREMOR_BAND[0]}-${TREMOR_BAND[1]} Hz band, compensation engaged`;
    }
    if (metrics.estimatedFrequency > 0 && metrics.estimatedFrequency < TREMOR_BAND[0]) {
      return "voluntary motion, below tremor band";
    }
    if (metrics.estimatedFrequency > TREMOR_BAND[1]) {
      return "high-frequency jitter, outside physiological band";
    }
    return "tracking...";
  }, [metrics]);

  return (
    <main className="flex-1 flex flex-col lg:flex-row h-screen w-screen overflow-hidden">
      <section className="flex-1 relative flex flex-col">
        <header className="px-5 py-3 border-b border-white/10 flex items-center gap-3 flex-wrap">
          <div className="flex flex-col">
            <h1 className="text-sm font-semibold tracking-tight">
              Real-Time Tremor Compensation Stylus
            </h1>
            <p className="text-[11px] text-white/50 font-mono">
              ESP32 + MPU6050 + SG90 pipeline, ported to the iPad. Draw with the Pencil.

            </p>
          </div>
          <div className="ml-auto flex items-center gap-2 text-xs">
            <button
              onClick={() => setShowRaw((v) => !v)}
              className={`px-2.5 py-1 rounded-md border ${
                showRaw
                  ? "border-red-400/60 bg-red-400/10 text-red-200"
                  : "border-white/10 text-white/50"
              }`}
            >
              raw
            </button>
            <button
              onClick={() => setShowCompensated((v) => !v)}
              className={`px-2.5 py-1 rounded-md border ${
                showCompensated
                  ? "border-blue-400/60 bg-blue-400/10 text-blue-200"
                  : "border-white/10 text-white/50"
              }`}
            >
              compensated
            </button>
            <button
              onClick={handleClear}
              className="px-2.5 py-1 rounded-md border border-white/10 text-white/70 hover:bg-white/5"
            >
              clear
            </button>
          </div>
        </header>
        <div className="relative flex-1">
          <canvas
            ref={canvasRef}
            className="stylus-surface absolute inset-0 w-full h-full"
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={finishStroke}
            onPointerCancel={finishStroke}
            onPointerLeave={finishStroke}
          />
          <div className="absolute bottom-3 left-3 right-3 pointer-events-none flex justify-between text-[11px] font-mono text-white/40">
            <span>
              alpha = {alpha.toFixed(2)} | first-order EMA | cut-off shifts toward voluntary band
            </span>
            <span>strokes: {strokes}</span>
          </div>
        </div>
      </section>

      <aside className="w-full lg:w-[360px] border-t lg:border-t-0 lg:border-l border-white/10 flex flex-col">
        <div className="p-4 border-b border-white/10">
          <div className="text-[11px] uppercase tracking-wider text-white/40 font-mono">
            verdict
          </div>
          <div
            className={`mt-1 text-sm font-medium ${
              metrics.inTremorBand ? "text-amber-300" : "text-white/85"
            }`}
          >
            {verdict}
          </div>
        </div>

        <div className="p-4 grid grid-cols-2 gap-3 border-b border-white/10">
          <Stat label="sample rate" value={`${metrics.sampleRate.toFixed(0)} Hz`} />
          <Stat
            label="tremor amp (RMS)"
            value={`${metrics.tremorAmplitude.toFixed(2)} px`}
            highlight={metrics.tremorAmplitude > 1.2}
          />
          <Stat label="peak residual" value={`${metrics.peakResidual.toFixed(2)} px`} />
          <Stat
            label="dom. frequency"
            value={`${metrics.estimatedFrequency.toFixed(1)} Hz`}
            highlight={metrics.inTremorBand}
          />
          <Stat
            label="smoothing gain"
            value={`${(metrics.rmseImprovement * 100).toFixed(0)} %`}
          />
          <Stat label="pointer" value={metrics.pointerType} />
          <Stat label="pressure" value={metrics.pressure.toFixed(2)} />
          <Stat
            label="tilt x/y"
            value={`${metrics.tiltX.toFixed(0)}° / ${metrics.tiltY.toFixed(0)}°`}
          />
        </div>

        <div className="p-4 border-b border-white/10">
          <div className="flex items-baseline justify-between mb-2">
            <div className="text-[11px] uppercase tracking-wider text-white/40 font-mono">
              residual & pressure (last 3 s)
            </div>
            <div className="text-[10px] font-mono text-white/40">
              <span className="text-pink-300">●</span> residual{" "}
              <span className="text-sky-300 ml-2">●</span> pressure
            </div>
          </div>
          <canvas
            ref={chartRef}
            className="w-full h-32 rounded-md border border-white/10"
          />
        </div>

        <div className="p-4 border-b border-white/10">
          <label className="block text-[11px] uppercase tracking-wider text-white/40 font-mono mb-2">
            EMA alpha, filter aggressiveness
          </label>
          <input
            type="range"
            min={0.02}
            max={0.6}
            step={0.01}
            value={alpha}
            onChange={(e) => setAlpha(parseFloat(e.target.value))}
            className="w-full accent-blue-400"
          />
          <div className="mt-1 flex justify-between text-[10px] font-mono text-white/40">
            <span>smoother (more lag)</span>
            <span>{alpha.toFixed(2)}</span>
            <span>sharper (more tremor)</span>
          </div>
        </div>

        <div className="p-4 text-[11px] leading-relaxed text-white/60 font-mono">
          <p className="mb-2">
            <span className="text-red-300">red</span> raw stylus path,{" "}
            <span className="text-blue-300">blue</span> EMA-compensated path. The
            residual between them is the tremor estimate that the firmware feeds to
            the PID loop driving the SG90.
          </p>
          <p>
            Tremor band: {TREMOR_BAND[0]}-{TREMOR_BAND[1]} Hz (Gonzalez 2000; Tironi
            2025). Dominant frequency is estimated via zero crossings of the
            perpendicular residual.
          </p>
        </div>
      </aside>
    </main>
  );
}

function drawSamples(
  ctx: CanvasRenderingContext2D,
  samples: SamplePoint[],
  showRaw: boolean,
  showCompensated: boolean,
) {
  if (samples.length < 2) return;
  if (showRaw) {
    ctx.strokeStyle = "rgba(248,113,113,0.55)";
    ctx.lineWidth = 1.2;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(samples[0].x, samples[0].y);
    for (let i = 1; i < samples.length; i++) ctx.lineTo(samples[i].x, samples[i].y);
    ctx.stroke();
  }
  if (showCompensated) {
    ctx.strokeStyle = "rgba(96,165,250,0.95)";
    ctx.lineWidth = 2.2;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(samples[0].fx, samples[0].fy);
    for (let i = 1; i < samples.length; i++) ctx.lineTo(samples[i].fx, samples[i].fy);
    ctx.stroke();
  }
}

function Stat({
  label,
  value,
  highlight = false,
}: {
  label: string;
  value: string;
  highlight?: boolean;
}) {
  return (
    <div className="flex flex-col">
      <span className="text-[10px] uppercase tracking-wider text-white/40 font-mono">
        {label}
      </span>
      <span
        className={`mt-0.5 font-mono text-sm ${
          highlight ? "text-amber-300" : "text-white/90"
        }`}
      >
        {value}
      </span>
    </div>
  );
}
