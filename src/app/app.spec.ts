import {
  Component, OnInit, AfterViewInit, ViewChild,
  ElementRef, OnDestroy, ChangeDetectorRef, NgZone
} from '@angular/core';
import { Chart, registerables } from 'chart.js';
Chart.register(...registerables);

@Component({
  selector: 'app-root',
  templateUrl: './app.component.html',
  styleUrls: ['./app.component.scss']
})
export class AppComponent implements OnInit, AfterViewInit, OnDestroy {

  // ── Parameters ───────────────────────────────────────────────
  rpm = 3000;
  numHarmonics = 5;
  samplingRate = 5000;
  duration = 2.0;
  noiseLevel = 0.1;
  amplitudes: number[] = Array.from({ length: 10 }, (_, i) => +(1 / (i + 1)).toFixed(2));
  fourierTerms = 10;

  // ── State ────────────────────────────────────────────────────
  simulated = false;
  activeTab = 0;
  isCalculating = false;

  // ── Computed stats ───────────────────────────────────────────
  get frequency(): number { return +(this.rpm / 60).toFixed(3); }
  dominantFreq = 0;
  totalPower = 0;
  bandwidth = 0;
  mseError = 0;
  harmonicsTable: any[] = [];
  proj50Mag = '—';
  proj150Mag = '—';

  // ── Canvas refs ──────────────────────────────────────────────
  @ViewChild('c_signal')     c_signal!:     ElementRef<HTMLCanvasElement>;
  @ViewChild('c_fft')        c_fft!:        ElementRef<HTMLCanvasElement>;
  @ViewChild('c_harmonics')  c_harmonics!:  ElementRef<HTMLCanvasElement>;
  @ViewChild('c_fourier')    c_fourier!:    ElementRef<HTMLCanvasElement>;
  @ViewChild('c_coef')       c_coef!:       ElementRef<HTMLCanvasElement>;
  @ViewChild('c_fftMain')    c_fftMain!:    ElementRef<HTMLCanvasElement>;
  @ViewChild('c_fftZoom')    c_fftZoom!:    ElementRef<HTMLCanvasElement>;
  @ViewChild('c_projTime')   c_projTime!:   ElementRef<HTMLCanvasElement>;
  @ViewChild('c_projFft')    c_projFft!:    ElementRef<HTMLCanvasElement>;
  @ViewChild('c_decomp')     c_decomp!:     ElementRef<HTMLCanvasElement>;

  private charts: Map<string, Chart> = new Map();
  private audioCtx: AudioContext | null = null;

  constructor(private cdr: ChangeDetectorRef, private zone: NgZone) {}

  ngOnInit() {}
  ngAfterViewInit() {}
  ngOnDestroy() { this.destroyAll(); }

  harmonicsArray(): number[] {
    return Array.from({ length: this.numHarmonics }, (_, i) => i);
  }

  // ── Simulate ─────────────────────────────────────────────────
  simulate() {
    this.isCalculating = true;
    this.simulated = true;
    this.cdr.detectChanges();
    setTimeout(() => {
      this.renderAll();
      this.isCalculating = false;
      this.cdr.detectChanges();
    }, 80);
  }

  onTabChange(i: number) {
    this.activeTab = i;
    if (this.simulated) setTimeout(() => this.renderAll(), 120);
  }

  onParamChange() {
    if (this.simulated) this.simulate();
  }

  // ── Signal generation ─────────────────────────────────────────
  private linspace(start: number, end: number, n: number): number[] {
    return Array.from({ length: n }, (_, i) => start + (i / (n - 1)) * (end - start));
  }

  private lcg(seed: number) {
    let s = seed >>> 0;
    return () => {
      s = (Math.imul(1664525, s) + 1013904223) >>> 0;
      return (s / 0xffffffff) * 2 - 1;
    };
  }

  private genSignal(t: number[], freq: number, amps: number[], noise: number, seed = 42): number[] {
    const r = this.lcg(seed);
    const s = new Array(t.length).fill(0);
    for (let h = 0; h < amps.length; h++)
      for (let i = 0; i < t.length; i++)
        s[i] += amps[h] * Math.sin(2 * Math.PI * (h + 1) * freq * t[i]);
    for (let i = 0; i < t.length; i++)
      s[i] += noise * r() * 1.8;
    return s;
  }

  private genHarmonic(t: number[], freq: number, n: number, amp: number): number[] {
    return t.map(ti => amp * Math.sin(2 * Math.PI * n * freq * ti));
  }

  // ── FFT (Cooley–Tukey radix-2) ────────────────────────────────
  private fft(re: number[], im: number[]) {
    const N = re.length;
    for (let i = 1, j = 0; i < N; i++) {
      let bit = N >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        [re[i], re[j]] = [re[j], re[i]];
        [im[i], im[j]] = [im[j], im[i]];
      }
    }
    for (let len = 2; len <= N; len <<= 1) {
      const ang = -2 * Math.PI / len;
      const wRe = Math.cos(ang), wIm = Math.sin(ang);
      for (let i = 0; i < N; i += len) {
        let cRe = 1, cIm = 0;
        for (let j = 0; j < len >> 1; j++) {
          const uR = re[i+j], uI = im[i+j];
          const vR = re[i+j+len/2]*cRe - im[i+j+len/2]*cIm;
          const vI = re[i+j+len/2]*cIm + im[i+j+len/2]*cRe;
          re[i+j] = uR+vR; im[i+j] = uI+vI;
          re[i+j+len/2] = uR-vR; im[i+j+len/2] = uI-vI;
          const nR = cRe*wRe - cIm*wIm;
          cIm = cRe*wIm + cIm*wRe; cRe = nR;
        }
      }
    }
  }

  private computeFFT(sig: number[], rate: number): { freqs: number[], mags: number[] } {
    let N = 1;
    while (N < sig.length) N <<= 1;
    const re = [...sig.slice(0, N), ...new Array(Math.max(0, N - sig.length)).fill(0)];
    const im = new Array(N).fill(0);
    this.fft(re, im);
    const half = N >> 1;
    const freqs: number[] = [], mags: number[] = [];
    for (let i = 1; i < half; i++) {
      freqs.push(i * rate / N);
      mags.push((2 / sig.length) * Math.hypot(re[i], im[i]));
    }
    return { freqs, mags };
  }

  // ── Fourier Series ────────────────────────────────────────────
  private fourierSeries(t: number[], sig: number[], terms: number) {
    const T = t[t.length-1] - t[0];
    const dt = t[1] - t[0];
    const a0 = sig.reduce((s,v) => s+v, 0) / sig.length;
    const approx = new Array(t.length).fill(a0);
    const coeffs: { n: number, mag: number }[] = [{ n: 0, mag: Math.abs(a0) }];
    for (let n = 1; n <= terms; n++) {
      const w = 2 * Math.PI * n / T;
      let an = 0, bn = 0;
      for (let i = 0; i < t.length; i++) {
        an += sig[i] * Math.cos(w * t[i]) * dt;
        bn += sig[i] * Math.sin(w * t[i]) * dt;
      }
      an *= 2/T; bn *= 2/T;
      for (let i = 0; i < t.length; i++)
        approx[i] += an*Math.cos(w*t[i]) + bn*Math.sin(w*t[i]);
      coeffs.push({ n, mag: Math.hypot(an, bn) });
    }
    const mse = sig.reduce((s,v,i) => s + (v-approx[i])**2, 0) / sig.length;
    return { approx, coeffs, mse };
  }

  // ── Chart helpers ─────────────────────────────────────────────
  private destroyAll() {
    this.charts.forEach(c => c.destroy());
    this.charts.clear();
  }

  private mkChart(ref: ElementRef<HTMLCanvasElement> | undefined, key: string, config: any): Chart | null {
    if (!ref) return null;
    const old = this.charts.get(key);
    if (old) old.destroy();
    const c = new Chart(ref.nativeElement, config);
    this.charts.set(key, c);
    return c;
  }

  private thin(arr: number[], maxPts = 1200): number[] {
    if (arr.length <= maxPts) return arr;
    const step = Math.floor(arr.length / maxPts);
    return arr.filter((_, i) => i % step === 0);
  }

  private darkOpts(xLabel: string, yLabel: string, extra: any = {}): any {
    return {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 500, easing: 'easeOutQuart' },
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { labels: { color: '#7ba3c8', font: { family: 'JetBrains Mono', size: 10 }, boxWidth: 12, padding: 16 } },
        tooltip: {
          backgroundColor: 'rgba(6,13,24,0.95)',
          borderColor: 'rgba(0,229,255,0.3)',
          borderWidth: 1,
          titleColor: '#00e5ff',
          bodyColor: '#7ba3c8',
          titleFont: { family: 'JetBrains Mono', size: 11 },
          bodyFont: { family: 'JetBrains Mono', size: 10 },
          padding: 10,
        }
      },
      scales: {
        x: {
          ticks: { color: '#3d6080', font: { family: 'JetBrains Mono', size: 9 }, maxTicksLimit: 8 },
          grid: { color: 'rgba(0,229,255,0.04)' },
          border: { color: 'rgba(0,229,255,0.1)' },
          title: { display: true, text: xLabel, color: '#3d6080', font: { family: 'Outfit', size: 10 } }
        },
        y: {
          ticks: { color: '#3d6080', font: { family: 'JetBrains Mono', size: 9 } },
          grid: { color: 'rgba(0,229,255,0.04)' },
          border: { color: 'rgba(0,229,255,0.1)' },
          title: { display: true, text: yLabel, color: '#3d6080', font: { family: 'Outfit', size: 10 } }
        },
        ...extra
      }
    };
  }

  // ── Render All ────────────────────────────────────────────────
  renderAll() {
    const N = Math.floor(this.duration * this.samplingRate);
    const t = this.linspace(0, this.duration, N);
    const amps = this.amplitudes.slice(0, this.numHarmonics);
    const sig = this.genSignal(t, this.frequency, amps, this.noiseLevel);
    const { freqs, mags } = this.computeFFT(sig, this.samplingRate);

    // Stats
    const maxI = mags.indexOf(Math.max(...mags));
    this.dominantFreq = +freqs[maxI].toFixed(2);
    this.totalPower = +mags.reduce((s,v) => s + v*v, 0).toFixed(2);
    const thr = Math.max(...mags) * 0.1;
    const bw = freqs.filter((_,i) => mags[i] > thr);
    this.bandwidth = bw.length > 1 ? +(bw[bw.length-1] - bw[0]).toFixed(2) : 0;

    this.harmonicsTable = amps.map((a, i) => {
      const ef = (i+1) * this.frequency;
      const idx = freqs.reduce((b,f,j) => Math.abs(f-ef) < Math.abs(freqs[b]-ef) ? j : b, 0);
      return { n: i+1, theoretical: ef.toFixed(2), detected: freqs[idx]?.toFixed(2)||'—', mag: mags[idx]?.toFixed(4)||'—', set: a.toFixed(3) };
    });
    this.cdr.detectChanges();

    const tT = this.thin(t); const sT = this.thin(sig);

    const colors = ['#00e5ff','#ff6b2b','#00ff88','#b347ff','#ff3366','#ffcc00','#00bfff','#ff69b4','#7fff00','#ff8c00'];

    // TAB 1 — Signal
    this.mkChart(this.c_signal, 'signal', {
      type: 'line',
      data: {
        labels: tT.map(v => v.toFixed(3)),
        datasets: [{
          label: 'Semnal vibrații',
          data: sT,
          borderColor: '#00e5ff',
          borderWidth: 1.2,
          pointRadius: 0,
          tension: 0,
          fill: true,
          backgroundColor: 'rgba(0,229,255,0.04)'
        }]
      },
      options: this.darkOpts('Timp (s)', 'Amplitudine')
    });

    // TAB 1 — FFT overview
    this.mkChart(this.c_fft, 'fft', {
      type: 'line',
      data: {
        labels: freqs.map(f => f.toFixed(1)),
        datasets: [{
          label: 'Spectru FFT',
          data: mags,
          borderColor: '#ff6b2b',
          borderWidth: 2,
          pointRadius: 0,
          fill: true,
          backgroundColor: 'rgba(255,107,43,0.08)',
          tension: 0.2
        }]
      },
      options: this.darkOpts('Frecvență (Hz)', 'Magnitudine')
    });

    // TAB 1 — Harmonics decomposition
    this.mkChart(this.c_harmonics, 'harmonics', {
      type: 'line',
      data: {
        labels: tT.map(v => v.toFixed(3)),
        datasets: amps.map((a, i) => ({
          label: `H${i+1} — ${((i+1)*this.frequency).toFixed(1)} Hz`,
          data: this.thin(this.genHarmonic(t, this.frequency, i+1, a)),
          borderColor: colors[i],
          borderWidth: 1.5,
          pointRadius: 0,
          tension: 0.1
        }))
      },
      options: this.darkOpts('Timp (s)', 'Amplitudine')
    });

    // TAB 2 — Fourier series
    const wSz = Math.floor(t.length / 4);
    const tW = t.slice(0, wSz), sW = sig.slice(0, wSz);
    const { approx, coeffs, mse } = this.fourierSeries(tW, sW, this.fourierTerms);
    this.mseError = +mse.toFixed(8);
    this.cdr.detectChanges();
    const step2 = Math.max(1, Math.floor(tW.length / 600));
    const tWT = tW.filter((_,i) => i%step2===0);
    const sWT = sW.filter((_,i) => i%step2===0);
    const aWT = approx.filter((_,i) => i%step2===0);

    this.mkChart(this.c_fourier, 'fourier', {
      type: 'line',
      data: {
        labels: tWT.map(v => v.toFixed(3)),
        datasets: [
          { label: 'Semnal original', data: sWT, borderColor: '#00e5ff', borderWidth: 1.5, pointRadius: 0 },
          { label: `Aproximare Fourier (${this.fourierTerms} termeni)`, data: aWT, borderColor: '#ff6b2b', borderWidth: 2, borderDash: [6,3], pointRadius: 0 }
        ]
      },
      options: this.darkOpts('Timp (s)', 'Amplitudine')
    });

    this.mkChart(this.c_coef, 'coef', {
      type: 'bar',
      data: {
        labels: coeffs.map(c => `n=${c.n}`),
        datasets: [{
          label: 'Magnitudine coeficient',
          data: coeffs.map(c => c.mag),
          backgroundColor: coeffs.map((_, i) => i === 0 ? 'rgba(0,229,255,0.3)' : `rgba(179,71,255,${0.3 + 0.05*Math.min(i,8)})`),
          borderColor: coeffs.map((_, i) => i === 0 ? '#00e5ff' : '#b347ff'),
          borderWidth: 1,
          borderRadius: 3
        }]
      },
      options: this.darkOpts('Armonică (n)', 'Magnitudine')
    });

    // TAB 3 — FFT detail
    this.mkChart(this.c_fftMain, 'fftMain', {
      type: 'line',
      data: {
        labels: freqs.map(f => f.toFixed(1)),
        datasets: [{
          label: 'Spectru FFT',
          data: mags,
          borderColor: '#b347ff',
          borderWidth: 2,
          pointRadius: 0,
          fill: true,
          backgroundColor: 'rgba(179,71,255,0.08)',
          tension: 0.2
        }]
      },
      options: this.darkOpts('Frecvență (Hz)', 'Magnitudine')
    });

    const maxF = this.frequency * (this.numHarmonics + 1);
    const zI = freqs.findIndex(f => f > maxF);
    this.mkChart(this.c_fftZoom, 'fftZoom', {
      type: 'line',
      data: {
        labels: freqs.slice(0, zI < 0 ? undefined : zI).map(f => f.toFixed(1)),
        datasets: [{
          label: 'Zoom armonici',
          data: mags.slice(0, zI < 0 ? undefined : zI),
          borderColor: '#00ff88',
          borderWidth: 2.5,
          pointRadius: 4,
          pointBackgroundColor: '#00ff88',
          pointBorderColor: 'transparent',
          fill: false,
          tension: 0.1
        }]
      },
      options: this.darkOpts('Frecvență (Hz)', 'Magnitudine')
    });

    // TAB 4 — Project scenario
    this.renderProject();
  }

  renderProject() {
    const N = Math.floor(2.0 * 5000);
    const t = this.linspace(0, 2.0, N);
    const s50  = this.genHarmonic(t, 50, 1, 1.0);
    const s150 = this.genHarmonic(t, 50, 3, 0.5);
    const rng  = this.lcg(123);
    const noise = t.map(() => 0.2 * rng() * 1.8);
    const proj = t.map((_,i) => s50[i] + s150[i] + noise[i]);

    const tT = this.thin(t), pT = this.thin(proj);

    this.mkChart(this.c_projTime, 'projTime', {
      type: 'line',
      data: {
        labels: tT.map(v => v.toFixed(3)),
        datasets: [{
          label: 'Semnal total (zgomot + defect)',
          data: pT,
          borderColor: '#00e5ff',
          borderWidth: 1,
          pointRadius: 0,
          fill: true,
          backgroundColor: 'rgba(0,229,255,0.04)'
        }]
      },
      options: this.darkOpts('Timp (s)', 'Amplitudine')
    });

    const { freqs, mags } = this.computeFFT(proj, 5000);
    const i50  = freqs.reduce((b,f,i) => Math.abs(f-50)  < Math.abs(freqs[b]-50)  ? i : b, 0);
    const i150 = freqs.reduce((b,f,i) => Math.abs(f-150) < Math.abs(freqs[b]-150) ? i : b, 0);
    this.proj50Mag  = mags[i50]?.toFixed(4)  || '—';
    this.proj150Mag = mags[i150]?.toFixed(4) || '—';
    this.cdr.detectChanges();

    this.mkChart(this.c_projFft, 'projFft', {
      type: 'line',
      data: {
        labels: freqs.map(f => f.toFixed(1)),
        datasets: [{
          label: 'Spectru FFT',
          data: mags,
          borderColor: '#ff6b2b',
          borderWidth: 2,
          pointRadius: 0,
          fill: true,
          backgroundColor: 'rgba(255,107,43,0.1)',
          tension: 0.15
        }]
      },
      options: {
        ...this.darkOpts('Frecvență (Hz)', 'Magnitudine'),
        scales: {
          ...this.darkOpts('Frecvență (Hz)', 'Magnitudine').scales,
          x: { ...this.darkOpts('Frecvență (Hz)', 'Magnitudine').scales.x, max: '300' }
        }
      }
    });

    // Decomposition
    const plot = 1000;
    const tP = t.slice(0, plot);
    this.mkChart(this.c_decomp, 'decomp', {
      type: 'line',
      data: {
        labels: tP.map(v => v.toFixed(3)),
        datasets: [
          { label: '50 Hz — Fundamentală', data: s50.slice(0, plot), borderColor: '#00ff88', borderWidth: 2, pointRadius: 0 },
          { label: '150 Hz — Defect dezaxare', data: s150.slice(0, plot), borderColor: '#ff6b2b', borderWidth: 2, pointRadius: 0 },
          { label: 'Zgomot White Noise', data: noise.slice(0, plot), borderColor: '#3d6080', borderWidth: 1, pointRadius: 0 },
          { label: 'Semnal Total', data: proj.slice(0, plot), borderColor: '#00e5ff', borderWidth: 1.5, pointRadius: 0 }
        ]
      },
      options: this.darkOpts('Timp (s)', 'Amplitudine')
    });
  }

  // ── Audio via Web Audio API ───────────────────────────────────
  playTone(freq: number, amp: number, dur = 1.5) {
    if (!this.audioCtx) this.audioCtx = new AudioContext();
    const ctx = this.audioCtx;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.frequency.value = Math.min(freq, 2000);
    osc.type = 'sine';
    gain.gain.setValueAtTime(amp * 0.4, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + dur);
    osc.start();
    osc.stop(ctx.currentTime + dur);
  }

  playMotorSound(healthy: boolean) {
    if (!this.audioCtx) this.audioCtx = new AudioContext();
    const ctx = this.audioCtx;
    const now = ctx.currentTime;
    const master = ctx.createGain();
    master.connect(ctx.destination);

    const freqs = healthy ? [50] : [50, 150];
    const amps  = healthy ? [0.5] : [0.5, 0.3];

    freqs.forEach((f, i) => {
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.connect(g); g.connect(master);
      osc.frequency.value = f;
      osc.type = 'sine';
      g.gain.setValueAtTime(amps[i], now);
      g.gain.exponentialRampToValueAtTime(0.001, now + 2);
      osc.start(now); osc.stop(now + 2);
    });
  }
}