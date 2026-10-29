/**
 * SweetSpot - Application Entry Point & Controller
 *
 * OS Concepts Demonstrated:
 * - Thread Pool Lifecycle: Creating, sizing, and dynamic reallocation of worker threads.
 * - Multi-Workload Scalability Comparison: CPU-bound vs. I/O-bound vs. Mutex Contention.
 * - Automated Benchmarking: Self-tuning hill climbing and full concurrency sweeps.
 */

document.addEventListener('DOMContentLoaded', () => {
  // 1. Instantiate Core Components
  const monitor = new Monitor();
  const ui = new UI();

  let isDemoActive = false;
  let scheduler = null;

  // Helper to re-render stats & canvas chart
  function refreshView(activePoint = null) {
    if (!scheduler) return;
    const points = monitor.getResults(scheduler.currentWorkload);
    const sweetSpot = monitor.getSweetSpot(scheduler.currentWorkload);
    const peak = monitor.getPeakThroughput(scheduler.currentWorkload);

    // Efficiency is derived strictly from actual measurements, never guessed
    let efficiency = 0;
    if (points.length > 0) {
      const currentPoint = points.find((p) => p.threads === scheduler.activeThreads);
      if (currentPoint) {
        efficiency = currentPoint.efficiency;
      } else if (sweetSpot && sweetSpot.threads === scheduler.activeThreads) {
        efficiency = sweetSpot.efficiency;
      }
    }

    ui.updateStats(scheduler.activeThreads, sweetSpot, peak, efficiency);
    ui.drawChart(points, sweetSpot, scheduler.maxThreads, activePoint);
  }

  // Bind chart redraw callback for resize events
  ui.setRedrawCallback(refreshView);

  // UI Callback hooks for Scheduler events
  const schedulerCallbacks = {
    onLog: (concept, message) => {
      ui.appendLog(concept, message);
    },
    onThreadStateChange: (workerId, status) => {
      ui.updateThreadBarState(workerId, status);
    },
    onPoolRecreated: (workers, maxThreads) => {
      ui.renderThreadBars(workers, maxThreads);
      refreshView();
    },
    onActiveThreadsChanged: (count) => {
      refreshView();
    },
    onPhaseChange: (phaseText) => {
      ui.setPhase(phaseText);
    },
    onPointMeasured: (workload, result) => {
      refreshView(result);
    },
    onSweetSpotFound: (workload, sweetSpot) => {
      refreshView();
    },
    onTuningEnded: (wasStopped) => {
      ui.setTuningControlsState(false);
      if (wasStopped) {
        ui.setPhase('Tuning stopped');
      } else {
        const sweetSpot = monitor.getSweetSpot(scheduler.currentWorkload);
        if (sweetSpot) {
          ui.setPhase(`Sweet spot found: ${sweetSpot.threads} threads`);
        } else {
          ui.setPhase('Ready');
        }
      }
      refreshView();
    }
  };

  scheduler = new Scheduler(monitor, schedulerCallbacks);

  // Initialize UI with hardware context
  ui.setCpuCoresNote(scheduler.hwConcurrency);

  // Ensure select element has an option matching calculated maxThreads
  if (ui.maxThreadsSelect) {
    const hasOption = Array.from(ui.maxThreadsSelect.options).some(
      (opt) => opt.value === String(scheduler.maxThreads)
    );
    if (!hasOption) {
      const opt = document.createElement('option');
      opt.value = String(scheduler.maxThreads);
      opt.textContent = String(scheduler.maxThreads);
      ui.maxThreadsSelect.appendChild(opt);
    }
    ui.maxThreadsSelect.value = String(scheduler.maxThreads);
  }

  ui.renderThreadBars(scheduler.workers, scheduler.maxThreads);
  ui.setWorkloadTab(scheduler.currentWorkload);
  ui.setPhase('Ready');
  refreshView();

  // Workload Tab Switching
  async function switchWorkload(workload, allowRetune = true) {
    if (scheduler.currentWorkload === workload) return;

    if (scheduler.isTuning && !isDemoActive) {
      scheduler.stop();
      // Brief yield to allow current measurement to unwind cleanly
      let waitCount = 0;
      while (scheduler.isTuning && waitCount++ < 10) {
        await scheduler.sleep(50);
      }
    }

    const prevWorkload = scheduler.currentWorkload;
    const hadSweetSpot = monitor.getSweetSpot(prevWorkload) !== null;

    scheduler.setWorkload(workload);
    ui.setWorkloadTab(workload);
    refreshView();

    // OS Concept: Re-tune trigger
    // When switching workloads while a sweet spot exists, automatically start Auto Tune
    if (allowRetune && hadSweetSpot && !scheduler.isTuning && !isDemoActive) {
      ui.appendLog('SCALABILITY', `[RE-TUNE] Sweet spot existed on previous tab. Auto-tuning new [${workload.toUpperCase()}] workload...`);
      startAutoTune();
    }
  }

  // Bind Workload Tabs
  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const workload = btn.dataset.workload;
      if (workload) {
        switchWorkload(workload, true);
      }
    });
  });

  // Action: Auto Tune
  function startAutoTune() {
    if (scheduler.isTuning) return;
    ui.setTuningControlsState(true);
    scheduler.runAutoTune().catch((err) => {
      console.error('Auto tune error:', err);
      ui.setTuningControlsState(false);
      ui.setPhase('Error during tuning');
    });
  }

  if (ui.btnAutoTune) {
    ui.btnAutoTune.addEventListener('click', () => {
      startAutoTune();
    });
  }

  // Action: Full Sweep
  if (ui.btnFullSweep) {
    ui.btnFullSweep.addEventListener('click', () => {
      if (scheduler.isTuning) return;
      ui.setTuningControlsState(true);
      scheduler.runFullSweep().catch((err) => {
        console.error('Full sweep error:', err);
        ui.setTuningControlsState(false);
        ui.setPhase('Error during sweep');
      });
    });
  }

  // Action: Stop
  if (ui.btnStop) {
    ui.btnStop.addEventListener('click', () => {
      isDemoActive = false;
      scheduler.stop();
      ui.setTuningControlsState(false);
      ui.setPhase('Tuning stopped');
    });
  }

  // Action: Reset
  if (ui.btnReset) {
    ui.btnReset.addEventListener('click', () => {
      isDemoActive = false;
      scheduler.reset();
      ui.setTuningControlsState(false);
      ui.setPhase('Ready');
      refreshView();
    });
  }

  // Action: Manual Stepper (+ / -)
  if (ui.btnStepMinus) {
    ui.btnStepMinus.addEventListener('click', () => {
      if (scheduler.isTuning) return;
      if (scheduler.activeThreads > 1) {
        scheduler.setActiveThreads(scheduler.activeThreads - 1, true);
      }
    });
  }

  if (ui.btnStepPlus) {
    ui.btnStepPlus.addEventListener('click', () => {
      if (scheduler.isTuning) return;
      if (scheduler.activeThreads < scheduler.maxThreads) {
        scheduler.setActiveThreads(scheduler.activeThreads + 1, true);
      }
    });
  }

  // Action: Max Threads Selector
  if (ui.maxThreadsSelect) {
    ui.maxThreadsSelect.addEventListener('change', (e) => {
      if (scheduler.isTuning) scheduler.stop();
      const newMax = parseInt(e.target.value, 10);
      if (newMax >= 4 && newMax <= 16) {
        scheduler.createPool(newMax);
      }
    });
  }

  // Action: Run Demo (CPU -> I/O -> Contended)
  if (ui.btnRunDemo) {
    ui.btnRunDemo.addEventListener('click', async () => {
      if (scheduler.isTuning) return;
      isDemoActive = true;
      ui.setTuningControlsState(true);

      ui.appendLog('SCALABILITY', '==================================================');
      ui.appendLog('SCALABILITY', 'RUN DEMO: Automated 3-Phase Workload Benchmark');
      ui.appendLog('SCALABILITY', '==================================================');

      try {
        // Phase 1: CPU-BOUND
        await switchWorkload('cpu', false);
        ui.appendLog('THREAD POOL', 'DEMO PART 1/3: CPU-BOUND WORKLOAD (Testing compute limits)');
        await scheduler.runAutoTune();
        if (scheduler.stopRequested || !isDemoActive) return;

        await scheduler.sleep(800);

        // Phase 2: I/O-BOUND
        await switchWorkload('io', false);
        ui.appendLog('THREAD POOL', 'DEMO PART 2/3: I/O-BOUND WORKLOAD (Testing concurrency scaling)');
        await scheduler.runAutoTune();
        if (scheduler.stopRequested || !isDemoActive) return;

        await scheduler.sleep(800);

        // Phase 3: CONTENDED
        await switchWorkload('contended', false);
        ui.appendLog('THREAD POOL', 'DEMO PART 3/3: CONTENDED WORKLOAD (Testing lock contention & convoy)');
        await scheduler.runAutoTune();
        if (scheduler.stopRequested || !isDemoActive) return;

        ui.appendLog('SCALABILITY', 'DEMO COMPLETE! All 3 workload curves are cached.');
        ui.appendLog('SCALABILITY', 'Click CPU-BOUND, I/O-BOUND, and CONTENDED tabs to compare curves.');
        ui.setPhase('Demo complete. Switch tabs to inspect stored curves.');
      } finally {
        isDemoActive = false;
        ui.setTuningControlsState(false);
        refreshView();
      }
    });
  }
});
