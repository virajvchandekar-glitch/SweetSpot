# SweetSpot: Self-Tuning Thread Pool

SweetSpot is a lightweight, educational Operating Systems mini-project web application built purely with vanilla HTML5, CSS3, and JavaScript that demonstrates concurrency, thread pool optimization, and scalability bottlenecks. By continuously running a stream of tasks across a pre-allocated pool of real browser Web Workers, measuring real-time throughput (completed tasks per second), and plotting the concurrency curve on an interactive canvas chart, SweetSpot empirically tests whether "more threads = faster" holds true across different workload profiles. It features an automated hill-climbing search engine that detects the optimal concurrency level (the "Sweet Spot"—the minimal thread count achieving at least 95% of peak throughput), highlighting the critical inflection points where hardware CPU saturation, non-blocking I/O overlap, or lock convoy serialization govern system performance.

---

## How to Run

Because modern browsers enforce the Same-Origin Policy and restrict `new Worker()` instantiation from `file://` URLs, SweetSpot must be served over HTTP:

### Option A: Python HTTP Server (Recommended)
1. Open a terminal inside the project directory:
   ```bash
   cd sweetspot
   python -m http.server 8000
   ```
2. Open your web browser and navigate to:
   ```
   http://localhost:8000
   ```

### Option B: VS Code Live Server
1. Open the `sweetspot` folder in Visual Studio Code.
2. Right-click `index.html` in the file explorer and select **Open with Live Server**.
3. Live Server will open the application automatically at `http://127.0.0.1:5500/index.html`.

No node modules, package managers, build tools, or backend servers are required.

---

## File Structure

The project strictly consists of exactly 9 files:

- `index.html`: Semantic single-page HTML skeleton with editorial chart-first layout and control strip.
- `README.md`: Project documentation, architecture overview, OS concept mapping, limitations, and viva demo script.
- `css/style.css`: Base typography, CSS custom properties (neo-brutalist 4-color palette), and responsive grid layout.
- `css/components.css`: Styling for mechanical push-buttons, workload tabs, big stat cards, thread status bars, and the event log.
- `js/app.js`: Main application entry point, DOM event bindings, tab switching, and automated 3-phase demo coordinator.
- `js/scheduler.js`: Producer-consumer task queue, worker pool lifecycle manager, FIFO lock arbiter, and hill-climbing tuning engine.
- `js/monitor.js`: Throughput and efficiency sampling engine, multi-workload curve store, and 95% sweet-spot calculator.
- `js/worker.js`: Dedicated Web Worker code executing CPU-bound prime loops, I/O timeouts, and mutex-guarded critical sections.
- `js/ui.js`: High-DPI HTML5 canvas chart renderer, dynamic thread bar state animator, and telemetry logger.

---

## OS Concept Mapping Table

| OS Concept | Implementation & Location in SweetSpot |
| :--- | :--- |
| **Thread Pool** | Pre-allocated array of persistent Web Workers instantiated at startup in [`js/scheduler.js`](js/scheduler.js) and executed in [`js/worker.js`](js/worker.js), eliminating thread creation and destruction overhead. |
| **Worker State Lifecycle** | Dynamic state machine (`PARKED`, `IDLE`, `RUNNING`, `WAITING_LOCK`, `CRITICAL_SECTION`) visualised via live thread bars in [`js/ui.js`](js/ui.js). |
| **Producer-Consumer Pattern** | The scheduler keeps a central task queue topped up with at least $2 \times N$ pending tasks, continuously feeding idle active workers via non-blocking `postMessage` in [`js/scheduler.js`](js/scheduler.js). |
| **Mutual Exclusion (Mutex)** | Centralized FIFO lock manager in [`js/scheduler.js`](js/scheduler.js) granting exclusive access to one worker at a time before executing the critical section. |
| **Critical Section** | Synchronized block of code in [`js/worker.js`](js/worker.js) accessed only after receiving a `lock-granted` message and terminated with an `unlock` signal. |
| **Amdahl's Law / Contention Bottleneck** | In the `CONTENDED` workload, throughput peaks early (2–4 threads) and collapses as worker threads serialize behind the lock queue. |
| **Context Switching & CPU Saturation** | In `CPU-BOUND` workload, tasks perform intensive computation; throughput scales linearly until hardware cores (`navigator.hardwareConcurrency`) are saturated, after which time-slicing flattens the curve. |
| **I/O Asynchrony & Overlap** | In `I/O-BOUND` workload, threads sleep during simulated blocking waits (`setTimeout`), allowing high concurrency scaling without consuming CPU execution units. |
| **Throughput & Efficiency** | Throughput is measured as $\text{Tasks} / \Delta t$ over a 2.0s sampling window; Efficiency is evaluated as $\text{Throughput} / N$ in [`js/monitor.js`](js/monitor.js). |
| **Self-Tuning Optimization** | Hill-climbing heuristic in [`js/scheduler.js`](js/scheduler.js) that climbs while marginal gain $> 5\%$, refines neighbours, and identifies the sweet spot at $\ge 95\%$ of peak throughput. |

---

## Architectural Note: Mutex & Contention Modeling

In native operating systems (such as Linux or Windows), mutexes and semaphores are kernel primitives or atomic operations (`futex`, `SRWLock`, `pthread_mutex`) that put threads to sleep in the OS scheduler.

In standard browser JavaScript environments, Web Workers operate in isolated memory spaces without direct access to POSIX threads or raw OS mutexes (unless using `SharedArrayBuffer` with `Atomics.wait`, which requires specific COOP/COEP HTTP isolation headers). Therefore, SweetSpot implements mutual exclusion through an explicit, message-passing FIFO lock manager in `scheduler.js`.

Furthermore, to faithfully demonstrate the performance impact of real-world multi-core phenomena (such as lock convoys, kernel thread descheduling, and CPU cache line bouncing), the critical section duration is governed by:
$$\text{Duration} = \text{Base (10ms)} + 1.5\text{ms} \times (\text{Number of Workers Waiting in Lock Queue})$$

> **Important Disclosure**: This overhead term ($1.5\text{ms} \times \text{queue\_length}$) is a mathematical model, not a physical hardware measurement. It purposefully reproduces the Universal Scalability Law (USL) retrograde curve so students can visibly witness why adding threads to a contended lock diminishes throughput.

---

## Real-World Limitations Discovered During Testing

During rigorous browser and system testing, the following real-world characteristics were noted:
1. **Host Hardware Concurrency Variance**: The inflection point for the `CPU-BOUND` curve is strictly bounded by the host machine's logical processors (`navigator.hardwareConcurrency`). On a 12-core CPU, saturation begins around 12 threads; on a dual-core laptop, plateauing occurs around 2 threads.
2. **Timer Precision in Browsers**: Browsers clamp timer resolutions (`setTimeout` / `performance.now()`) to mitigate side-channel timing attacks (e.g. Spectre). A 0.4s warm-up followed by a 2.0s sampling window provides high statistical stability and dampens scheduling jitter.
3. **Garbage Collection (GC) Pauses**: While Web Workers run on background OS threads, major browser GC events can occasionally cause momentary jitter. The 2-second sampling interval reliably smooths out these micro-pauses.

---

## 5-Step Viva Demo Script

When presenting this project to an examiner or instructor, follow this step-by-step demonstration:

1. **Step 1: Introduction & Architecture Setup**
   - Open the web application at `localhost:8000`.
   - Point out the **Header**, **Active Hardware Cores** badge (`navigator.hardwareConcurrency`), and the pre-allocated **Thread Pool** bars initialized with active workers and parked workers.
   - Explain the neo-brutalist poster layout and that zero external libraries were used.

2. **Step 2: CPU-Bound Workload (Hardware Core Saturation)**
   - Ensure the **CPU-BOUND** tab is active.
   - Click **Full Sweep** (or **Auto Tune**).
   - Observe the live canvas curve: throughput rises proportionally with thread count until reaching the system's physical CPU cores, where it flattens due to CPU time-slicing and context switching.
   - Show how the Sweet Spot marker automatically flags the saturation threshold.

3. **Step 3: I/O-Bound Workload (High Concurrency Scaling)**
   - Switch to the **I/O-BOUND** tab.
   - Click **Auto Tune**.
   - Note how the hill-climbing engine climbs rapidly ($N=2, 4, 6, 8, \dots, 16$) because threads spend most of their time in non-blocking I/O waits, allowing throughput to scale far beyond the number of physical cores.

4. **Step 4: Contended Workload (Mutex Contention & Throughput Collapse)**
   - Switch to the **CONTENDED** tab.
   - Click **Full Sweep**.
   - Point to the **Thread Bars**: observe workers alternating into orange `LOCK` (critical section) and striped `WAIT` (mutex queue).
   - Point to the **Canvas Curve**: throughput rises briefly at 2–3 threads, peaks early, and then drastically falls as concurrency increases, demonstrating the disastrous cost of lock convoying and Amdahl's Law.

5. **Step 5: Stored Curves Comparison & Automated Demo**
   - Click **Run Demo** or switch between the tabs (`CPU-BOUND` $\leftrightarrow$ `I/O-BOUND` $\leftrightarrow$ `CONTENDED`).
   - Highlight that each workload profile retains its distinct curve in memory, illustrating to the examiner that the optimal number of threads in an operating system is entirely dependent on the workload characteristics.
