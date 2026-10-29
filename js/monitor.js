/**
 * SweetSpot - Performance Monitor & Metrics Store
 *
 * OS Concepts Demonstrated:
 * - Throughput: Completed tasks per unit of wall-clock time (Tasks / Second).
 * - Efficiency: Scalability metric representing throughput per active thread (Throughput / N).
 * - Scalability & Amdahl's Law: System capacity to scale throughput as compute resources grow.
 */

class Monitor {
  constructor() {
    // Independent measurement histories for cpu, io, and contended workloads
    this.curves = {
      cpu: [],
      io: [],
      contended: []
    };

    // Stored sweet spot per workload
    this.sweetSpots = {
      cpu: null,
      io: null,
      contended: null
    };

    // Active measurement window state
    this.activeWindow = null; // { workload, threads, measurementId, taskCount }
  }

  // OS Concept: Measurement Window Start
  // Guarantees only tasks dispatched during this specific window are counted
  startMeasurementWindow(workload, threads, measurementId) {
    this.activeWindow = {
      workload,
      threads,
      measurementId,
      taskCount: 0,
      startTime: performance.now()
    };
  }

  // OS Concept: Throughput Sampling (Anti-leak filter)
  // Rejects tasks completed from warm-up or mismatched measurement sessions
  recordTaskCompletion(workload, measurementId) {
    if (
      this.activeWindow &&
      this.activeWindow.workload === workload &&
      this.activeWindow.measurementId === measurementId
    ) {
      this.activeWindow.taskCount++;
    }
  }

  stopMeasurementWindow() {
    if (!this.activeWindow) return 0;
    const count = this.activeWindow.taskCount;
    this.activeWindow = null;
    return count;
  }

  // Store a measured point for a given workload
  addResult(workload, threads, throughput, efficiency) {
    if (!this.curves[workload]) {
      this.curves[workload] = [];
    }

    const existingIndex = this.curves[workload].findIndex((p) => p.threads === threads);
    const point = {
      threads,
      throughput: Number(throughput.toFixed(2)),
      efficiency: Number(efficiency.toFixed(2)),
      timestamp: Date.now()
    };

    if (existingIndex >= 0) {
      this.curves[workload][existingIndex] = point;
    } else {
      this.curves[workload].push(point);
    }

    // Keep points sorted by thread count
    this.curves[workload].sort((a, b) => a.threads - b.threads);

    // Recalculate sweet spot with updated data
    this.recalculateSweetSpot(workload);

    return point;
  }

  // OS Concept: Scalability & Sweet Spot Analysis
  // Sweet Spot = smallest measured N whose throughput is at least 95% of peak throughput
  recalculateSweetSpot(workload) {
    const points = this.curves[workload] || [];
    if (points.length === 0) {
      this.sweetSpots[workload] = null;
      return null;
    }

    let peak = 0;
    for (const p of points) {
      if (p.throughput > peak) {
        peak = p.throughput;
      }
    }

    if (peak <= 0) {
      this.sweetSpots[workload] = null;
      return null;
    }

    // Threshold: 95% of peak throughput
    const threshold = peak * 0.95;
    const qualified = points.filter((p) => p.throughput >= threshold);

    // Pick smallest thread count among qualified candidates
    qualified.sort((a, b) => a.threads - b.threads);
    const sweetSpot = qualified[0];

    this.sweetSpots[workload] = {
      threads: sweetSpot.threads,
      throughput: sweetSpot.throughput,
      efficiency: sweetSpot.efficiency,
      peakThroughput: peak
    };

    return this.sweetSpots[workload];
  }

  getSweetSpot(workload) {
    return this.sweetSpots[workload] || null;
  }

  getPeakThroughput(workload) {
    const points = this.curves[workload] || [];
    if (points.length === 0) return 0;
    return Math.max(...points.map((p) => p.throughput));
  }

  getResults(workload) {
    return this.curves[workload] || [];
  }

  hasResults(workload) {
    return (this.curves[workload] || []).length > 0;
  }

  clearWorkload(workload) {
    this.curves[workload] = [];
    this.sweetSpots[workload] = null;
    if (this.activeWindow && this.activeWindow.workload === workload) {
      this.activeWindow = null;
    }
  }

  clearAll() {
    this.curves = { cpu: [], io: [], contended: [] };
    this.sweetSpots = { cpu: null, io: null, contended: null };
    this.activeWindow = null;
  }
}
