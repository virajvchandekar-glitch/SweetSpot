/**
 * SweetSpot - UI Rendering & Canvas Chart Engine
 *
 * Visual Rules:
 * - Palette: Paper (#F4F1EA), Ink (#14110F), Signal Orange (#FF5B1F), Light Grey (#D9D4C7)
 * - 2.5px solid ink borders, 5px hard offset shadow, corner radius <= 4px
 * - Fonts: Archivo Black for big numerals & headings; IBM Plex Mono for data & logs
 * - Canvas chart drawn purely with HTML5 2D Context API (zero external charting libraries)
 */

class UI {
  constructor() {
    // DOM Elements Cache
    this.chartCanvas = document.getElementById('sweetspot-chart');
    this.ctx = this.chartCanvas ? this.chartCanvas.getContext('2d') : null;

    // Stat blocks
    this.statActiveThreads = document.getElementById('stat-active-threads');
    this.statSweetSpot = document.getElementById('stat-sweet-spot');
    this.statPeakThroughput = document.getElementById('stat-peak-throughput');
    this.statEfficiency = document.getElementById('stat-efficiency');
    this.cpuCoresLabel = document.getElementById('cpu-cores-label');

    // Controls & Status
    this.stepperVal = document.getElementById('stepper-val');
    this.btnStepMinus = document.getElementById('btn-step-minus');
    this.btnStepPlus = document.getElementById('btn-step-plus');
    this.phaseBanner = document.getElementById('phase-banner');
    this.workloadDesc = document.getElementById('workload-desc');
    this.btnAutoTune = document.getElementById('btn-auto-tune');
    this.btnFullSweep = document.getElementById('btn-full-sweep');
    this.btnStop = document.getElementById('btn-stop');
    this.btnReset = document.getElementById('btn-reset');
    this.btnRunDemo = document.getElementById('btn-run-demo');
    this.maxThreadsSelect = document.getElementById('select-max-threads');

    // Containers
    this.threadBarsContainer = document.getElementById('thread-bars-grid');
    this.logConsole = document.getElementById('log-console');

    // Internal state & cache
    this.cachedChartData = { points: [], sweetSpot: null, maxThreads: 16, activePoint: null };
    this.threadBarElements = new Map(); // workerId -> { col, bar, tag }
    this.redrawCallback = null;

    // Workload descriptions
    this.workloadDescriptions = {
      cpu: 'Pure CPU compute (~30ms prime search). Throughput rises, saturates available cores, then plateaus.',
      io: 'Simulated I/O wait (~80ms sleep + 1.5ms CPU). Non-blocking waits allow high scaling across many threads.',
      contended: 'Shared critical section guarded by FIFO mutex. Contention model causes queue convoys and throughput collapse.'
    };

    this.initCanvasResize();
  }

  setRedrawCallback(cb) {
    this.redrawCallback = cb;
  }

  // Handle Retina / High-DPI Canvas scaling
  initCanvasResize() {
    if (!this.chartCanvas) return;
    const resizeObserver = new ResizeObserver(() => {
      this.resizeCanvas();
      if (this.redrawCallback) {
        this.redrawCallback();
      } else {
        const { points, sweetSpot, maxThreads, activePoint } = this.cachedChartData;
        this.drawChart(points, sweetSpot, maxThreads, activePoint);
      }
    });
    resizeObserver.observe(this.chartCanvas.parentElement);
  }

  resizeCanvas() {
    if (!this.chartCanvas) return;
    const rect = this.chartCanvas.parentElement.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const width = Math.max(280, rect.width - 40);
    const height = Math.max(280, rect.height - 40);

    this.chartCanvas.width = width * dpr;
    this.chartCanvas.height = height * dpr;
    this.chartCanvas.style.width = `${width}px`;
    this.chartCanvas.style.height = `${height}px`;

    this.ctx.resetTransform?.();
    this.ctx.scale(dpr, dpr);
  }

  // Update Top Stat Numbers
  updateStats(activeThreads, sweetSpot, peakThroughput, efficiency) {
    if (this.statActiveThreads) {
      this.statActiveThreads.textContent = activeThreads;
    }
    if (this.stepperVal) {
      this.stepperVal.textContent = activeThreads;
    }
    if (this.statSweetSpot) {
      this.statSweetSpot.textContent = sweetSpot ? `${sweetSpot.threads} THREADS` : '--';
      if (sweetSpot) {
        this.statSweetSpot.classList.add('highlight-orange');
      } else {
        this.statSweetSpot.classList.remove('highlight-orange');
      }
    }
    if (this.statPeakThroughput) {
      this.statPeakThroughput.textContent = peakThroughput > 0 ? `${peakThroughput.toFixed(1)} /s` : '--';
    }
    if (this.statEfficiency) {
      this.statEfficiency.textContent = efficiency > 0 ? `${efficiency.toFixed(1)} /s/th` : '--';
    }
  }

  setCpuCoresNote(cores) {
    if (this.cpuCoresLabel) {
      const detected = cores || '4 (fallback)';
      this.cpuCoresLabel.textContent = `CPU cores: ${detected} (navigator.hardwareConcurrency)`;
    }
  }

  setWorkloadTab(workload) {
    document.querySelectorAll('.tab-btn').forEach((btn) => {
      if (btn.dataset.workload === workload) {
        btn.classList.add('tab-active');
      } else {
        btn.classList.remove('tab-active');
      }
    });

    if (this.workloadDesc) {
      this.workloadDesc.textContent = this.workloadDescriptions[workload] || '';
    }
  }

  setPhase(text) {
    if (this.phaseBanner) {
      this.phaseBanner.textContent = text ? text.toUpperCase() : 'READY';
    }
  }

  setTuningControlsState(isTuning) {
    if (this.btnAutoTune) this.btnAutoTune.disabled = isTuning;
    if (this.btnFullSweep) this.btnFullSweep.disabled = isTuning;
    if (this.btnRunDemo) this.btnRunDemo.disabled = isTuning;
    if (this.maxThreadsSelect) this.maxThreadsSelect.disabled = isTuning;
    if (this.btnStepMinus) this.btnStepMinus.disabled = isTuning;
    if (this.btnStepPlus) this.btnStepPlus.disabled = isTuning;
    if (this.btnStop) this.btnStop.disabled = !isTuning;
    // Reset remains enabled so user can always reset
    if (this.btnReset) this.btnReset.disabled = false;
  }

  // Build Thread Bars UI
  renderThreadBars(workers, maxThreads) {
    if (!this.threadBarsContainer) return;
    this.threadBarsContainer.innerHTML = '';
    this.threadBarElements.clear();

    workers.forEach((w) => {
      const col = document.createElement('div');
      col.className = 'thread-bar-col';
      col.title = `Worker Thread T${w.id}`;

      const bar = document.createElement('div');
      bar.className = `thread-bar-fill bar-${w.status}`;

      const label = document.createElement('div');
      label.className = 'thread-bar-label';
      label.textContent = `T${w.id}`;

      const tag = document.createElement('div');
      tag.className = 'thread-bar-tag';
      tag.textContent = this.formatStatusTag(w.status);

      col.appendChild(bar);
      col.appendChild(label);
      col.appendChild(tag);

      this.threadBarsContainer.appendChild(col);
      this.threadBarElements.set(w.id, { col, bar, tag });
    });
  }

  formatStatusTag(status) {
    switch (status) {
      case 'running': return 'RUN';
      case 'idle': return 'IDLE';
      case 'parked': return 'PARK';
      case 'waiting_lock': return 'WAIT';
      case 'critical_section': return 'LOCK';
      default: return 'IDLE';
    }
  }

  updateThreadBarState(workerId, status) {
    const entry = this.threadBarElements.get(workerId);
    if (!entry) return;

    entry.bar.className = `thread-bar-fill bar-${status}`;
    entry.tag.textContent = this.formatStatusTag(status);
  }

  // Append OS Concept Log
  appendLog(concept, message) {
    if (!this.logConsole) return;

    const line = document.createElement('div');
    line.className = 'log-line';

    const now = new Date();
    const time = now.toTimeString().split(' ')[0] + '.' + String(now.getMilliseconds()).padStart(3, '0');

    const timeSpan = document.createElement('span');
    timeSpan.className = 'log-time';
    timeSpan.textContent = `[${time}] `;

    const tagSpan = document.createElement('span');
    tagSpan.className = `log-tag tag-${concept.toLowerCase().replace(/[^a-z0-9]/g, '-')}`;
    tagSpan.textContent = `[${concept}] `;

    const msgSpan = document.createElement('span');
    msgSpan.className = 'log-msg';
    msgSpan.textContent = message;

    line.appendChild(timeSpan);
    line.appendChild(tagSpan);
    line.appendChild(msgSpan);

    this.logConsole.appendChild(line);

    // Limit log lines to 150 entries
    while (this.logConsole.children.length > 150) {
      this.logConsole.removeChild(this.logConsole.firstChild);
    }

    // Auto-scroll to bottom
    this.logConsole.scrollTop = this.logConsole.scrollHeight;
  }

  // Draw Manual Canvas Chart
  // Visuals: Neo-brutalist (Paper #F4F1EA, Ink #14110F, Light Grey #D9D4C7, Orange #FF5B1F)
  drawChart(points = [], sweetSpot = null, maxThreads = 16, activePoint = null) {
    this.cachedChartData = { points, sweetSpot, maxThreads, activePoint };

    if (!this.ctx || !this.chartCanvas) return;
    const ctx = this.ctx;
    const rect = this.chartCanvas.getBoundingClientRect();
    const w = rect.width;
    const h = rect.height;

    // Clear background to paper
    ctx.fillStyle = '#F4F1EA';
    ctx.fillRect(0, 0, w, h);

    const padLeft = 65;
    const padRight = 35;
    const padTop = 45;
    const padBottom = 45;

    const plotW = w - padLeft - padRight;
    const plotH = h - padTop - padBottom;

    if (plotW <= 0 || plotH <= 0) return;

    // Axis bounds
    const maxN = Math.max(maxThreads || 16, 16);
    let maxY = 50;
    if (points && points.length > 0) {
      const highest = Math.max(...points.map((p) => p.throughput || 0));
      maxY = Math.max(50, Math.ceil((highest * 1.25) / 25) * 25);
    }

    const getX = (threads) => padLeft + ((threads - 1) / (maxN - 1)) * plotW;
    const getY = (throughput) => padTop + plotH - ((throughput || 0) / maxY) * plotH;

    // 1. Grid Lines (Light Grey #D9D4C7)
    ctx.lineWidth = 1;
    ctx.strokeStyle = '#D9D4C7';

    // Horizontal Y Grid lines
    const ySteps = 5;
    ctx.font = '11px "IBM Plex Mono", monospace';
    ctx.fillStyle = '#14110F';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';

    for (let i = 0; i <= ySteps; i++) {
      const val = Math.round((maxY / ySteps) * i);
      const yPos = getY(val);

      ctx.beginPath();
      ctx.moveTo(padLeft, yPos);
      ctx.lineTo(padLeft + plotW, yPos);
      ctx.stroke();

      ctx.fillText(`${val}`, padLeft - 10, yPos);
    }

    // Vertical X Grid lines (every 2 threads up to maxN)
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (let t = 2; t <= maxN; t += 2) {
      const xPos = getX(t);
      ctx.beginPath();
      ctx.moveTo(xPos, padTop);
      ctx.lineTo(xPos, padTop + plotH);
      ctx.stroke();

      ctx.fillText(`T${t}`, xPos, padTop + plotH + 8);
    }
    // Also mark T1
    ctx.fillText('T1', getX(1), padTop + plotH + 8);

    // 2. Axes (2.5px solid Ink #14110F)
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = '#14110F';
    ctx.beginPath();
    // Y Axis
    ctx.moveTo(padLeft, padTop - 10);
    ctx.lineTo(padLeft, padTop + plotH);
    // X Axis
    ctx.lineTo(padLeft + plotW + 10, padTop + plotH);
    ctx.stroke();

    // Axis Labels
    ctx.font = '700 11px "IBM Plex Mono", monospace';
    ctx.fillStyle = '#14110F';
    ctx.textAlign = 'center';
    ctx.fillText('THREADS (CONCURRENCY)', padLeft + plotW / 2, padTop + plotH + 28);

    // Y Axis label rotated
    ctx.save();
    ctx.translate(18, padTop + plotH / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText('THROUGHPUT (TASKS / SEC)', 0, 0);
    ctx.restore();

    // 3. Sweet Spot Indicator (Vertical dashed orange line + badge)
    if (sweetSpot && sweetSpot.threads) {
      const ssX = getX(sweetSpot.threads);

      ctx.save();
      ctx.setLineDash([5, 4]);
      ctx.strokeStyle = '#FF5B1F';
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.moveTo(ssX, padTop);
      ctx.lineTo(ssX, padTop + plotH);
      ctx.stroke();
      ctx.restore();

      // Sweet Spot Badge at top
      ctx.fillStyle = '#FF5B1F';
      const labelText = `SWEET SPOT: ${sweetSpot.threads} THREADS`;
      ctx.font = '700 11px "IBM Plex Mono", monospace';
      const textWidth = ctx.measureText(labelText).width;
      const badgeW = textWidth + 14;
      const badgeH = 22;
      const badgeX = Math.max(padLeft, Math.min(padLeft + plotW - badgeW, ssX - badgeW / 2));
      const badgeY = padTop - 30;

      // Neo-brutalist offset shadow
      ctx.fillStyle = '#14110F';
      ctx.fillRect(badgeX + 3, badgeY + 3, badgeW, badgeH);

      // Badge body
      ctx.fillStyle = '#FF5B1F';
      ctx.fillRect(badgeX, badgeY, badgeW, badgeH);
      ctx.lineWidth = 2;
      ctx.strokeStyle = '#14110F';
      ctx.strokeRect(badgeX, badgeY, badgeW, badgeH);

      // Badge text
      ctx.fillStyle = '#14110F';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(labelText, badgeX + badgeW / 2, badgeY + badgeH / 2);
    }

    // 4. Data Line & Points (Ink #14110F)
    if (points && points.length > 0) {
      // Draw connecting line
      ctx.beginPath();
      ctx.lineWidth = 3;
      ctx.strokeStyle = '#14110F';

      points.forEach((p, index) => {
        const px = getX(p.threads);
        const py = getY(p.throughput);
        if (index === 0) {
          ctx.moveTo(px, py);
        } else {
          ctx.lineTo(px, py);
        }
      });
      ctx.stroke();

      // Draw points
      points.forEach((p) => {
        const px = getX(p.threads);
        const py = getY(p.throughput);
        const isSweet = sweetSpot && p.threads === sweetSpot.threads;

        ctx.beginPath();
        ctx.arc(px, py, isSweet ? 7 : 5, 0, Math.PI * 2);
        ctx.fillStyle = isSweet ? '#FF5B1F' : '#14110F';
        ctx.fill();
        ctx.lineWidth = 2.5;
        ctx.strokeStyle = '#14110F';
        ctx.stroke();

        // Print value above point
        ctx.font = '700 10px "IBM Plex Mono", monospace';
        ctx.fillStyle = isSweet ? '#FF5B1F' : '#14110F';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'bottom';
        ctx.fillText(`${p.throughput.toFixed(1)}`, px, py - 8);
      });
    }

    // 5. Highlight Current Test Point (if active)
    if (activePoint) {
      const hx = getX(activePoint.threads);
      const hy = getY(activePoint.throughput);

      ctx.beginPath();
      ctx.arc(hx, hy, 10, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255, 91, 31, 0.4)';
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = '#FF5B1F';
      ctx.stroke();
    }
  }
}
