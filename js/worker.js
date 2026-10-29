/**
 * SweetSpot - Web Worker Script
 *
 * OS Concepts Demonstrated:
 * - Thread Pool: Worker threads spawned once, kept alive, and reused across tasks.
 * - Mutex & Critical Section: Mutual exclusion via explicit message-passing lock protocol.
 * - Context Switching & CPU Bound Work: Heavy computation competing for CPU time slices.
 * - Producer-Consumer Task Execution: Consumes tasks dispatched from scheduler queue.
 */

let workerId = null;
let currentTaskId = null;
let pendingLockResolve = null;

// OS Concept: Real CPU-Bound Computational Workload (Prime Number Calculation)
// Saturates arithmetic logic units (ALU), branch predictors, and cache memory.
function countPrimes(durationMs) {
  const start = performance.now();
  let count = 0;
  let candidate = 2;

  while (performance.now() - start < durationMs) {
    let isPrime = true;
    for (let factor = 2; factor * factor <= candidate; factor++) {
      if (candidate % factor === 0) {
        isPrime = false;
        break;
      }
    }
    if (isPrime) count++;
    candidate++;
  }
  return count;
}

// OS Concept: Worker message handler (Producer-Consumer Task Dispatch)
self.onmessage = async function(e) {
  const data = e.data;
  if (!data) return;

  // Initial worker handshake
  if (data.type === 'init') {
    workerId = data.workerId;
    self.postMessage({ type: 'ready', workerId });
    return;
  }

  // OS Concept: Mutex Grant - Scheduler unblocks this waiting thread
  if (data.type === 'lock-granted') {
    if (pendingLockResolve) {
      pendingLockResolve(data.overheadMs || 0);
      pendingLockResolve = null;
    }
    return;
  }

  // Safe task cancellation / pool reset (prevents deadlocks on abrupt reset)
  if (data.type === 'cancel-task' || data.type === 'reset') {
    if (pendingLockResolve) {
      pendingLockResolve(0);
      pendingLockResolve = null;
    }
    currentTaskId = null;
    self.postMessage({ type: 'status-change', workerId, status: 'idle' });
    return;
  }

  // Task execution entry point
  if (data.type === 'start-task') {
    const task = data.task;
    currentTaskId = task.id;
    const taskStart = performance.now();

    // Telemetry: Thread state transitions from IDLE to RUNNING
    self.postMessage({ type: 'status-change', workerId, status: 'running', taskId: task.id });

    if (task.workloadType === 'cpu') {
      /*
       * OS Concept: CPU-BOUND Workload
       * Consumes real CPU cycles (~30ms pure compute).
       * Throughput scales until hardware cores (navigator.hardwareConcurrency)
       * are saturated; thereafter, OS time-slicing and context switching plateau throughput.
       */
      countPrimes(30);

    } else if (task.workloadType === 'io') {
      /*
       * OS Concept: I/O-BOUND Workload
       * Simulates blocking I/O (disk read or network fetch) via setTimeout (~80ms)
       * alongside a tiny CPU processing slice (~1.5ms).
       * Non-blocking sleep allows high thread concurrency scaling without saturating cores.
       */
      countPrimes(1.5);
      await new Promise((resolve) => setTimeout(resolve, 80));

    } else if (task.workloadType === 'contended') {
      /*
       * OS Concept: CONTENDED Workload & Critical Section
       * Tasks perform private CPU work (~15ms), then must synchronize on a shared
       * mutex before entering the critical section (~10ms).
       */
      // Step 1: Independent pre-critical CPU work
      countPrimes(15);

      // Step 2: Request Mutex Lock from Scheduler
      // OS Concept: Mutex Lock Acquisition
      self.postMessage({ type: 'status-change', workerId, status: 'waiting_lock', taskId: task.id });
      self.postMessage({ type: 'lock-request', workerId, taskId: task.id });

      // Await exclusive permission from Scheduler's FIFO lock manager
      const overheadMs = await new Promise((resolve) => {
        pendingLockResolve = resolve;
      });

      // Step 3: Enter Critical Section
      // OS Concept: Critical Section
      /*
       * NOTE: The coordination overhead term (1.5ms * waiting workers) is a MODEL,
       * not a measurement. It mathematically simulates real multi-core phenomena:
       * lock convoying, kernel thread descheduling, and CPU L1/L2 cache line bouncing.
       */
      self.postMessage({ type: 'status-change', workerId, status: 'critical_section', taskId: task.id });
      countPrimes(10 + overheadMs);

      // Step 4: Release Mutex Lock
      // OS Concept: Mutex Unlock
      self.postMessage({ type: 'unlock', workerId, taskId: task.id });
    }

    const duration = performance.now() - taskStart;
    self.postMessage({
      type: 'task-complete',
      workerId,
      taskId: task.id,
      workloadType: task.workloadType,
      measurementId: task.measurementId,
      duration
    });

    currentTaskId = null;
  }
};
