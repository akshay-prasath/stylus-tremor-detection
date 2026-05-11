"use client";

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  curvatureMetric,
  dftMagnitude,
  emptyPid,
  jerkMetric,
  peakFrequency,
  pidStep,
  rmsDeviationFromLine,
  type PidGains,
  type PidState,
} from "../lib/dsp";

type SamplePoint = {
  t: number;
  x: number;
  y: number;
  fx: number;
  fy: number;
  res: number;
  servo: number; // PID output mapped to virtual servo angle (deg)
  pidError: number;
  pidIntegral: number;
  pidDerivative: number;
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
  rawJerk: number;
  filteredJerk: number;
  rawCurv: number;
  filteredCurv: number;
  referenceRmseRaw: number;
  referenceRmseFiltered: number;
  pidError: number;
  pidIntegral: number;
  pidDerivative: number;
  servoAngle: number;
  bandEnergyRatio: number; // fraction of spectral energy in 8-12 Hz band
};

const EMA_ALPHA_DEFAULT = 0.18;
const STROKE_WINDOW_MS = 3000;
const TREMOR_BAND = [8, 12] as const;
const MAX_HISTORY = 4096;
const SERVO_RANGE_DEG = 15; // SG90 small-angle compensation range
const SERVO_GAIN = 1.8; // px to deg scale for visualisation
const FFT_N = 128;

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
    rawJerk: 0,
    filteredJerk: 0,
    rawCurv: 0,
    filteredCurv: 0,
    referenceRmseRaw: 0,
    referenceRmseFiltered: 0,
    pidError: 0,
    pidIntegral: 0,
    pidDerivative: 0,
    servoAngle: 0,
    bandEnergyRatio: 0,
  };
}

export default function TremorStylusPage() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const chartRef = useRef<HTMLCanvasElement | null>(null);
  const fftRef = useRef<HTMLCanvasElement | null>(null);
  const samplesRef = useRef<SamplePoint[]>([]);
  const activePointerRef = useRef<number | null>(null);
  const lastFilteredRef = useRef<{ x: number; y: number } | null>(null);
  const lastSampleTimeRef = useRef<number>(0);
  const strokeStartRef = useRef<number>(0);
  const rafRef = useRef<number | null>(null);
  const metricsPointerTypeRef = useRef("--");
  const pidRef = useRef<PidState>(emptyPid());
  const referenceYRef = useRef<number>(0);

  const [showRaw, setShowRaw] = useState(true);
  const [showCompensated, setShowCompensated] = useState(true);
  const [showReference, setShowReference] = useState(false);
  const [alpha, setAlpha] = useState(EMA_ALPHA_DEFAULT);
  const [pidGains, setPidGains] = useState<PidGains>({ Kp: 1.2, Ki: 0.4, Kd: 0.05 });
  const [metrics, setMetrics] = useState<LiveMetrics>(emptyMetrics);
  const [isDrawing, setIsDrawing] = useState(false);
  const [strokes, setStrokes] = useState<number>(0);

  const alphaRef = useRef(alpha);
  const pidGainsRef = useRef(pidGains);
  const showRefRef = useRef(showReference);
  useEffect(() => {
    alphaRef.current = alpha;
  }, [alpha]);
  useEffect(() => {
    pidGainsRef.current = pidGains;
  }, [pidGains]);
  useEffect(() => {
    showRefRef.current = showReference;
  }, [showReference]);

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

    if (showReference) {
      referenceYRef.current = rect.height / 2;
      ctx.save();
      ctx.strokeStyle = "rgba(250,204,21,0.55)";
      ctx.setLineDash([8, 6]);
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(20, referenceYRef.current);
      ctx.lineTo(rect.width - 20, referenceYRef.current);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = "rgba(250,204,21,0.7)";
      ctx.font = "10px var(--font-geist-mono), monospace";
      ctx.fillText("reference line: draw along this to measure deviation", 24, referenceYRef.current - 6);
      ctx.restore();
    }

    drawSamples(ctx, samplesRef.current, showRaw, showCompensated);
  }, [showRaw, showCompensated, showReference]);

  useEffect(() => {
    const sync = () => {
      const dpr = window.devicePixelRatio || 1;
      for (const c of [canvasRef.current, chartRef.current, fftRef.current]) {
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

    let rawSumSq = 0;
    for (let i = 1; i < window.length; i++) {
      const dx = window[i].x - window[i - 1].x;
      const dy = window[i].y - window[i - 1].y;
      rawSumSq += dx * dx + dy * dy;
    }
    const rawRms = Math.sqrt(rawSumSq / Math.max(1, window.length - 1));
    const rmseImprovement =
      rawRms > 0.01 ? Math.max(0, Math.min(1, 1 - tremorAmplitude / rawRms)) : 0;

    const rawPath = window.map((s) => ({ x: s.x, y: s.y }));
    const fPath = window.map((s) => ({ x: s.fx, y: s.fy }));
    const rawJerk = jerkMetric(rawPath);
    const filteredJerk = jerkMetric(fPath);
    const rawCurv = curvatureMetric(rawPath);
    const filteredCurv = curvatureMetric(fPath);

    let referenceRmseRaw = 0;
    let referenceRmseFiltered = 0;
    if (showRefRef.current && referenceYRef.current > 0) {
      referenceRmseRaw = rmsDeviationFromLine(rawPath, referenceYRef.current);
      referenceRmseFiltered = rmsDeviationFromLine(fPath, referenceYRef.current);
    }

    // FFT on residual scalar, last FFT_N samples. Peak frequency in 1-30 Hz becomes
    // the displayed dominant frequency; band-energy ratio drives the verdict.
    const recent = window.slice(-FFT_N).map((s) => s.res);
    const bins = dftMagnitude(recent, sampleRate);
    let bandEnergy = 0;
    let totalEnergy = 0;
    for (const b of bins) {
      if (b.freq < 1) continue; // ignore DC / drift
      const e = b.mag * b.mag;
      totalEnergy += e;
      if (b.freq >= TREMOR_BAND[0] && b.freq <= TREMOR_BAND[1]) bandEnergy += e;
    }
    const bandEnergyRatio = totalEnergy > 0 ? bandEnergy / totalEnergy : 0;
    const estimatedFrequency = peakFrequency(bins, 1, 30).freq;

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
        (estimatedFrequency >= TREMOR_BAND[0] &&
          estimatedFrequency <= TREMOR_BAND[1] &&
          tremorAmplitude > 0.4) ||
        (bandEnergyRatio > 0.18 && tremorAmplitude > 0.4),
      rawJerk,
      filteredJerk,
      rawCurv,
      filteredCurv,
      referenceRmseRaw,
      referenceRmseFiltered,
      pidError: last.pidError,
      pidIntegral: last.pidIntegral,
      pidDerivative: last.pidDerivative,
      servoAngle: last.servo,
      bandEnergyRatio,
    });
  }, []);

  const drawCharts = useCallback(() => {
    const chart = chartRef.current;
    const fft = fftRef.current;
    const all = samplesRef.current;

    if (chart) {
      const ctx = chart.getContext("2d");
      if (ctx) {
        const rect = chart.getBoundingClientRect();
        ctx.clearRect(0, 0, rect.width, rect.height);
        ctx.fillStyle = "rgba(255,255,255,0.02)";
        ctx.fillRect(0, 0, rect.width, rect.height);

        if (all.length < 2) {
          ctx.fillStyle = "rgba(255,255,255,0.4)";
          ctx.font = "12px var(--font-geist-mono), monospace";
          ctx.fillText("draw to start streaming...", 12, 20);
        } else {
          const tEnd = all[all.length - 1].t;
          const tStart = Math.max(0, tEnd - STROKE_WINDOW_MS);
          const visible = all.filter((s) => s.t >= tStart);
          if (visible.length >= 2) {
            const peak = Math.max(4, ...visible.map((s) => s.res));
            const xScale = (t: number) => ((t - tStart) / STROKE_WINDOW_MS) * rect.width;
            const yScale = (v: number) =>
              rect.height - (v / peak) * (rect.height - 16) - 8;

            ctx.fillStyle = "rgba(255,255,255,0.45)";
            ctx.font = "10px var(--font-geist-mono), monospace";
            ctx.fillText(`residual (px), peak ${peak.toFixed(1)}`, 8, 12);

            // residual line (pink)
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

            // servo angle line (green), centered at midline
            const servoScale = SERVO_RANGE_DEG;
            ctx.strokeStyle = "rgba(74,222,128,0.85)";
            ctx.lineWidth = 1;
            ctx.beginPath();
            visible.forEach((s, i) => {
              const x = xScale(s.t);
              const y =
                rect.height / 2 -
                (s.servo / servoScale) * (rect.height / 2 - 6);
              if (i === 0) ctx.moveTo(x, y);
              else ctx.lineTo(x, y);
            });
            ctx.stroke();

            // pressure line (sky)
            ctx.strokeStyle = "rgba(56,189,248,0.55)";
            ctx.lineWidth = 1;
            ctx.beginPath();
            visible.forEach((s, i) => {
              const x = xScale(s.t);
              const y = rect.height - s.pressure * (rect.height - 16) - 8;
              if (i === 0) ctx.moveTo(x, y);
              else ctx.lineTo(x, y);
            });
            ctx.stroke();
          }
        }
      }
    }

    if (fft) {
      const ctx = fft.getContext("2d");
      if (ctx) {
        const rect = fft.getBoundingClientRect();
        ctx.clearRect(0, 0, rect.width, rect.height);
        ctx.fillStyle = "rgba(255,255,255,0.02)";
        ctx.fillRect(0, 0, rect.width, rect.height);

        if (all.length >= FFT_N / 2) {
          const tEnd = all[all.length - 1].t;
          const tStart = Math.max(0, tEnd - STROKE_WINDOW_MS);
          const visible = all.filter((s) => s.t >= tStart);
          const dur = visible.length > 1 ? visible[visible.length - 1].t - visible[0].t : 0;
          const sr = dur > 0 ? ((visible.length - 1) * 1000) / dur : 0;
          const recent = visible.slice(-FFT_N).map((s) => s.res);
          const bins = dftMagnitude(recent, sr).filter((b) => b.freq <= 30);

          if (bins.length > 0) {
            const maxMag = Math.max(0.01, ...bins.map((b) => b.mag));
            const w = rect.width - 24;
            const h = rect.height - 22;
            const barW = w / bins.length;

            // tremor band shading
            const fMin = TREMOR_BAND[0];
            const fMax = TREMOR_BAND[1];
            const xFor = (f: number) => 12 + (f / 30) * w;
            ctx.fillStyle = "rgba(251,191,36,0.12)";
            ctx.fillRect(xFor(fMin), 14, xFor(fMax) - xFor(fMin), h);

            ctx.fillStyle = "rgba(255,255,255,0.45)";
            ctx.font = "10px var(--font-geist-mono), monospace";
            ctx.fillText("residual spectrum (0-30 Hz)", 8, 12);
            ctx.fillStyle = "rgba(251,191,36,0.8)";
            ctx.fillText(`${fMin}-${fMax} Hz`, xFor(fMin) + 4, 12);

            bins.forEach((b, i) => {
              const inBand = b.freq >= fMin && b.freq <= fMax;
              const bh = (b.mag / maxMag) * h;
              ctx.fillStyle = inBand
                ? "rgba(251,191,36,0.95)"
                : "rgba(148,163,184,0.7)";
              ctx.fillRect(12 + i * barW, 14 + (h - bh), Math.max(1, barW - 1), bh);
            });

            // axis ticks
            ctx.fillStyle = "rgba(255,255,255,0.35)";
            ctx.font = "9px var(--font-geist-mono), monospace";
            for (const f of [0, 8, 12, 20, 30]) {
              const x = xFor(f);
              ctx.fillRect(x, rect.height - 8, 1, 3);
              ctx.fillText(`${f}`, x - 4, rect.height - 1);
            }
          }
        } else {
          ctx.fillStyle = "rgba(255,255,255,0.4)";
          ctx.font = "12px var(--font-geist-mono), monospace";
          ctx.fillText("collecting samples for FFT...", 12, 20);
        }
      }
    }
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
      lastSampleTimeRef.current = strokeStartRef.current;
      samplesRef.current = [];
      lastFilteredRef.current = null;
      pidRef.current = emptyPid();
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
      const nowMs = performance.now();
      const t = nowMs - strokeStartRef.current;
      const dt = Math.max(0.001, (nowMs - lastSampleTimeRef.current) / 1000);
      lastSampleTimeRef.current = nowMs;
      const a = alphaRef.current;
      const prev = lastFilteredRef.current ?? { x, y };
      const fx = a * x + (1 - a) * prev.x;
      const fy = a * y + (1 - a) * prev.y;
      lastFilteredRef.current = { x: fx, y: fy };
      const res = Math.hypot(x - fx, y - fy);

      // PID on the residual magnitude.
      const next = pidStep(pidRef.current, pidGainsRef.current, res, dt);
      pidRef.current = next;
      const servo = Math.max(
        -SERVO_RANGE_DEG,
        Math.min(SERVO_RANGE_DEG, next.output * SERVO_GAIN),
      );
      const prevErr = samplesRef.current.at(-1)?.pidError ?? res;
      const pidDerivative = dt > 0 ? (res - prevErr) / dt : 0;

      const sample: SamplePoint = {
        t,
        x,
        y,
        fx,
        fy,
        res,
        servo,
        pidError: res,
        pidIntegral: next.integral,
        pidDerivative,
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
    pidRef.current = emptyPid();
    setStrokes(0);
    setMetrics(emptyMetrics());
    redrawAll();
    drawCharts();
  }, [redrawAll, drawCharts]);

  const VERDICT_HOLD_MS = 1200;
  const lastVerdictChangeRef = useRef(0);
  const [displayedVerdict, setDisplayedVerdict] = useState("idle, awaiting stylus input");
  const isTremorVerdict = (v: string) =>
    v.startsWith("tremor detected") || v.startsWith("high-frequency");

  const verdict = useMemo(() => {
    if (metrics.sampleRate === 0) return "idle, awaiting stylus input";
    const amp = metrics.tremorAmplitude;
    const ratio = metrics.bandEnergyRatio;
    const inBand =
      metrics.estimatedFrequency >= TREMOR_BAND[0] &&
      metrics.estimatedFrequency <= TREMOR_BAND[1];
    if ((inBand && amp > 0.4) || (ratio > 0.18 && amp > 0.4)) {
      return `tremor detected in ${TREMOR_BAND[0]}-${TREMOR_BAND[1]} Hz band, PID engaged`;
    }
    if (amp < 0.25) return "steady hand, no tremor energy";
    if (metrics.estimatedFrequency > 0 && metrics.estimatedFrequency < TREMOR_BAND[0]) {
      return "voluntary motion, below tremor band";
    }
    if (metrics.estimatedFrequency > TREMOR_BAND[1]) {
      return "high-frequency jitter, above physiological band";
    }
    return "tracking...";
  }, [metrics]);

  useEffect(() => {
    if (verdict === displayedVerdict) return;
    // Only the tremor-class verdicts are latched (so brief bursts stay readable).
    // Every other transition is immediate, keeping the feel real time.
    const minHold = isTremorVerdict(displayedVerdict) ? VERDICT_HOLD_MS : 0;
    const elapsed = performance.now() - lastVerdictChangeRef.current;
    if (elapsed >= minHold) {
      setDisplayedVerdict(verdict);
      lastVerdictChangeRef.current = performance.now();
      return;
    }
    const id = window.setTimeout(() => {
      setDisplayedVerdict(verdict);
      lastVerdictChangeRef.current = performance.now();
    }, minHold - elapsed);
    return () => window.clearTimeout(id);
  }, [verdict, displayedVerdict]);

  return (
    <main className="flex-1 flex flex-col lg:flex-row h-screen w-screen overflow-hidden">
      <section className="flex-1 min-h-0 relative flex flex-col">
        <header className="px-5 py-3 border-b border-white/10 flex items-center gap-3 flex-wrap">
          <div className="flex flex-col">
            <h1 className="text-sm font-semibold tracking-tight">
              Real-Time Tremor Compensation Stylus
            </h1>
            <p className="text-[11px] text-white/50 font-mono">
              ESP32 + MPU6050 + EMA + PID + SG90 pipeline, ported to the iPad.
            </p>
          </div>
          <div className="ml-auto flex items-center gap-2 text-xs flex-wrap">
            <button
              onClick={() => setShowRaw((v) => !v)}
              title="Toggle the red raw stylus trace (unfiltered pointer position)."
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
              title="Toggle the blue EMA-compensated trace (what the user would see after tremor cancellation)."
              className={`px-2.5 py-1 rounded-md border ${
                showCompensated
                  ? "border-blue-400/60 bg-blue-400/10 text-blue-200"
                  : "border-white/10 text-white/50"
              }`}
            >
              compensated
            </button>
            <button
              onClick={() => setShowReference((v) => !v)}
              title="Draw a yellow dashed reference line through the canvas mid-height. Tracing along it adds the reference-RMSE row to the smoothness table."
              className={`px-2.5 py-1 rounded-md border ${
                showReference
                  ? "border-amber-300/60 bg-amber-300/10 text-amber-200"
                  : "border-white/10 text-white/50"
              }`}
            >
              ref line
            </button>
            <button
              onClick={handleClear}
              title="Wipe the canvas, sample buffer, and PID state. Strokes counter resets to zero."
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
              alpha = {alpha.toFixed(2)} | Kp={pidGains.Kp.toFixed(2)} Ki=
              {pidGains.Ki.toFixed(2)} Kd={pidGains.Kd.toFixed(2)}
            </span>
            <span>strokes: {strokes}</span>
          </div>
        </div>
      </section>

      <aside className="w-full lg:w-[460px] h-[42vh] lg:h-auto shrink-0 lg:shrink border-t lg:border-t-0 lg:border-l border-white/10 flex flex-col overflow-y-auto">
        <div className="p-4 border-b border-white/10">
          <div className="text-[11px] uppercase tracking-wider text-white/40 font-mono">
            verdict
          </div>
          <div
            key={displayedVerdict}
            className={`mt-1 text-sm font-medium verdict-anim ${
              isTremorVerdict(displayedVerdict) ? "text-amber-300" : "text-white/85"
            }`}
          >
            {displayedVerdict}
          </div>
        </div>

        <div className="p-4 grid grid-cols-2 gap-3 border-b border-white/10">
          <Stat
            label="sample rate"
            value={`${metrics.sampleRate.toFixed(0)} Hz`}
            tip="Rate at which the browser emits pointer events. Apple Pencil ProMotion can reach 240 Hz. The reference firmware samples the MPU6050 at a fixed 100 Hz."
          />
          <Stat
            label="tremor amp (RMS)"
            value={`${metrics.tremorAmplitude.toFixed(2)} px`}
            highlight={metrics.tremorAmplitude > 1.2}
            tip="Root-mean-square of the residual (raw minus EMA-filtered position) over the last 3 s. Acts as a proxy for total tremor energy."
          />
          <Stat
            label="peak residual"
            value={`${metrics.peakResidual.toFixed(2)} px`}
            tip="Largest single-sample distance between raw and filtered position in the window. Spikes here indicate sudden involuntary deflections."
          />
          <Stat
            label="dom. frequency"
            value={`${metrics.estimatedFrequency.toFixed(1)} Hz`}
            highlight={metrics.inTremorBand}
            tip="Strongest frequency component of the residual, taken from the FFT peak between 1 and 30 Hz. Highlighted when it falls inside the 8-12 Hz physiological tremor band."
          />
          <Stat
            label="band energy (8-12)"
            value={`${(metrics.bandEnergyRatio * 100).toFixed(0)} %`}
            highlight={metrics.bandEnergyRatio > 0.18}
            tip="Fraction of residual spectral energy that lies inside the 8-12 Hz tremor band. The verdict flips to 'tremor detected' when this exceeds ~18 % and amplitude is non-trivial."
          />
          <Stat
            label="smoothing gain"
            value={`${(metrics.rmseImprovement * 100).toFixed(0)} %`}
            tip="1 minus (tremor RMS / raw step RMS). Reports how much smoother the EMA path is than the raw stylus path."
          />
          <Stat
            label="pointer"
            value={metrics.pointerType}
            tip="Pointer device class reported by the browser. 'pen' = Apple Pencil, 'touch' = finger, 'mouse' = mouse. Only 'pen' produces meaningful pressure and tilt."
          />
          <Stat
            label="pressure"
            value={metrics.pressure.toFixed(2)}
            tip="Stylus tip pressure on a 0-1 scale. Only the Apple Pencil reports this; touch and mouse are typically 0 or 0.5."
          />
        </div>

        <ServoPanel
          servoAngle={metrics.servoAngle}
          error={metrics.pidError}
          integral={metrics.pidIntegral}
          derivative={metrics.pidDerivative}
        />

        <div className="p-4 border-b border-white/10">
          <div className="flex items-baseline justify-between mb-2">
            <div className="text-[11px] uppercase tracking-wider text-white/40 font-mono">
              residual spectrum (FFT)
            </div>
            <div className="text-[10px] font-mono text-white/40">
              <span className="text-amber-300">●</span> tremor band
            </div>
          </div>
          <canvas
            ref={fftRef}
            className="w-full h-28 rounded-md border border-white/10"
          />
        </div>

        <SmoothnessTable metrics={metrics} showReference={showReference} />

        <div className="p-4 border-b border-white/10">
          <div className="flex items-baseline justify-between mb-2">
            <div className="text-[11px] uppercase tracking-wider text-white/40 font-mono">
              residual, servo & pressure (last 3 s)
            </div>
            <div className="text-[10px] font-mono text-white/40">
              <span className="text-pink-300">●</span> residual{" "}
              <span className="text-green-300 ml-2">●</span> servo{" "}
              <span className="text-sky-300 ml-2">●</span> pressure
            </div>
          </div>
          <canvas
            ref={chartRef}
            className="w-full h-32 rounded-md border border-white/10"
          />
        </div>

        <div className="p-4 border-b border-white/10 space-y-3">
          <SliderField
            label="EMA alpha"
            value={alpha}
            min={0.02}
            max={0.6}
            step={0.01}
            onChange={setAlpha}
            accent="accent-blue-400"
            tip="Low-pass filter aggressiveness. Lower alpha = more smoothing but the compensated (blue) line lags further behind your hand. Higher alpha = follows the pen closely but lets more tremor through. The firmware uses this as the LPF coefficient on the tilt angle."
          />
          <SliderField
            label="Kp (proportional)"
            value={pidGains.Kp}
            min={0}
            max={4}
            step={0.05}
            onChange={(v) => setPidGains((g) => ({ ...g, Kp: v }))}
            accent="accent-green-400"
            tip="Proportional gain. Larger Kp gives a stronger immediate servo response to the residual error. Too high causes oscillation and overshoot; too low leaves residual tremor uncorrected."
          />
          <SliderField
            label="Ki (integral)"
            value={pidGains.Ki}
            min={0}
            max={2}
            step={0.05}
            onChange={(v) => setPidGains((g) => ({ ...g, Ki: v }))}
            accent="accent-green-400"
            tip="Integral gain. Accumulates past error to eliminate steady-state offset between the desired and filtered tilt. Too high causes integral wind-up and slow overshoot."
          />
          <SliderField
            label="Kd (derivative)"
            value={pidGains.Kd}
            min={0}
            max={0.5}
            step={0.005}
            onChange={(v) => setPidGains((g) => ({ ...g, Kd: v }))}
            accent="accent-green-400"
            tip="Derivative gain. Reacts to how fast the error is changing, damping rapid transitions. Helps prevent overshoot but amplifies pointer noise if too high."
          />
        </div>

        <div className="p-4 text-[11px] leading-relaxed text-white/60 font-mono space-y-2">
          <p className="text-white/70">hardware mapping</p>
          <ul className="space-y-0.5 text-white/55">
            <li>MPU6050 IMU = Apple Pencil pointer events (x, y, tilt, pressure)</li>
            <li>first-order EMA = blue compensated path (filtered tilt angle)</li>
            <li>PID loop = green servo trace, ±{SERVO_RANGE_DEG}° SG90 range</li>
            <li>serial plotter trace = FFT bar + residual chart</li>
          </ul>
          <p className="pt-1 text-white/45">
            Tremor band 8-12 Hz (Gonzalez 2000, Tironi 2025). The PID acts on the
            EMA residual to cancel the tremor component while preserving voluntary
            motion.
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
  tip,
}: {
  label: string;
  value: string;
  highlight?: boolean;
  tip?: string;
}) {
  return (
    <div className="flex flex-col">
      <span className="text-[10px] uppercase tracking-wider text-white/40 font-mono flex items-center">
        {label}
        {tip && <HelpTip text={tip} />}
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

const HELPTIP_EVENT = "helptip:opened";

function HelpTip({ text }: { text: string }) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const POPOVER_W = 260;

  // Close on outside pointer-down.
  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest("[data-helptip-popover]")) return;
      setOpen(false);
    };
    const tid = window.setTimeout(() => {
      window.addEventListener("pointerdown", close);
    }, 0);
    return () => {
      window.clearTimeout(tid);
      window.removeEventListener("pointerdown", close);
    };
  }, [open]);

  // Close this tip whenever a different tip is opened.
  useEffect(() => {
    const onOpened = (e: Event) => {
      const ce = e as CustomEvent<string>;
      if (ce.detail !== id) setOpen(false);
    };
    window.addEventListener(HELPTIP_EVENT, onOpened);
    return () => window.removeEventListener(HELPTIP_EVENT, onOpened);
  }, [id]);

  const toggle = () => {
    if (!open && btnRef.current) {
      const r = btnRef.current.getBoundingClientRect();
      const left = Math.max(
        8,
        Math.min(window.innerWidth - POPOVER_W - 8, r.right - POPOVER_W),
      );
      const top = r.bottom + 6;
      setPos({ left, top });
      window.dispatchEvent(new CustomEvent(HELPTIP_EVENT, { detail: id }));
    }
    setOpen((o) => !o);
  };

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        onPointerDown={(e) => {
          e.stopPropagation();
          toggle();
        }}
        className="text-white/30 hover:text-white/70 text-[10px] leading-none w-3.5 h-3.5 inline-flex items-center justify-center rounded-full border border-white/15 ml-1 align-middle shrink-0"
        aria-label="help"
        data-helptip-popover
      >
        ?
      </button>
      {open && pos && (
        <span
          className="fixed z-50 p-2 rounded-md bg-neutral-900 border border-white/20 text-[11px] text-white/85 leading-snug shadow-xl normal-case tracking-normal font-sans whitespace-normal"
          style={{ left: pos.left, top: pos.top, width: POPOVER_W }}
          data-helptip-popover
        >
          {text}
        </span>
      )}
    </>
  );
}

function ServoPanel({
  servoAngle,
  error,
  integral,
  derivative,
}: {
  servoAngle: number;
  error: number;
  integral: number;
  derivative: number;
}) {
  const clamped = Math.max(-SERVO_RANGE_DEG, Math.min(SERVO_RANGE_DEG, servoAngle));
  const ratio = clamped / SERVO_RANGE_DEG; // -1..1
  const arcSize = 110;
  const cx = arcSize / 2;
  const cy = arcSize - 10;
  const r = arcSize / 2 - 8;
  // map ratio to angle from -90deg (left) to +90deg (right)
  const angleRad = (ratio * Math.PI) / 2;
  const needleX = cx + r * Math.sin(angleRad);
  const needleY = cy - r * Math.cos(angleRad);

  return (
    <div className="p-4 border-b border-white/10 flex items-center gap-4">
      <div className="shrink-0">
        <svg width={arcSize} height={arcSize - 6} viewBox={`0 0 ${arcSize} ${arcSize - 6}`}>
          <path
            d={`M ${cx - r} ${cy} A ${r} ${r} 0 0 1 ${cx + r} ${cy}`}
            stroke="rgba(255,255,255,0.12)"
            strokeWidth={6}
            fill="none"
            strokeLinecap="round"
          />
          <path
            d={`M ${cx - r} ${cy} A ${r} ${r} 0 0 1 ${cx + r} ${cy}`}
            stroke="rgba(74,222,128,0.55)"
            strokeWidth={6}
            fill="none"
            strokeLinecap="round"
            strokeDasharray={`${Math.PI * r}`}
            strokeDashoffset={`${Math.PI * r * (1 - Math.abs(ratio))}`}
            transform={ratio < 0 ? `scale(-1 1) translate(${-arcSize} 0)` : undefined}
          />
          <line
            x1={cx}
            y1={cy}
            x2={needleX}
            y2={needleY}
            stroke="rgba(74,222,128,0.95)"
            strokeWidth={2}
            strokeLinecap="round"
          />
          <circle cx={cx} cy={cy} r={3} fill="rgba(74,222,128,0.95)" />
          <text
            x={cx - r}
            y={cy + 12}
            fill="rgba(255,255,255,0.4)"
            fontSize="9"
            fontFamily="var(--font-geist-mono), monospace"
          >
            -{SERVO_RANGE_DEG}°
          </text>
          <text
            x={cx + r - 12}
            y={cy + 12}
            fill="rgba(255,255,255,0.4)"
            fontSize="9"
            fontFamily="var(--font-geist-mono), monospace"
          >
            +{SERVO_RANGE_DEG}°
          </text>
        </svg>
      </div>
      <div className="flex-1 grid grid-cols-2 gap-2">
        <Stat
          label="servo cmd"
          value={`${clamped.toFixed(1)}°`}
          highlight={Math.abs(clamped) > SERVO_RANGE_DEG * 0.6}
          tip="Virtual SG90 servo command in degrees, clamped to ±15°. In hardware this drives the pivoted tip to physically cancel the detected tremor."
        />
        <Stat
          label="PID error"
          value={`${error.toFixed(2)}`}
          tip="Current input to the PID controller, equal to the residual magnitude (px). The PID drives this toward zero."
        />
        <Stat
          label="integral"
          value={`${integral.toFixed(2)}`}
          tip="Running sum of PID error scaled by dt. Lets the controller cancel persistent offsets. Reset at the start of each stroke."
        />
        <Stat
          label="derivative"
          value={`${derivative.toFixed(2)}`}
          tip="Rate of change of the PID error in px/s. Damps fast transitions but amplifies sensor noise if Kd is too high."
        />
      </div>
    </div>
  );
}

function SmoothnessTable({
  metrics,
  showReference,
}: {
  metrics: LiveMetrics;
  showReference: boolean;
}) {
  const jerkImprovement =
    metrics.rawJerk > 1e-6
      ? Math.max(0, (1 - metrics.filteredJerk / metrics.rawJerk) * 100)
      : 0;
  const curvImprovement =
    metrics.rawCurv > 1e-9
      ? Math.max(0, (1 - metrics.filteredCurv / metrics.rawCurv) * 100)
      : 0;
  const refImprovement =
    metrics.referenceRmseRaw > 1e-6
      ? Math.max(0, (1 - metrics.referenceRmseFiltered / metrics.referenceRmseRaw) * 100)
      : 0;

  return (
    <div className="p-4 border-b border-white/10">
      <div className="text-[11px] uppercase tracking-wider text-white/40 font-mono mb-2">
        smoothness metrics (matches Table 5.1)
      </div>
      <table className="w-full text-[11px] font-mono">
        <thead>
          <tr className="text-white/40">
            <th className="text-left font-normal py-1">metric</th>
            <th className="text-right font-normal py-1">raw</th>
            <th className="text-right font-normal py-1">comp</th>
            <th className="text-right font-normal py-1">
              <span className="inline-flex items-center justify-end">
                delta%
                <HelpTip text="Percent improvement of the compensated path over the raw path. Higher is better; 0 means no improvement, 100 means the metric collapsed to zero." />
              </span>
            </th>
          </tr>
        </thead>
        <tbody className="text-white/80">
          <tr>
            <td className="py-1">
              <span className="inline-flex items-center">
                jerk
                <HelpTip text="Mean magnitude of the second difference of position. A direct proxy for line shakiness, exactly what Table 5.1 in the report uses to compare loop-on vs loop-off strokes." />
              </span>
            </td>
            <td className="text-right text-red-300">{metrics.rawJerk.toFixed(2)}</td>
            <td className="text-right text-blue-300">{metrics.filteredJerk.toFixed(2)}</td>
            <td className="text-right text-green-300">{jerkImprovement.toFixed(0)}</td>
          </tr>
          <tr>
            <td className="py-1">
              <span className="inline-flex items-center">
                curvature
                <HelpTip text="Mean discrete curvature along the stroke. Tremor introduces extra micro-curvature; a lower compensated value means the line bends less per unit length." />
              </span>
            </td>
            <td className="text-right text-red-300">{metrics.rawCurv.toExponential(1)}</td>
            <td className="text-right text-blue-300">{metrics.filteredCurv.toExponential(1)}</td>
            <td className="text-right text-green-300">{curvImprovement.toFixed(0)}</td>
          </tr>
          {showReference && (
            <tr>
              <td className="py-1">
                <span className="inline-flex items-center">
                  ref RMSE
                  <HelpTip text="Root-mean-square distance from the dashed yellow reference line. Matches Fig 5.2 of the report: draw along the line and compare how close each trace stays to it." />
                </span>
              </td>
              <td className="text-right text-red-300">{metrics.referenceRmseRaw.toFixed(1)}</td>
              <td className="text-right text-blue-300">
                {metrics.referenceRmseFiltered.toFixed(1)}
              </td>
              <td className="text-right text-green-300">{refImprovement.toFixed(0)}</td>
            </tr>
          )}
        </tbody>
      </table>
      {!showReference && (
        <p className="text-[10px] text-white/35 font-mono mt-2">
          enable ref line to add deviation-from-reference RMSE
        </p>
      )}
    </div>
  );
}

function SliderField({
  label,
  value,
  min,
  max,
  step,
  onChange,
  accent,
  tip,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
  accent: string;
  tip?: string;
}) {
  return (
    <div>
      <label className="block text-[11px] uppercase tracking-wider text-white/40 font-mono mb-1 flex items-center">
        {label}
        {tip && <HelpTip text={tip} />}
      </label>
      <div className="flex items-center gap-3">
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(e) => onChange(parseFloat(e.target.value))}
          className={`flex-1 ${accent}`}
        />
        <span className="text-[11px] font-mono text-white/70 w-12 text-right">
          {value.toFixed(2)}
        </span>
      </div>
    </div>
  );
}
