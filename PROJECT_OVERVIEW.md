# Tremor Compensation Stylus, Software Demo

A companion explainer for the Mini Project Report "Real-Time Tremor Compensation System for Precision Assistive Stylus Using Embedded Digital Filtering and PID Control."

This document covers:

1. What the project is and why it matters
2. How the hardware system was supposed to work
3. How this web app simulates the same pipeline
4. How to interpret every chart and metric on screen
5. A simple, plain-language script you can use to explain it to a panel

---

## 1. The one-line idea

Your hand always shakes a tiny bit, even when you think it is steady. This shaking (called physiological tremor) sits in the 8 to 12 Hz band. When you write or draw with a normal pen, those small wobbles show up as a jagged line. This project detects that shake in real time and cancels it out, so the line you draw comes out smoother than your hand actually was.

The original plan was a physical stylus with an MPU6050 sensor, an ESP32 microcontroller, and an SG90 servo that physically twitches the pen tip to counteract the shake. Because the hardware was not feasible in time, the same algorithm pipeline is implemented as a web app you can run on an iPad with an Apple Pencil. The Pencil acts as the sensor, the browser does the filtering and PID maths, and the on-screen line acts as the corrected output.

---

## 2. How the hardware version was supposed to work

```
[Hand tremor]
    |
    v
[MPU6050 IMU on stylus] ----> raw tilt angle (accel + gyro)
    |
    v
[ESP32 at 100 Hz]
    |
    +----> first-order EMA low-pass filter (removes 8-12 Hz tremor)
    |
    +----> discrete PID controller (drives error toward zero)
    |
    v
[PWM signal]
    |
    v
[SG90 servo] ----> physically tilts a pivoted tip to cancel the wobble
```

Voluntary motion (the actual letters you want to write) lives below about 5 Hz. Tremor lives at 8 to 12 Hz. Those two bands are separated enough that a simple low-pass filter can keep the voluntary motion and throw away the tremor. The PID controller then closes the loop by commanding the servo to push the tip in the opposite direction.

---

## 3. How the web app maps onto that pipeline

| Original hardware part | Web app equivalent |
|---|---|
| MPU6050 IMU (3-axis accel + gyro) | Browser pointer events from the Apple Pencil (x, y, pressure, tilt) |
| ESP32 sampling at 100 Hz | The browser fires pointer events around 120 to 240 Hz on iPad |
| First-order EMA low-pass filter | Same first-order EMA, written in TypeScript (`src/lib/dsp.ts`) |
| Discrete PID controller | Same discrete PID, written in TypeScript |
| SG90 servo + pivoted tip | Virtual "servo command" gauge on screen, clamped to plus/minus 15 degrees |
| Serial plotter trace | The two live canvas charts (residual + FFT) |

Both the red and blue strokes you see on the canvas are computed from the same input. The red one is the raw pointer path. The blue one is what the path becomes after the EMA filter. The gap between them is what the PID would need to cancel in hardware.

---

## 4. How to read the screen, panel by panel

### 4.1 The drawing canvas (left side)

* **Red line**: your raw stylus path. Every wobble shows up here.
* **Blue line**: the EMA-filtered path. This is the "compensated" output, what the user would see if the hardware were doing its job perfectly.
* **Yellow dashed line (ref-line mode)**: a horizontal target. Try to trace it. The closer the blue stays to it compared to the red, the better the compensation.

If you toggle the "raw" button off, you only see the smooth blue line. That is roughly what an Apple Pencil user would experience with the system running.

### 4.2 The verdict box (top of sidebar)

This is the headline status. It now stays on screen for at least 2 seconds after any change, so brief tremor bursts are still readable. The wording you will see:

* **idle, awaiting stylus input**: nothing has been drawn yet.
* **steady hand, no tremor energy**: you are drawing but the residual is tiny.
* **voluntary motion, below tremor band**: you are drawing smooth strokes. Frequency content is below 8 Hz.
* **tremor detected in 8-12 Hz band, PID engaged**: the FFT peak or the band-energy ratio crossed the threshold and amplitude is significant. This is what you want to demonstrate.
* **high-frequency jitter, above physiological band**: very fast wiggling, faster than a real human tremor.

### 4.3 The eight live stats

Each label has a small `?` icon. Tap it for a short, plain-language explanation. Quick reference:

* **sample rate**: how many pointer updates per second the browser is giving us.
* **tremor amp (RMS)**: how big the wobble is on average, measured in pixels.
* **peak residual**: the single largest wobble in the last 3 seconds.
* **dom. frequency**: the strongest frequency in the residual. If this lands inside the 8 to 12 Hz band the field turns amber.
* **band energy (8-12)**: the percentage of total wobble energy that sits inside the tremor band. This is the most reliable tremor indicator.
* **smoothing gain**: how much smoother the compensated path is than the raw input, as a percentage.
* **pointer**: pen, touch, or mouse. Only pen gives meaningful pressure and tilt.
* **pressure**: how hard you are pressing on the screen, 0 to 1.

### 4.4 The servo gauge and PID readouts

The arc dial in the middle of the sidebar shows the virtual servo command in degrees. In hardware, the actual SG90 micro-servo would be twitching by this much in the opposite direction of the tremor.

* **servo cmd**: the angle the SG90 would be at right now.
* **PID error**: how big the residual is at this instant.
* **integral**: accumulated error since the start of the stroke. Resets on each new stroke.
* **derivative**: how fast the error is changing.

If the servo needle swings hard to one side and back, that visually proves the PID is reacting to a real wobble.

### 4.5 The FFT residual spectrum

This bar chart shows the frequency content of the residual signal between 0 and 30 Hz. The amber-shaded vertical strip is the 8 to 12 Hz tremor band.

* Tall bars inside the amber band mean tremor energy is present.
* Tall bars outside the band mean the wobble has nothing to do with physiological tremor (could just be jerky motion).
* A roughly flat spectrum means there is no clear dominant frequency.

This panel is the visual proof that what we are calling a "tremor" really is a periodic 8 to 12 Hz signal.

### 4.6 The smoothness table (matches Table 5.1 of the report)

| metric | what it measures |
|---|---|
| jerk | mean magnitude of the second difference of position. Higher means jagged. |
| curvature | mean discrete curvature. Tremor adds tiny extra curvature per unit length. |
| ref RMSE (when ref line is on) | average distance from the dashed yellow reference line. |

The delta-percent column shows how much the compensated path improved over the raw path. A positive number means the EMA filter is doing its job.

This table is the quantitative evidence for the report. Read the raw column, read the comp column, then point at the delta column to say "and that is how much smoother the line came out."

### 4.7 The residual, servo, and pressure time chart

Three signals on one axis covering the last 3 seconds:

* **pink**: residual magnitude in pixels (the input to the PID).
* **green**: servo command in degrees (the output of the PID), centred on the middle of the chart.
* **sky blue**: stylus pressure.

If pink and green move in opposite directions, that is the closed-loop control working in real time.

### 4.8 The sliders

* **EMA alpha**: how aggressive the low-pass filter is. Lower means smoother but laggier. Higher follows your hand but lets tremor through.
* **Kp, Ki, Kd**: the three PID gains. Increase Kp to make the servo react harder. Increase Ki to cancel persistent offsets. Increase Kd to damp fast spikes.

The `?` icons next to each slider explain the trade-off.

---

## 5. A 60-second script you can read out

Use this if you are demoing in front of a panel and want a clean narrative:

> "Physiological tremor is the small involuntary shake every human hand has, in the 8 to 12 Hz range. For tasks like fine drawing or writing, that shake becomes visible as a wobbly line.
>
> Our original plan was a physical stylus: an MPU6050 inertial sensor on the body, an ESP32 reading it at 100 Hz, a digital low-pass filter, a PID controller, and an SG90 micro-servo that physically tilts the pen tip to cancel the wobble.
>
> The hardware build was not feasible in our timeline, so we ported the entire algorithm pipeline into a single-page web app. We are running it on an iPad here. The Apple Pencil replaces the MPU6050, the browser replaces the ESP32, the EMA filter and PID controller are written in TypeScript, and the virtual servo angle is shown on this gauge.
>
> When I write normally, you can see the red raw line and the blue filtered line lying on top of each other. The verdict says 'voluntary motion'. Now watch when I introduce a tremor on purpose."
>
> (Shake hand while drawing.)
>
> "The verdict flips to 'tremor detected, PID engaged'. The FFT bars light up in the 8 to 12 Hz band. The servo needle starts swinging. And the smoothness table shows the compensated path is about X percent smoother than the raw input.
>
> So the algorithm pipeline from our report is verified in real time, on an off-the-shelf device, with the same maths we would have loaded onto the ESP32."

---

## 6. Likely panel questions and short answers

**Q. Why an EMA filter and not a Butterworth or FIR?**
Because it has only one coefficient, runs in constant time per sample, and is trivial to debug visually. Gonzalez 2000 designed optimal filters too, but for a sixth-semester project an EMA with a hand-tunable alpha is the right complexity.

**Q. The frequency you show changes a lot, is that real tremor?**
The frequency display is the peak of the FFT in the last 128 samples. Human tremor naturally drifts around inside 8 to 12 Hz. We confirm it is real tremor not just noise by also checking that the band-energy ratio is above 18 percent. Both have to agree before the verdict triggers.

**Q. Why does the blue line lag behind my hand?**
Because the EMA filter introduces a small group delay. Lower alpha means more lag. The slider lets you trade smoothness against responsiveness, which is the same trade-off the firmware would face on the ESP32.

**Q. The Apple Pencil samples at 240 Hz but the firmware was 100 Hz, does that matter?**
The maths is the same. Higher sample rate means better tremor resolution. The firmware version would do the equivalent operation with the same alpha and the same Kp Ki Kd on 100 Hz data.

**Q. Where is the servo physically?**
There is no physical servo in this demo. The arc gauge labelled "servo cmd" shows the angle the SG90 would have been driven to. In hardware, that command would go out as a PWM signal on a GPIO pin.

**Q. How is this different from just smoothing a line in Photoshop?**
Photoshop smooths after the fact, on the recorded stroke. This system smooths the live signal in real time inside a closed control loop. The smoothing decision is made on every single sample, and the PID output could drive a real actuator before the user even finishes the stroke.

---

## 7. Files in this project

| Path | Purpose |
|---|---|
| `src/app/page.tsx` | Single-page client component. Canvas, sidebar, charts, all UI. |
| `src/app/layout.tsx` | Next.js root layout, viewport setup for iPad. |
| `src/app/globals.css` | Tailwind setup and the `stylus-surface` touch-action rules. |
| `src/lib/dsp.ts` | All the signal-processing maths: EMA, PID, FFT, jerk, curvature. |
| `package.json` | Next.js 16, React 19, Tailwind 4, TypeScript 5. |

To run it locally: `npm run dev`, then open `http://localhost:3000` on the iPad on the same Wi-Fi.

---

## 8. A note on what this demo does not claim

This is a software port of an embedded design. It demonstrates that the algorithm pipeline (EMA plus PID plus servo command) does detect and correct tremor. It does not claim:

* clinical validity for Parkinson's or essential tremor diagnosis
* hardware-grade closed-loop performance (there is no physical actuator)
* better tremor cancellation than published research-grade systems

The goal is to show, in a teachable and visible way, that the maths from the report works on a real human hand on a real device.
