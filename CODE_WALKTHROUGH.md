# Tremor Stylus, Code Walkthrough

A companion to `PROJECT_OVERVIEW.md`. That file explains the project. This one explains how the code is actually wired together, so a reviewer (or future you) can read `page.tsx` from top to bottom without getting lost.

---

## 1. Files and their jobs

```
src/
  app/
    layout.tsx     Next.js root layout, viewport setup for iPad, body class
    page.tsx       The single-page app: canvas, all UI, all event handlers
    globals.css    Tailwind import, paper styles, verdict animation keyframe
  lib/
    dsp.ts         Pure math: EMA, PID, FFT, jerk, curvature, RMS deviation
```

Only `page.tsx` is interactive. `dsp.ts` is plain TypeScript functions with no React, no DOM, no canvas. The split is deliberate: if you ever port this back to the ESP32, every function in `dsp.ts` translates almost line-for-line to C.

---

## 2. The data model

Three core types live at the top of `page.tsx`. Everything else in the file moves these around.

### `SamplePoint`
One pointer sample. Stored in `samplesRef.current` while a stroke is active, and inside each `CompletedStroke.samples` once the stroke ends.

```ts
{
  t: number,          // ms since stroke start
  x, y: number,       // raw pointer position in canvas-local px
  fx, fy: number,     // EMA-filtered position
  res: number,        // hypot(x-fx, y-fy), the residual magnitude
  servo: number,      // PID output mapped to a virtual SG90 angle, ±15°
  pidError,           // residual at this sample
  pidIntegral,
  pidDerivative,
  pressure,           // 0 to 1 from the Apple Pencil
  tiltX, tiltY,       // degrees, also from the Pencil
}
```

The interesting fields are `x,y` (the input), `fx,fy` (what the EMA filter produced), and `res` (what the PID will react to).

### `LiveMetrics`
A snapshot of everything the sidebar displays. Computed once per animation frame in `recomputeMetrics`. Stored in `useState` so React re-renders when it changes.

### `CompletedStroke`
A finished stroke plus its drawing settings, captured at the moment the user put pen down:

```ts
{
  samples: SamplePoint[],
  penColor: string,         // the compensated-line color
  rawColor: string,
  size: number,             // pen-size slider value
  pressureSize: boolean,    // whether width tapers with pressure
}
```

Stored in `pastStrokesRef.current` (an array). This is what lets each stroke keep its own colour even if you change the pen colour between strokes, and what makes "undo" possible.

---

## 3. The life of a single stroke

This is the most important sequence to understand. The user puts the Pencil down, drags, and lifts. Here is exactly what happens, in order.

### Step A. `handlePointerDown`
* Captures the pointer so we keep getting events even outside the canvas.
* Records the start time.
* Resets `samplesRef.current = []` so a fresh buffer collects this stroke.
* Resets the EMA history (`lastFilteredRef = null`).
* Resets the PID state (`pidRef.current = emptyPid()`).
* Snapshots the current artist settings into `strokeOptsRef.current` so the stroke keeps its color and size even if the user changes the sliders mid-stroke.
* Sets `isDrawing` state, which kicks off the metrics animation loop.

### Step B. `handlePointerMove` (called many times)
* Validates the pointer id matches the active capture.
* Calls `nativeEvent.getCoalescedEvents()`. iPad ProMotion fires events at up to 240 Hz, but the OS coalesces them. We pull them apart so the EMA filter sees every actual sample.
* For each sample, calls `ingestSample()`.

### Step C. `ingestSample`
The hot path. Runs maybe 200 times per second. This is where the firmware pipeline happens, one sample at a time.

```ts
// 1. Raw input from the event
x = src.clientX - rect.left
y = src.clientY - rect.top
dt = (now - lastSampleTime) / 1000

// 2. First-order EMA low-pass (the same equation as the firmware)
fx = alpha * x + (1 - alpha) * prev.x
fy = alpha * y + (1 - alpha) * prev.y

// 3. Residual = how far the raw is from the filtered
res = hypot(x - fx, y - fy)

// 4. PID acts on the residual (imported from dsp.ts)
next = pidStep(pidRef.current, pidGainsRef.current, res, dt)
servo = clamp(next.output * SERVO_GAIN, -15, +15)

// 5. Store the sample
samplesRef.current.push({ t, x, y, fx, fy, res, servo, ... })

// 6. Draw the new line segment on the canvas
//    Width comes from widthFor(sample, opts), which uses pressure if enabled.
ctx.strokeStyle = opts.rawColor;  ctx.lineWidth = widthFor(b, opts, 0.55);  ...
ctx.strokeStyle = opts.penColor;  ctx.lineWidth = widthFor(b, opts, 1);     ...
```

Notice we draw **only the new segment** here, not the whole stroke. The previously drawn segments stay on the canvas. This avoids redrawing thousands of segments every event.

### Step D. `finishStroke`
* Releases the pointer capture.
* If the stroke has more than one sample, pushes a snapshot of `samplesRef.current` plus the captured options into `pastStrokesRef.current`. This is what `undo` later pops.
* Clears `isDrawing`, which stops the metrics loop.

### Step E. Between strokes
* `samplesRef.current` is left holding the last stroke (so metrics keep showing it).
* The next `handlePointerDown` clears it again.

---

## 4. The metrics loop

A second pipeline runs in parallel, completely separate from the drawing pipeline. It is responsible for everything in the sidebar.

```ts
useEffect(() => {
  if (!isDrawing) return;
  const tick = () => {
    recomputeMetrics();  // updates LiveMetrics state
    drawCharts();        // re-renders the FFT and time-series canvases
    rafRef.current = requestAnimationFrame(tick);
  };
  rafRef.current = requestAnimationFrame(tick);
  ...
}, [isDrawing, ...]);
```

This is a classic `requestAnimationFrame` loop. It only runs while a stroke is active, so we are not burning CPU when the iPad is idle. After the stroke ends, one final `drawCharts()` call keeps the panels showing the last state.

### What `recomputeMetrics` does

1. Slice the last 3 seconds of `samplesRef.current`.
2. Compute the sample rate from the window duration.
3. Compute RMS residual and peak residual directly.
4. Pull the residuals into an array and call `dftMagnitude(...)` from `dsp.ts`. That returns spectral bins from 0 to Nyquist.
5. Sum the energy in 8 to 12 Hz, divide by total, that is the `bandEnergyRatio`.
6. Call `peakFrequency(bins, 1, 30)` for the dominant-frequency display.
7. Call `jerkMetric` and `curvatureMetric` on both raw and filtered paths, fills the smoothness table.
8. If reference-line mode is on, call `rmsDeviationFromLine` twice for the table's third row.
9. Set the `stable` flag: only true after the stroke is at least 600 ms long and has 50 plus samples. This is what kills the false "tremor detected" verdict during the EMA's warmup transient.
10. Push everything into `setMetrics(...)`. React re-renders the sidebar with the new numbers.

### What `drawCharts` does

Two canvases get rendered here, both at the same DPR as the main canvas:

1. The residual / servo / pressure time chart, drawn left-to-right over the last 3 seconds.
2. The FFT bar chart, with the 8 to 12 Hz strip shaded in amber. Bars inside the strip are drawn amber, bars outside are gray.

---

## 5. The verdict box: real-time and readable

The verdict text gets computed every frame from the live metrics:

```ts
const verdict = useMemo(() => {
  if (sampleRate === 0)       return "idle, awaiting stylus input";
  if (!stable)                return "stabilising filter, hold for a moment";
  if (tremorInBand)           return "tremor detected in 8-12 Hz band, PID engaged";
  if (amp < 0.25)             return "steady hand, no tremor energy";
  if (freq < 8)               return "voluntary motion, below tremor band";
  if (freq > 12)              return "high-frequency jitter, above physiological band";
  return "tracking...";
}, [metrics]);
```

But if we displayed that directly, brief tremor bursts (under 200 ms) would be unreadable. The fix is an asymmetric latch:

```ts
useEffect(() => {
  if (verdict === displayedVerdict) return;
  const minHold = isTremorVerdict(displayedVerdict) ? 1200 : 0;
  ...
}, [verdict, displayedVerdict]);
```

* When the verdict changes to anything boring, update **immediately** (real-time feel).
* When the displayed verdict is a "tremor" or "high-frequency" message, hold it for at least 1.2 seconds before letting it change to something else (readable).

Combined with a CSS animation (`verdict-pulse` in `globals.css`) applied via `key={displayedVerdict}`, the box visibly flashes on each change, so even instant updates are perceptible.

---

## 6. React state vs refs: why both

In `page.tsx` you will see two parallel patterns:

```ts
const [alpha, setAlpha] = useState(EMA_ALPHA_DEFAULT);  // state, triggers renders
const alphaRef = useRef(alpha);                          // ref, no renders
useEffect(() => { alphaRef.current = alpha; }, [alpha]); // keep them in sync
```

The reason is the hot path. `ingestSample` runs hundreds of times per second. If it read `alpha` from React state, every change to a slider would invalidate every closure that depends on it. By keeping a mirrored ref, the event handlers always see the latest value without React having to re-create them.

Same trick for `pidGains`, `penColor`, `rawColor`, `penSize`, `pressureSize`, `showRef`, and `isDrawing`. All of them have both a state (for UI) and a ref (for the hot path).

---

## 7. The drawing pipeline

There are three canvases, and they are drawn three different ways.

### Main canvas
* `redrawAll()` does the full repaint: paper color fill, grid, reference line, every past stroke, plus the in-progress stroke if `isDrawing`.
* `redrawAll` is called on resize, on toggle changes (raw / compensated / ref line), on paper-color changes, and on undo/clear.
* During a stroke, individual segments are drawn incrementally inside `ingestSample`. We never call `redrawAll` while drawing, since it would erase the trail.

### Chart canvas and FFT canvas
* Both are fully repainted every frame by `drawCharts()`. They are small (a few hundred wide), so this is cheap.

### `drawStroke` helper
Renders a `CompletedStroke` by walking its samples and emitting one `ctx.lineTo` per pair. If `pressureSize` is on, each segment gets its own `lineWidth` from `widthFor(sample, opts)`, scaled by pressure. That gives the variable-width "calligraphy" feel without any tricky path math.

---

## 8. Artist features

Four pieces hang together:

1. **Per-stroke options** captured in `strokeOptsRef` at pointer-down, and copied into `pastStrokesRef` at pointer-up. Each stroke is forever drawn with the settings it was made with.
2. **`paperColor`** is filled before everything else in `redrawAll`. The grid color flips via the `paperIsLight()` helper so the grid is always faintly visible.
3. **`widthFor(sample, opts, rawScale)`** is the single source of truth for line width. It multiplies the base size by the raw-scale fraction (so raw lines are slightly thinner than compensated), and optionally by a pressure factor.
4. **`handleUndo`** pops the last item from `pastStrokesRef`, resets the metrics, and calls `redrawAll`.

---

## 9. HelpTip popovers

Every label can have a `?` icon that opens a popover. The implementation has three small responsibilities:

* **Position**: compute from the trigger button's `getBoundingClientRect()` on open. Use `position: fixed` so the popover escapes the sidebar's `overflow-y-auto` clipping. Flip the popover above the button if it would overflow the bottom of the viewport.
* **Singleton**: when a tip opens, dispatch a custom event `helptip:opened` with the tip's `useId()`. Every other open tip listens, checks the id, and closes itself if it does not match. Only one tip is ever open.
* **Close**: on outside pointer-down, on scroll, on resize. Closing on scroll keeps the bubble from floating away from its trigger.

---

## 10. PNG export

Each save button calls a small helper:

```ts
const exportCanvas = (canvas, name, bg) => {
  const temp = document.createElement("canvas");
  temp.width = canvas.width;
  temp.height = canvas.height;
  const ctx = temp.getContext("2d");
  ctx.fillStyle = bg;                  // paper color or panel bg
  ctx.fillRect(0, 0, temp.width, temp.height);
  ctx.drawImage(canvas, 0, 0);          // overlay the real canvas
  temp.toBlob(blob => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 100);
  }, "image/png");
};
```

* Source canvases are transparent (the page bg shows through). Filling the temp canvas with the right color first makes the PNG self-contained.
* Each panel has its own save button so the user picks what to keep. Avoids the iOS Safari quirk of only allowing one programmatic download per gesture.

---

## 11. Quick mental model for reviewers

If someone asks "show me where the tremor detection happens," point them at this short tour, in this order:

1. **`src/lib/dsp.ts`** is the firmware math, line by line.
2. **`ingestSample` in `page.tsx`** is the per-sample loop, where the EMA filter and PID call live.
3. **`recomputeMetrics`** is the per-frame analysis, where the FFT and the smoothness numbers come from.
4. **The verdict `useMemo` plus the latch `useEffect`** decide what to call the current motion.
5. **`redrawAll` and `drawStroke`** are the rendering layer, kept separate from the math.

That order is also a good way to read the file from top to bottom, since the helpers and types appear before the React component, and the component is laid out roughly in the order things execute.
