/**
 * SweetSpot - Scheduler & Auto-Tuning Engine
 *
 * OS Concepts Demonstrated:
 * - Thread Pool: Pre-allocated pool of persistent Web Workers reused across tasks.
 * - Mutex (Mutual Exclusion) & Lock Manager: Centralized FIFO lock arbitrator.
 * - Critical Section & Lock Convoy: Serialized execution bottleneck (Amdahl's Law).
 * - Context Switching: Overhead and time-slicing when threads exceed CPU cores.
 * - Producer-Consumer Task Queue: Continuously replenished queue preventing starvation.
 * - Throughput & Scalability: Rate of task completion and sweet-spot optimization.
 */

class Scheduler {
  constructor(monitor, uiCallbacks = {}) {
    this.monitor = monitor;
    this.uiCallbacks = uiCallbacks;

    // Detect hardware concurrency
    this.hwConcurrency = navigator.hardwareConcurrency || 4;
    // Default maxThreads = Math.min(16, Math.max(8, hardwareConcurrency * 2))
    this.maxThreads = Math.min(16, Math.max(8, this.hwConcurrency * 2));
    this.activeThreads = 1;

    // Active Workload: 'cpu' | 'io' | 'contended'
    this.currentWorkload = 'cpu';

    // Worker Pool: Array of { id, worker, status: 'parked'|'idle'|'running'|'waiting_lock'|'critical_section', currentTaskId }
    this.workers = [];
    this.isPoolRunning = true;

    // OS Concept: Producer-Consumer Task Queue
    this.taskQueue = [];
    this.nextTaskId = 1;

    // OS Concept: Mutex Lock Management
    this.lockOwner = null;
    this.lockWaitQueue = []; // FIFO queue of { workerId, taskId }
    this.lastContentionLoggedTime = 0;

    // Tuning Engine & Cancellation Controls
    this.isTuning = false;
    this.tuningMode = null; // 'auto' | 'sweep'
    this.stopRequested = false;
    this.tuningEpoch = 0; // Incremented on cancel/switch to reject stale callbacks
    this.measurementSessionCounter = 0;
    this.currentMeasurementId = null;

    // Initialize worker pool
    this.createPool(this.maxThreads);
    this.setActiveThreads(1, false);
  }

  // OS Concept: Thread Pool Initialization
  // Safely terminates any existing pool and spawns maxThreads persistent Web Workers
  createPool(maxThreads) {
    this.terminatePool();

    this.maxThreads = Math.max(4, Math.min(16, maxThreads));
    this.activeThreads = Math.min(this.activeThreads, this.maxThreads);
    this.workers = [];
    this.lockOwner = null;
    this.lockWaitQueue = [];

    this.log('THREAD POOL', `Created thread pool with ${this.maxThreads} workers (Hardware cores: ${this.hwConcurrency})`);

    for (let i = 1; i <= this.maxThreads; i++) {
      const worker = new Worker('js/worker.js');
      const workerEntry = {
        id: i,
        worker,
        status: i <= this.activeThreads ? 'idle' : 'parked',
        currentTaskId: null
      };

      worker.onmessage = (e) => this.handleWorkerMessage(workerEntry, e.data);
      worker.onerror = (err) => {
        console.error(`Worker T${i} error:`, err);
        this.log('THREAD POOL', `Worker T${i} error: ${err.message || 'Worker failure'}`);
      };

      // Initial handshake
      worker.postMessage({ type: 'init', workerId: i });
      this.workers.push(workerEntry);
    }

    if (this.uiCallbacks.onPoolRecreated) {
      this.uiCallbacks.onPoolRecreated(this.workers, this.maxThreads);
    }

    // Start producer-consumer loop
    this.topUpQueue();
    this.dispatchTasks();
  }

  terminatePool() {
    for (const w of this.workers) {
      try {
        w.worker.postMessage({ type: 'cancel-task' });
        w.worker.terminate();
      } catch (e) {
        // ignore termination errors
      }
    }
    this.workers = [];
    this.taskQueue = [];
    this.lockOwner = null;
    this.lockWaitQueue = [];
  }

  // OS Concept: Dynamic Thread Pool Sizing
  // Changes the active thread count without destroying and recreating the pool
  setActiveThreads(count, shouldLog = true) {
    const prev = this.activeThreads;
    const clamped = Math.max(1, Math.min(this.maxThreads, count));
    this.activeThreads = clamped;

    if (shouldLog && prev !== clamped) {
      this.log('THREAD POOL', `Active workers changed from ${prev} to ${clamped} (${this.maxThreads - clamped} parked)`);
    }

    // Update worker status mappings
    for (let i = 0; i < this.workers.length; i++) {
      const w = this.workers[i];
      if (i < clamped) {
        if (w.status === 'parked') {
          w.status = 'idle';
          this.notifyWorkerState(w);
        }
      } else {
        if (w.status === 'idle') {
          w.status = 'parked';
          this.notifyWorkerState(w);
        }
        // If worker is running, it will automatically transition to parked upon task completion
      }
    }

    this.topUpQueue();
    this.dispatchTasks();

    if (this.uiCallbacks.onActiveThreadsChanged) {
      this.uiCallbacks.onActiveThreadsChanged(this.activeThreads);
    }
  }

  // Set active workload type ('cpu' | 'io' | 'contended')
  setWorkload(workload) {
    if (this.currentWorkload === workload) return;
    const prev = this.currentWorkload;
    this.currentWorkload = workload;
    this.log('THREAD POOL', `Workload switched: ${prev.toUpperCase()} -> ${workload.toUpperCase()}`);

    // Flush pending queue and safely reset lock state
    this.flushLockState();
    this.taskQueue = [];
    this.topUpQueue();
    this.dispatchTasks();
  }

  // Safely release any workers waiting on locks during reset / workload change
  flushLockState() {
    this.lockOwner = null;
    while (this.lockWaitQueue.length > 0) {
      const waiting = this.lockWaitQueue.shift();
      const wEntry = this.workers.find((w) => w.id === waiting.workerId);
      if (wEntry) {
        try {
          wEntry.worker.postMessage({ type: 'cancel-task' });
          wEntry.status = 'idle';
          this.notifyWorkerState(wEntry);
        } catch (e) {
          // ignore
        }
      }
    }
  }

  // OS Concept: Producer-Consumer Queue Maintenance
  // Keeps at least 2 x activeThreads tasks pending to eliminate thread starvation
  topUpQueue() {
    const minPending = Math.max(4, this.activeThreads * 2);
    while (this.taskQueue.length < minPending) {
      this.taskQueue.push({
        id: this.nextTaskId++,
        workloadType: this.currentWorkload,
        measurementId: this.currentMeasurementId,
        createdAt: performance.now()
      });
    }
  }

  // OS Concept: Task Dispatcher (Producer-Consumer Worker Consumption)
  dispatchTasks() {
    if (!this.isPoolRunning) return;

    this.topUpQueue();

    for (let i = 0; i < this.activeThreads; i++) {
      const w = this.workers[i];
      if (!w) continue;

      if (w.status === 'idle' && this.taskQueue.length > 0) {
        const task = this.taskQueue.shift();
        w.status = 'running';
        w.currentTaskId = task.id;
        this.notifyWorkerState(w);

        w.worker.postMessage({
          type: 'start-task',
          task
        });
      }
    }

    this.topUpQueue();
  }

  // Message Handler for Web Worker telemetry
  handleWorkerMessage(workerEntry, msg) {
    if (!msg) return;

    // Status change notification
    if (msg.type === 'status-change') {
      workerEntry.status = msg.status;
      this.notifyWorkerState(workerEntry);
      return;
    }

    // OS Concept: Mutex Lock Request
    if (msg.type === 'lock-request') {
      this.handleLockRequest(workerEntry, msg.taskId);
      return;
    }

    // OS Concept: Mutex Unlock
    if (msg.type === 'unlock') {
      this.handleUnlock(workerEntry, msg.taskId);
      return;
    }

    // OS Concept: Task Completion
    if (msg.type === 'task-complete') {
      // Record only valid completions for the active measurement window
      if (msg.measurementId && msg.measurementId === this.currentMeasurementId) {
        this.monitor.recordTaskCompletion(msg.workloadType, msg.measurementId);
      }

      // Check whether thread should remain active or be parked
      const workerIndex = this.workers.indexOf(workerEntry);
      if (workerIndex < this.activeThreads) {
        workerEntry.status = 'idle';
      } else {
        workerEntry.status = 'parked';
      }
      workerEntry.currentTaskId = null;
      this.notifyWorkerState(workerEntry);

      // Dispatch next pending task
      this.dispatchTasks();
    }
  }

  // OS Concept: FIFO Mutex Lock Request Handler
  handleLockRequest(workerEntry, taskId) {
    if (this.lockOwner === null) {
      // Lock is free: grant immediately
      this.lockOwner = workerEntry.id;
      this.log('MUTEX', `Worker T${workerEntry.id} entered critical section`);

      /*
       * OS Concept: Coordination Overhead Model
       * NOTE: The overhead term (1.5ms * waiting workers) is a MODEL, not a measurement.
       * It simulates the non-linear degradation of cache line bouncing and lock convoys.
       */
      const overheadMs = 1.5 * this.lockWaitQueue.length;
      workerEntry.worker.postMessage({
        type: 'lock-granted',
        taskId,
        overheadMs
      });
    } else {
      // Lock is busy: enqueue in FIFO order
      this.lockWaitQueue.push({ workerId: workerEntry.id, taskId });
      workerEntry.status = 'waiting_lock';
      this.notifyWorkerState(workerEntry);

      const now = performance.now();
      if (now - this.lastContentionLoggedTime > 1200) {
        this.lastContentionLoggedTime = now;
        this.log('MUTEX', `Worker T${workerEntry.id} requested lock (${this.lockWaitQueue.length} waiting in queue)`);
      }
    }
  }

  // OS Concept: FIFO Mutex Lock Release Handler
  handleUnlock(workerEntry, taskId) {
    if (this.lockOwner === workerEntry.id) {
      if (this.lockWaitQueue.length > 0) {
        // Dequeue next thread in strict FIFO order
        const next = this.lockWaitQueue.shift();
        this.lockOwner = next.workerId;

        const nextWorkerEntry = this.workers.find((w) => w.id === next.workerId);
        const overheadMs = 1.5 * this.lockWaitQueue.length;

        if (nextWorkerEntry) {
          nextWorkerEntry.worker.postMessage({
            type: 'lock-granted',
            taskId: next.taskId,
            overheadMs
          });
        }
      } else {
        this.lockOwner = null;
      }
    }
  }

  notifyWorkerState(workerEntry) {
    if (this.uiCallbacks.onThreadStateChange) {
      this.uiCallbacks.onThreadStateChange(workerEntry.id, workerEntry.status);
    }
  }

  log(concept, message) {
    if (this.uiCallbacks.onLog) {
      this.uiCallbacks.onLog(concept, message);
    }
  }

  sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // =========================================================================
  // MEASUREMENT & TUNING ENGINE
  // =========================================================================

  // Measures throughput for a single thread count N
  // Strict procedure: 400ms warm-up (excluded) + 2000ms measurement window
  async measurePoint(threads, targetWorkload = this.currentWorkload, epoch = this.tuningEpoch) {
    if (this.stopRequested || this.tuningEpoch !== epoch) return null;

    this.setActiveThreads(threads, false);

    // Phase 1: Warm-up (400 ms) - exclusions guaranteed via currentMeasurementId = null
    this.currentMeasurementId = null;
    if (this.uiCallbacks.onPhaseChange) {
      this.uiCallbacks.onPhaseChange(`Warming up ${threads} thread${threads > 1 ? 's' : ''}...`);
    }
    await this.sleep(400);

    if (this.stopRequested || this.tuningEpoch !== epoch) return null;

    // Phase 2: Active Sampling Window (2000 ms)
    const measurementId = ++this.measurementSessionCounter;
    this.currentMeasurementId = measurementId;

    // Flush warm-up queue tasks so all new tasks carry the valid measurementId
    this.taskQueue = [];
    this.topUpQueue();
    this.dispatchTasks();

    this.monitor.startMeasurementWindow(targetWorkload, threads, measurementId);

    const windowDurationMs = 2000;
    const intervalMs = 200;
    let elapsedMs = 0;

    while (elapsedMs < windowDurationMs) {
      await this.sleep(intervalMs);
      if (this.stopRequested || this.tuningEpoch !== epoch) {
        this.monitor.stopMeasurementWindow();
        this.currentMeasurementId = null;
        return null;
      }
      elapsedMs += intervalMs;
      const progressSec = (elapsedMs / 1000).toFixed(1);
      if (this.uiCallbacks.onPhaseChange) {
        this.uiCallbacks.onPhaseChange(`Testing ${threads} thread${threads > 1 ? 's' : ''} (${progressSec}s / 2.0s)...`);
      }
    }

    const completedTasks = this.monitor.stopMeasurementWindow();
    this.currentMeasurementId = null;

    if (this.stopRequested || this.tuningEpoch !== epoch) return null;

    // Throughput = completed tasks / 2.0
    const throughput = completedTasks / (windowDurationMs / 1000);
    // Efficiency = throughput / N
    const efficiency = throughput / threads;

    // Store in monitor for the exact target workload
    const result = this.monitor.addResult(targetWorkload, threads, throughput, efficiency);

    this.log('THROUGHPUT', `${throughput.toFixed(1)} tasks/s at ${threads} thread${threads > 1 ? 's' : ''} (Efficiency: ${efficiency.toFixed(1)} tasks/s/thread)`);

    if (this.uiCallbacks.onPointMeasured) {
      this.uiCallbacks.onPointMeasured(targetWorkload, result);
    }

    return result;
  }

  // OS Concept: Auto-Tuning via Hill-Climbing Algorithm
  // 1. Starts at N = 2.
  // 2. Steps by +2 while throughput improves > 5%.
  // 3. Refines neighbours (N-1, N+1) around the best candidate.
  // 4. Declares SWEET SPOT = smallest N achieving >= 95% of peak throughput.
  async runAutoTune() {
    if (this.isTuning) return;
    this.isTuning = true;
    this.tuningMode = 'auto';
    this.stopRequested = false;
    const epoch = ++this.tuningEpoch;
    const workload = this.currentWorkload;

    this.log('SCALABILITY', `Starting Auto Tune on [${workload.toUpperCase()}] workload`);

    try {
      let currentN = Math.min(2, this.maxThreads);
      let prevThroughput = 0;
      let bestN = currentN;
      let peakThroughput = 0;

      // 1. Initial measurement at N = 2
      const firstResult = await this.measurePoint(currentN, workload, epoch);
      if (!firstResult || this.stopRequested || this.tuningEpoch !== epoch) return;

      prevThroughput = firstResult.throughput;
      peakThroughput = firstResult.throughput;
      bestN = currentN;

      // 2. Hill-climbing coarse search: Step by +2
      while (currentN + 2 <= this.maxThreads) {
        if (this.stopRequested || this.tuningEpoch !== epoch) break;

        const nextN = currentN + 2;
        const result = await this.measurePoint(nextN, workload, epoch);
        if (!result || this.stopRequested || this.tuningEpoch !== epoch) break;

        const currentThroughput = result.throughput;
        const improvement = prevThroughput > 0 ? (currentThroughput - prevThroughput) / prevThroughput : 1;

        if (currentThroughput > peakThroughput) {
          peakThroughput = currentThroughput;
          bestN = nextN;
        }

        if (improvement < -0.05) {
          const dropPct = Math.round(Math.abs(improvement) * 100);
          this.log('CONTEXT SWITCH', `Throughput decreased ${dropPct}% at ${nextN} threads`);
        }

        // Continue climbing only if improvement > 5%
        if (improvement > 0.05) {
          prevThroughput = currentThroughput;
          currentN = nextN;
        } else {
          // Gain <= 5% or throughput dropped: Stop coarse search and refine
          this.log('SCALABILITY', `Gain leveled off (delta: ${(improvement * 100).toFixed(1)}%). Refining around best candidate N=${bestN}...`);
          break;
        }
      }

      // 3. Refinement Phase: Test valid unmeasured neighbours (bestN - 1 and bestN + 1)
      const measuredCounts = new Set(this.monitor.getResults(workload).map((r) => r.threads));
      const candidatesToRefine = [bestN - 1, bestN + 1].filter(
        (n) => n >= 1 && n <= this.maxThreads && !measuredCounts.has(n)
      );

      for (const neighbourN of candidatesToRefine) {
        if (this.stopRequested || this.tuningEpoch !== epoch) break;
        if (this.uiCallbacks.onPhaseChange) {
          this.uiCallbacks.onPhaseChange(`Refining neighbour: ${neighbourN} thread${neighbourN > 1 ? 's' : ''}...`);
        }
        await this.measurePoint(neighbourN, workload, epoch);
      }

      // 4. Declare Sweet Spot using 95% threshold rule
      if (!this.stopRequested && this.tuningEpoch === epoch) {
        const sweetSpot = this.monitor.recalculateSweetSpot(workload);
        if (sweetSpot) {
          this.log('SCALABILITY', `SWEET SPOT FOUND: ${sweetSpot.threads} threads (${sweetSpot.throughput.toFixed(1)} tasks/s, 95% threshold)`);
          this.setActiveThreads(sweetSpot.threads, true);
          if (this.uiCallbacks.onPhaseChange) {
            this.uiCallbacks.onPhaseChange(`Sweet spot found: ${sweetSpot.threads} threads`);
          }
          if (this.uiCallbacks.onSweetSpotFound) {
            this.uiCallbacks.onSweetSpotFound(workload, sweetSpot);
          }
        }
      }
    } finally {
      this.isTuning = false;
      this.tuningMode = null;
      if (this.uiCallbacks.onTuningEnded) {
        this.uiCallbacks.onTuningEnded(this.stopRequested);
      }
    }
  }

  // OS Concept: Full Concurrency Sweep
  // Evaluates N = 1, 2, 3, 4, 6, 8, 10, 12, 16 (filtered by maxThreads)
  async runFullSweep() {
    if (this.isTuning) return;
    this.isTuning = true;
    this.tuningMode = 'sweep';
    this.stopRequested = false;
    const epoch = ++this.tuningEpoch;
    const workload = this.currentWorkload;

    this.log('SCALABILITY', `Starting Full Sweep on [${workload.toUpperCase()}] workload`);

    try {
      const candidates = [1, 2, 3, 4, 6, 8, 10, 12, 16].filter((n) => n <= this.maxThreads);
      let prevResult = null;

      for (const n of candidates) {
        if (this.stopRequested || this.tuningEpoch !== epoch) break;

        const result = await this.measurePoint(n, workload, epoch);
        if (!result || this.stopRequested || this.tuningEpoch !== epoch) break;

        if (prevResult && result.throughput < prevResult.throughput * 0.95) {
          const dropPct = Math.round(((prevResult.throughput - result.throughput) / prevResult.throughput) * 100);
          this.log('CONTEXT SWITCH', `Throughput decreased ${dropPct}% at ${n} threads`);
        }
        prevResult = result;
      }

      if (!this.stopRequested && this.tuningEpoch === epoch) {
        const sweetSpot = this.monitor.recalculateSweetSpot(workload);
        if (sweetSpot) {
          this.log('SCALABILITY', `Sweep complete. SWEET SPOT: ${sweetSpot.threads} threads (${sweetSpot.throughput.toFixed(1)} tasks/s)`);
          this.setActiveThreads(sweetSpot.threads, true);
          if (this.uiCallbacks.onPhaseChange) {
            this.uiCallbacks.onPhaseChange(`Sweet spot found: ${sweetSpot.threads} threads`);
          }
          if (this.uiCallbacks.onSweetSpotFound) {
            this.uiCallbacks.onSweetSpotFound(workload, sweetSpot);
          }
        }
      }
    } finally {
      this.isTuning = false;
      this.tuningMode = null;
      if (this.uiCallbacks.onTuningEnded) {
        this.uiCallbacks.onTuningEnded(this.stopRequested);
      }
    }
  }

  // Stop active tuning operation immediately
  stop() {
    if (this.isTuning) {
      this.stopRequested = true;
      this.tuningEpoch++;
      this.currentMeasurementId = null;
      this.monitor.stopMeasurementWindow();
      this.log('THREAD POOL', `Operation stopped by user`);
    }
  }

  // Reset active workload state and active thread count to 1
  reset() {
    this.stop();
    this.flushLockState();
    this.monitor.clearWorkload(this.currentWorkload);
    this.setActiveThreads(1, true);
    this.log('THREAD POOL', `Reset: Active workers set to 1, curve cleared for [${this.currentWorkload.toUpperCase()}]`);
  }
}
