import {
  Component, OnInit, OnDestroy, ViewChild,
  ElementRef, ChangeDetectorRef, AfterViewInit
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { FormsModule } from '@angular/forms';
import { BreakpointObserver, Breakpoints } from '@angular/cdk/layout';
import { Subject, takeUntil } from 'rxjs';
import { ChatbotComponent } from './components/chatbot/chatbot';

// ─── DSP Utilities ──────────────────────────────────────────────
// All signal processing ported from motor_app.py to TypeScript

function linspace(start: number, stop: number, num: number): Float64Array {
  const arr = new Float64Array(num);
  const step = (stop - start) / (num - 1);
  for (let i = 0; i < num; i++) arr[i] = start + i * step;
  return arr;
}

function generateSignal(
  t: Float64Array, freq: number, amplitudes: number[], noise: number, seed = 42
): Float64Array {
  const rng = mulberry32(seed);
  const signal = new Float64Array(t.length);
  for (let i = 0; i < t.length; i++) {
    let v = 0;
    for (let h = 0; h < amplitudes.length; h++) {
      v += amplitudes[h] * Math.sin(2 * Math.PI * (h + 1) * freq * t[i]);
    }
    v += noise * (rng() * 2 - 1);
    signal[i] = v;
  }
  return signal;
}

function generateSingleHarmonic(
  t: Float64Array, baseFreq: number, harmonicNum: number, amplitude: number
): Float64Array {
  const out = new Float64Array(t.length);
  for (let i = 0; i < t.length; i++) {
    out[i] = amplitude * Math.sin(2 * Math.PI * harmonicNum * baseFreq * t[i]);
  }
  return out;
}

// Seedable PRNG (Mulberry32)
function mulberry32(seed: number) {
  return () => {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

// FFT (Cooley-Tukey radix-2)
function rfft(signal: Float64Array): { re: Float64Array, im: Float64Array } {
  const N = signal.length;
  const n2 = nextPow2(N);
  const re = new Float64Array(n2);
  const im = new Float64Array(n2);
  for (let i = 0; i < N; i++) re[i] = signal[i];

  // Bit reversal
  let j = 0;
  for (let i = 1; i < n2; i++) {
    let bit = n2 >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }

  // Butterfly
  for (let len = 2; len <= n2; len <<= 1) {
    const ang = -2 * Math.PI / len;
    const wRe = Math.cos(ang), wIm = Math.sin(ang);
    for (let i = 0; i < n2; i += len) {
      let curRe = 1, curIm = 0;
      for (let k = 0; k < len / 2; k++) {
        const uRe = re[i + k], uIm = im[i + k];
        const vRe = re[i + k + len / 2] * curRe - im[i + k + len / 2] * curIm;
        const vIm = re[i + k + len / 2] * curIm + im[i + k + len / 2] * curRe;
        re[i + k] = uRe + vRe; im[i + k] = uIm + vIm;
        re[i + k + len / 2] = uRe - vRe; im[i + k + len / 2] = uIm - vIm;
        const newRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe; curRe = newRe;
      }
    }
  }

  const half = n2 / 2 + 1;
  return { re: re.slice(0, half), im: im.slice(0, half) };
}

function nextPow2(n: number): number {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

function rfftFreq(n: number, sampleRate: number): Float64Array {
  const n2 = nextPow2(n);
  const half = n2 / 2 + 1;
  const freq = new Float64Array(half);
  for (let i = 0; i < half; i++) freq[i] = i * sampleRate / n2;
  return freq;
}

function computeFFT(signal: Float64Array, sampleRate: number) {
  const { re, im } = rfft(signal);
  const N = signal.length;
  const mag = new Float64Array(re.length);
  for (let i = 0; i < re.length; i++) {
    mag[i] = 2.0 / N * Math.sqrt(re[i] * re[i] + im[i] * im[i]);
  }
  const freq = rfftFreq(N, sampleRate);
  // Skip DC (index 0)
  return { freq: freq.slice(1), magnitude: mag.slice(1) };
}

interface FourierCoef { n: number; a: number; b: number; magnitude: number; }

function computeFourierSeries(
  t: Float64Array, signal: Float64Array, nTerms: number
): { approx: Float64Array, coefficients: FourierCoef[] } {
  const T = t[t.length - 1] - t[0];
  const omega0 = 2 * Math.PI / T;
  const a0 = mean(signal);
  const approx = new Float64Array(t.length).fill(a0);
  const coefficients: FourierCoef[] = [{ n: 0, a: a0, b: 0, magnitude: Math.abs(a0) }];

  for (let n = 1; n <= nTerms; n++) {
    const cosCom = new Float64Array(t.length);
    const sinCom = new Float64Array(t.length);
    for (let i = 0; i < t.length; i++) {
      cosCom[i] = Math.cos(n * omega0 * t[i]);
      sinCom[i] = Math.sin(n * omega0 * t[i]);
    }
    const an = 2 / T * trapezoid(signal.map((v, i) => v * cosCom[i]) as Float64Array, t);
    const bn = 2 / T * trapezoid(signal.map((v, i) => v * sinCom[i]) as Float64Array, t);
    for (let i = 0; i < t.length; i++) {
      approx[i] += an * cosCom[i] + bn * sinCom[i];
    }
    coefficients.push({ n, a: an, b: bn, magnitude: Math.hypot(an, bn) });
  }
  return { approx, coefficients };
}

function trapezoid(y: Float64Array, x: Float64Array): number {
  let sum = 0;
  for (let i = 1; i < y.length; i++) {
    sum += (y[i] + y[i - 1]) * (x[i] - x[i - 1]) / 2;
  }
  return sum;
}

function mean(arr: Float64Array): number {
  let s = 0; for (const v of arr) s += v; return s / arr.length;
}

// Generate WAV base64 for audio playback
function generateWAV(signal: Float64Array, sampleRate: number): string {
  const MAX_INT16 = 32767;
  let maxVal = 0;
  for (const v of signal) if (Math.abs(v) > maxVal) maxVal = Math.abs(v);
  const pcm = new Int16Array(signal.length);
  for (let i = 0; i < signal.length; i++) {
    pcm[i] = maxVal > 0 ? Math.round(signal[i] / maxVal * MAX_INT16) : 0;
  }

  const numChannels = 1;
  const bitsPerSample = 16;
  const blockAlign = numChannels * bitsPerSample / 8;
  const byteRate = sampleRate * blockAlign;
  const dataSize = pcm.length * 2;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  const ws = (o: number, s: string) => { for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i)); };
  ws(0, 'RIFF'); view.setUint32(4, 36 + dataSize, true); ws(8, 'WAVE');
  ws(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
  view.setUint16(22, numChannels, true); view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true); view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true); ws(36, 'data');
  view.setUint32(40, dataSize, true);
  for (let i = 0; i < pcm.length; i++) view.setInt16(44 + i * 2, pcm[i], true);

  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return 'data:audio/wav;base64,' + btoa(binary);
}

// Simple spectrogram using STFT
function computeSpectrogram(signal: Float64Array, sampleRate: number, nperseg = 256) {
  const hop = Math.floor(nperseg / 2);
  const numFrames = Math.floor((signal.length - nperseg) / hop) + 1;
  const freqBins = nperseg / 2 + 1;
  const frequencies: number[] = [];
  for (let i = 0; i < freqBins; i++) frequencies.push(i * sampleRate / nperseg);

  const times: number[] = [];
  const Sxx: number[][] = [];

  // Hanning window
  const win = new Float64Array(nperseg);
  for (let i = 0; i < nperseg; i++) win[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / (nperseg - 1)));

  for (let f = 0; f < numFrames; f++) {
    const start = f * hop;
    times.push(start / sampleRate);
    const frame = new Float64Array(nperseg);
    for (let i = 0; i < nperseg; i++) frame[i] = signal[start + i] * win[i];
    const { re, im } = rfft(frame);
    const row: number[] = [];
    for (let i = 0; i < freqBins; i++) {
      const power = re[i] * re[i] + im[i] * im[i];
      row.push(10 * Math.log10(power + 1e-10));
    }
    Sxx.push(row);
  }

  return { frequencies, times, Sxx };
}

// ─── Chart helpers using Canvas 2D ──────────────────────────────
interface ChartData { x: number[]; y: number[]; color: string; label: string; fill?: boolean; }

function drawChart(
  canvas: HTMLCanvasElement,
  datasets: ChartData[],
  opts: {
    xLabel?: string, yLabel?: string, title?: string,
    xMin?: number, xMax?: number, yMin?: number, yMax?: number,
    grid?: boolean, markers?: boolean, vLines?: { x: number, color: string, label: string }[]
  } = {}
) {
  const ctx = canvas.getContext('2d')!;
  const dpr = window.devicePixelRatio || 1;
  const W = canvas.offsetWidth, H = canvas.offsetHeight;
  canvas.width = W * dpr; canvas.height = H * dpr;
  ctx.scale(dpr, dpr);

  const pad = { top: 30, right: 20, bottom: 45, left: 55 };
  const pw = W - pad.left - pad.right;
  const ph = H - pad.top - pad.bottom;

  // Background
  ctx.fillStyle = '#060d18';
  ctx.fillRect(0, 0, W, H);

  if (datasets.length === 0) return;

  // Data ranges
  let xMin = opts.xMin ?? Math.min(...datasets.flatMap(d => d.x));
  let xMax = opts.xMax ?? Math.max(...datasets.flatMap(d => d.x));
  let yMin = opts.yMin ?? Math.min(...datasets.flatMap(d => d.y));
  let yMax = opts.yMax ?? Math.max(...datasets.flatMap(d => d.y));
  if (xMin === xMax) xMax = xMin + 1;
  if (yMin === yMax) { yMin -= 1; yMax += 1; }
  const yPad = (yMax - yMin) * 0.05;
  yMin -= yPad; yMax += yPad;

  const toX = (v: number) => pad.left + (v - xMin) / (xMax - xMin) * pw;
  const toY = (v: number) => pad.top + (1 - (v - yMin) / (yMax - yMin)) * ph;

  // Grid
  if (opts.grid !== false) {
    ctx.strokeStyle = '#0d2035';
    ctx.lineWidth = 1;
    const gy = 5;
    for (let i = 0; i <= gy; i++) {
      const y = pad.top + i * ph / gy;
      ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(pad.left + pw, y); ctx.stroke();
    }
    const gx = 6;
    for (let i = 0; i <= gx; i++) {
      const x = pad.left + i * pw / gx;
      ctx.beginPath(); ctx.moveTo(x, pad.top); ctx.lineTo(x, pad.top + ph); ctx.stroke();
    }
  }

  // Axes
  ctx.strokeStyle = '#1a3a5c';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(pad.left, pad.top); ctx.lineTo(pad.left, pad.top + ph);
  ctx.lineTo(pad.left + pw, pad.top + ph);
  ctx.stroke();

  // Tick labels
  ctx.fillStyle = '#3d6080';
  ctx.font = '10px "JetBrains Mono", monospace';
  ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
  const gy = 5;
  for (let i = 0; i <= gy; i++) {
    const v = yMax - i * (yMax - yMin) / gy;
    const y = pad.top + i * ph / gy;
    ctx.fillText(v.toFixed(2), pad.left - 5, y);
  }
  ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  const gx = 5;
  for (let i = 0; i <= gx; i++) {
    const v = xMin + i * (xMax - xMin) / gx;
    const x = pad.left + i * pw / gx;
    ctx.fillText(v.toFixed(1), x, pad.top + ph + 5);
  }

  // Vertical lines
  if (opts.vLines) {
    for (const vl of opts.vLines) {
      const x = toX(vl.x);
      if (x < pad.left || x > pad.left + pw) continue;
      ctx.strokeStyle = vl.color;
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 3]);
      ctx.beginPath(); ctx.moveTo(x, pad.top); ctx.lineTo(x, pad.top + ph); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = vl.color;
      ctx.font = '9px "JetBrains Mono", monospace';
      ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
      ctx.fillText(vl.label, x, pad.top - 2);
    }
  }

  // Data
  for (const ds of datasets) {
    if (ds.x.length < 2) continue;
    ctx.strokeStyle = ds.color;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (let i = 0; i < ds.x.length; i++) {
      const px = toX(ds.x[i]), py = toY(ds.y[i]);
      i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
    }
    ctx.stroke();

    if (ds.fill) {
      ctx.beginPath();
      ctx.moveTo(toX(ds.x[0]), pad.top + ph);
      for (let i = 0; i < ds.x.length; i++) ctx.lineTo(toX(ds.x[i]), toY(ds.y[i]));
      ctx.lineTo(toX(ds.x[ds.x.length - 1]), pad.top + ph);
      ctx.closePath();
      ctx.fillStyle = ds.color + '22';
      ctx.fill();
    }

    if (opts.markers) {
      ctx.fillStyle = ds.color;
      for (let i = 0; i < ds.x.length; i += Math.ceil(ds.x.length / 40)) {
        ctx.beginPath();
        ctx.arc(toX(ds.x[i]), toY(ds.y[i]), 3, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  // Labels
  ctx.fillStyle = '#4a8fb5';
  ctx.font = '11px "JetBrains Mono", monospace';
  if (opts.xLabel) {
    ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
    ctx.fillText(opts.xLabel, pad.left + pw / 2, H - 2);
  }
  if (opts.yLabel) {
    ctx.save(); ctx.translate(12, pad.top + ph / 2); ctx.rotate(-Math.PI / 2);
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(opts.yLabel, 0, 0); ctx.restore();
  }
  if (opts.title) {
    ctx.fillStyle = '#5fb3d4';
    ctx.font = 'bold 12px "JetBrains Mono", monospace';
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    ctx.fillText(opts.title, pad.left + pw / 2, 8);
  }
}

function drawBarChart(canvas: HTMLCanvasElement, labels: number[], values: number[], color: string, xLabel: string, yLabel: string, title: string) {
  const ctx = canvas.getContext('2d')!;
  const dpr = window.devicePixelRatio || 1;
  const W = canvas.offsetWidth, H = canvas.offsetHeight;
  canvas.width = W * dpr; canvas.height = H * dpr;
  ctx.scale(dpr, dpr);
  const pad = { top: 30, right: 20, bottom: 45, left: 55 };
  const pw = W - pad.left - pad.right;
  const ph = H - pad.top - pad.bottom;
  ctx.fillStyle = '#060d18'; ctx.fillRect(0, 0, W, H);

  const yMax = Math.max(...values) * 1.1 || 1;
  const barW = pw / values.length * 0.7;
  const gap = pw / values.length;

  ctx.fillStyle = '#0d2035';
  for (let i = 0; i <= 5; i++) {
    const y = pad.top + i * ph / 5;
    ctx.fillRect(pad.left, y, pw, 1);
    const v = yMax - i * yMax / 5;
    ctx.fillStyle = '#3d6080';
    ctx.font = '10px monospace';
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    ctx.fillText(v.toFixed(2), pad.left - 4, y);
    ctx.fillStyle = '#0d2035';
  }

  for (let i = 0; i < values.length; i++) {
    const bh = values[i] / yMax * ph;
    const x = pad.left + i * gap + (gap - barW) / 2;
    ctx.fillStyle = color + 'aa';
    ctx.fillRect(x, pad.top + ph - bh, barW, bh);
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.strokeRect(x, pad.top + ph - bh, barW, bh);
    ctx.fillStyle = '#3d6080';
    ctx.font = '9px monospace';
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    ctx.fillText(String(labels[i]), x + barW / 2, pad.top + ph + 4);
  }

  ctx.strokeStyle = '#1a3a5c'; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.moveTo(pad.left, pad.top); ctx.lineTo(pad.left, pad.top + ph); ctx.lineTo(pad.left + pw, pad.top + ph); ctx.stroke();

  ctx.fillStyle = '#4a8fb5'; ctx.font = '11px monospace';
  ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
  ctx.fillText(xLabel, pad.left + pw / 2, H - 2);
  ctx.save(); ctx.translate(12, pad.top + ph / 2); ctx.rotate(-Math.PI / 2);
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(yLabel, 0, 0); ctx.restore();
  ctx.fillStyle = '#5fb3d4'; ctx.font = 'bold 12px monospace';
  ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  ctx.fillText(title, pad.left + pw / 2, 8);
}

function drawHeatmap(canvas: HTMLCanvasElement, Sxx: number[][], frequencies: number[], times: number[]) {
  const ctx = canvas.getContext('2d')!;
  const dpr = window.devicePixelRatio || 1;
  const W = canvas.offsetWidth, H = canvas.offsetHeight;
  canvas.width = W * dpr; canvas.height = H * dpr;
  ctx.scale(dpr, dpr);
  const pad = { top: 20, right: 20, bottom: 45, left: 55 };
  const pw = W - pad.left - pad.right;
  const ph = H - pad.top - pad.bottom;
  ctx.fillStyle = '#060d18'; ctx.fillRect(0, 0, W, H);

  if (Sxx.length === 0) return;

  let minV = Infinity, maxV = -Infinity;
  for (const row of Sxx) for (const v of row) { if (v < minV) minV = v; if (v > maxV) maxV = v; }

  const cellW = pw / Sxx.length;
  const cellH = ph / Sxx[0].length;

  const jet = (t: number) => {
    const r = Math.max(0, Math.min(1, 1.5 - Math.abs(4 * t - 3)));
    const g = Math.max(0, Math.min(1, 1.5 - Math.abs(4 * t - 2)));
    const b = Math.max(0, Math.min(1, 1.5 - Math.abs(4 * t - 1)));
    return `rgb(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)})`;
  };

  for (let ti = 0; ti < Sxx.length; ti++) {
    for (let fi = 0; fi < Sxx[ti].length; fi++) {
      const t = (Sxx[ti][fi] - minV) / (maxV - minV);
      ctx.fillStyle = jet(t);
      ctx.fillRect(pad.left + ti * cellW, pad.top + ph - (fi + 1) * cellH, cellW + 1, cellH + 1);
    }
  }

  ctx.strokeStyle = '#1a3a5c'; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.moveTo(pad.left, pad.top); ctx.lineTo(pad.left, pad.top + ph); ctx.lineTo(pad.left + pw, pad.top + ph); ctx.stroke();

  ctx.fillStyle = '#5fb3d4'; ctx.font = 'bold 12px monospace';
  ctx.textAlign = 'center'; ctx.fillText('Spectrogramă (dB)', pad.left + pw / 2, 18);
  ctx.fillStyle = '#4a8fb5'; ctx.font = '10px monospace';
  ctx.textAlign = 'center'; ctx.textBaseline = 'bottom'; ctx.fillText('Timp (s)', pad.left + pw / 2, H - 2);
}

// ─── Component ──────────────────────────────────────────────────
@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule, FormsModule, ChatbotComponent],
  templateUrl: './app.html',
  styleUrl: './app.css'
})
export class AppComponent implements OnInit, OnDestroy {

  // ─── Mobile / layout state ──────────────────────────────────────
  isMobile = false;
  sidebarOpen = false;
  private destroy$ = new Subject<void>();

  // Params
  rpm = 3000;
  numHarmonics = 5;
  samplingRate = 5000;
  duration = 2.0;
  noiseLevel = 0.1;
  amplitudes: number[] = Array.from({ length: 10 }, (_, i) => +(1 / (i + 1)).toFixed(2));
  fourierTerms = 10;
  progressiveHarmonics = 1;
  customBaseFreq = 200;
  customDuration = 1.0;
  customAmps: number[] = [1, 0.5, 0.33, 0.25, 0.2];

  // State
  activeTab = 0;
  simulated = false;
  isCalculating = false;
  projectLoaded = false;

  // Stats
  get frequency(): number { return +(this.rpm / 60).toFixed(2); }
  dominantFreq = 0;
  totalPower = 0;
  bandwidth = 0;
  mseError = 0;
  harmonicsTable: any[] = [];
  projMag50 = 0;
  projMag150 = 0;

  // Audio
  audioSrc: { [key: string]: string } = {};

  // Canvas refs - Tab 1
  @ViewChild('c_sig') c_sig!: ElementRef<HTMLCanvasElement>;
  @ViewChild('c_fft1') c_fft1!: ElementRef<HTMLCanvasElement>;
  @ViewChild('c_harmonics') c_harmonics!: ElementRef<HTMLCanvasElement>;
  @ViewChild('c_spectro') c_spectro!: ElementRef<HTMLCanvasElement>;

  // Canvas refs - Tab 2
  @ViewChild('c_fourier') c_fourier!: ElementRef<HTMLCanvasElement>;
  @ViewChild('c_coef') c_coef!: ElementRef<HTMLCanvasElement>;

  // Canvas refs - Tab 3
  @ViewChild('c_fftFull') c_fftFull!: ElementRef<HTMLCanvasElement>;
  @ViewChild('c_fftZoom') c_fftZoom!: ElementRef<HTMLCanvasElement>;

  // Canvas refs - Tab 4
  @ViewChild('c_proj_time') c_proj_time!: ElementRef<HTMLCanvasElement>;
  @ViewChild('c_proj_fft') c_proj_fft!: ElementRef<HTMLCanvasElement>;
  @ViewChild('c_proj_decomp1') c_proj_decomp1!: ElementRef<HTMLCanvasElement>;
  @ViewChild('c_proj_decomp2') c_proj_decomp2!: ElementRef<HTMLCanvasElement>;
  @ViewChild('c_proj_noise') c_proj_noise!: ElementRef<HTMLCanvasElement>;
  @ViewChild('c_proj_total') c_proj_total!: ElementRef<HTMLCanvasElement>;

  // Cache
  private _signal!: Float64Array;
  private _t!: Float64Array;
  private _freq!: Float64Array;
  private _mag!: Float64Array;

  private _t2Timeout: any;
  renderTab2Debounced() {
    clearTimeout(this._t2Timeout);
    this._t2Timeout = setTimeout(() => {
      if (this.simulated && this.activeTab === 1) this.renderTab2();
    }, 200);
  }

  harmonicsArray(): number[] {
    return Array.from({ length: this.numHarmonics }, (_, i) => i);
  }

  customAmpsArray(): number[] {
    return Array.from({ length: 5 }, (_, i) => i);
  }

  constructor(
    private cdr: ChangeDetectorRef,
    private http: HttpClient,
    private breakpointObserver: BreakpointObserver
  ) {}

  ngOnInit() {
    // Watch for mobile breakpoints using CDK
    this.breakpointObserver
      .observe([Breakpoints.XSmall, Breakpoints.Small, '(max-width: 768px)'])
      .pipe(takeUntil(this.destroy$))
      .subscribe(result => {
        this.isMobile = result.matches;
        // Close sidebar automatically when switching to desktop
        if (!this.isMobile) this.sidebarOpen = false;
        this.cdr.detectChanges();
      });
  }

  ngOnDestroy() {
    this.destroy$.next();
    this.destroy$.complete();
  }

  toggleSidebar() {
    this.sidebarOpen = !this.sidebarOpen;
  }

  closeSidebar() {
    this.sidebarOpen = false;
  }

  // ─── Salvare în PostgreSQL via backend ──────────────────────────
  isSaving = false;
  saveStatus: 'idle' | 'ok' | 'error' = 'idle';

  saveReading() {
    if (!this.simulated || this.isSaving) return;
    this.isSaving = true;
    this.saveStatus = 'idle';

    const diagnostic = this.currentNoise > 0.3
      ? 'ALERTĂ: Zgomot critic'
      : this.rpm > 5000 ? 'Viteză mare' : 'Normal';

    const body = {
      rpm: this.rpm,
      zgomot: parseFloat(this.currentNoise.toFixed(4)),
      frecventa_fundamentala: this.dominantFreq || null,
      putere_totala: this.totalPower || null,
      diagnostic
    };

    this.http.post<any>('https://vibroscan-api.onrender.com', body).subscribe({
      next: (res) => {
        this.saveStatus = 'ok';
        this.isSaving = false;
        setTimeout(() => this.saveStatus = 'idle', 3000);
      },
      error: () => {
        this.saveStatus = 'error';
        this.isSaving = false;
        setTimeout(() => this.saveStatus = 'idle', 4000);
      }
    });
  }

  get currentNoise(): number {
    return this.noiseLevel;
  }

  onParamChange() {
    if (this.simulated) this.simulate();
  }

  selectTab(i: number) {
    this.activeTab = i;
    // On mobile, close sidebar when a tab is selected
    if (this.isMobile) this.closeSidebar();
    if (this.simulated) setTimeout(() => this.renderForTab(i), 120);
  }

  loadProjectScenario() {
    this.rpm = 3000;
    this.numHarmonics = 2;
    this.amplitudes[0] = 1.0;
    this.amplitudes[1] = 0.5;
    this.noiseLevel = 0.2;
    this.projectLoaded = true;
    if (this.isMobile) this.closeSidebar();
    if (this.simulated) this.simulate();
  }

  simulate() {
    this.isCalculating = true;
    this.simulated = true;
    // On mobile, close sidebar after simulate press
    if (this.isMobile) this.closeSidebar();
    this.cdr.detectChanges();

    setTimeout(() => {
      this._t = linspace(0, this.duration, Math.floor(this.samplingRate * this.duration));
      this._signal = generateSignal(this._t, this.frequency, this.amplitudes.slice(0, this.numHarmonics), this.noiseLevel);
      const { freq, magnitude } = computeFFT(this._signal, this.samplingRate);
      this._freq = freq as unknown as Float64Array;
      this._mag = magnitude as unknown as Float64Array;

      // Stats
      let maxMag = 0, maxIdx = 0;
      for (let i = 0; i < this._mag.length; i++) {
        if (this._mag[i] > maxMag) { maxMag = this._mag[i]; maxIdx = i; }
      }
      this.dominantFreq = +this._freq[maxIdx].toFixed(2);
      this.totalPower = +Array.from(this._mag).reduce((s, v) => s + v * v, 0).toFixed(2);
      const threshold = maxMag * 0.1;
      const bwIdxs = Array.from(this._mag).map((v, i) => v > threshold ? this._freq[i] : null).filter(v => v !== null) as number[];
      this.bandwidth = bwIdxs.length > 0 ? +(bwIdxs[bwIdxs.length - 1] - bwIdxs[0]).toFixed(2) : 0;

      // Harmonics table
      this.harmonicsTable = [];
      for (let i = 0; i < this.numHarmonics; i++) {
        const expFreq = (i + 1) * this.frequency;
        let closest = 0, closestDist = Infinity;
        for (let j = 0; j < this._freq.length; j++) {
          const d = Math.abs(this._freq[j] - expFreq);
          if (d < closestDist) { closestDist = d; closest = j; }
        }
        this.harmonicsTable.push({
          h: i + 1,
          freqTheory: expFreq.toFixed(2),
          freqDetected: this._freq[closest].toFixed(2),
          amplitude: this._mag[closest].toFixed(4),
          amplSet: this.amplitudes[i].toFixed(4)
        });
      }

      // Audio - full signal
      this.audioSrc['main'] = generateWAV(this._signal, this.samplingRate);

      this.renderForTab(this.activeTab);
      this.isCalculating = false;
      this.cdr.detectChanges();
      this.saveReading();
    }, 200);
  }

  private renderForTab(tab: number) {
    switch (tab) {
      case 0: this.renderTab1(); break;
      case 1: this.renderTab2(); break;
      case 2: this.renderTab3(); break;
      case 3: this.renderTab4(); break;
      case 5: this.renderAudioTab(); break;
    }
  }

  private renderTab1() {
    const visN = Math.min(Math.floor(0.2 * this.samplingRate), this._t.length);
    const tVis = Array.from(this._t).slice(0, visN);
    const sVis = Array.from(this._signal).slice(0, visN);

    if (this.c_sig?.nativeElement) {
      drawChart(this.c_sig.nativeElement, [{ x: tVis, y: sVis, color: '#00e5ff', label: 'Semnal', fill: true }],
        { xLabel: 'Timp (s)', yLabel: 'Amplitudine', title: 'Semnal Temporal de Vibrație', grid: true });
    }
    if (this.c_fft1?.nativeElement) {
      const fArr = Array.from(this._freq), mArr = Array.from(this._mag);
      const cutoff = this.frequency * (this.numHarmonics + 3);
      const mask = fArr.map((f, i) => f < cutoff ? i : -1).filter(i => i >= 0);
      drawChart(this.c_fft1.nativeElement,
        [{ x: mask.map(i => fArr[i]), y: mask.map(i => mArr[i]), color: '#ff4757', label: 'FFT', fill: true }],
        { xLabel: 'Frecvență (Hz)', yLabel: 'Magnitudine', title: 'Spectru FFT', grid: true });
    }
    if (this.c_harmonics?.nativeElement) {
      const datasets: ChartData[] = [];
      const colors = ['#00e5ff', '#ff4757', '#2ed573', '#ffa502', '#a29bfe', '#fd79a8', '#55efc4', '#fdcb6e', '#e17055', '#74b9ff'];
      for (let h = 0; h < this.numHarmonics; h++) {
        const hs = Array.from(generateSingleHarmonic(this._t.slice(0, Math.floor(0.1 * this.samplingRate)) as unknown as Float64Array,
          this.frequency, h + 1, this.amplitudes[h]));
        datasets.push({ x: Array.from(this._t).slice(0, hs.length), y: hs, color: colors[h % colors.length], label: `H${h + 1}` });
      }
      drawChart(this.c_harmonics.nativeElement, datasets, { xLabel: 'Timp (s)', yLabel: 'Amplitudine', title: 'Descompunere Armonici', grid: true });
    }
    if (this.c_spectro?.nativeElement) {
      const { frequencies, times, Sxx } = computeSpectrogram(this._signal, this.samplingRate, 256);
      drawHeatmap(this.c_spectro.nativeElement, Sxx, frequencies, times);
    }
  }

  private renderTab2() {
    const windowSize = Math.floor(this._t.length / 4);
    const tW = this._t.slice(0, windowSize) as unknown as Float64Array;
    const sW = this._signal.slice(0, windowSize) as unknown as Float64Array;
    const { approx, coefficients } = computeFourierSeries(tW, sW, this.fourierTerms);

    const mse = Array.from(sW).reduce((s, v, i) => s + (v - approx[i]) ** 2, 0) / sW.length;
    this.mseError = +mse.toFixed(6);
    this.cdr.detectChanges();

    if (this.c_fourier?.nativeElement) {
      drawChart(this.c_fourier.nativeElement, [
        { x: Array.from(tW), y: Array.from(sW), color: '#00e5ff', label: 'Original' },
        { x: Array.from(tW), y: Array.from(approx), color: '#ff6b81', label: `Fourier (${this.fourierTerms} termeni)` }
      ], { xLabel: 'Timp (s)', yLabel: 'Amplitudine', title: 'Semnal Original vs Aproximare Fourier', grid: true });
    }
    if (this.c_coef?.nativeElement) {
      drawBarChart(this.c_coef.nativeElement,
        coefficients.map(c => c.n), coefficients.map(c => c.magnitude),
        '#ff4757', 'Armonică (n)', 'Magnitudine', 'Coeficienți Serii Fourier');
    }
  }

  private renderTab3() {
    const fArr = Array.from(this._freq), mArr = Array.from(this._mag);
    const vLines = Array.from({ length: this.numHarmonics }, (_, i) => ({
      x: (i + 1) * this.frequency,
      color: i === 0 ? '#2ed573' : '#ffa502',
      label: `f${i + 1}`
    }));

    if (this.c_fftFull?.nativeElement) {
      drawChart(this.c_fftFull.nativeElement,
        [{ x: fArr, y: mArr, color: '#a29bfe', label: 'FFT', fill: true }],
        { xLabel: 'Frecvență (Hz)', yLabel: 'Magnitudine', title: 'Spectrul Complet FFT', grid: true, vLines });
    }
    if (this.c_fftZoom?.nativeElement) {
      const cutoff = this.frequency * (this.numHarmonics + 1);
      const mask = fArr.map((f, i) => f < cutoff ? i : -1).filter(i => i >= 0);
      drawChart(this.c_fftZoom.nativeElement,
        [{ x: mask.map(i => fArr[i]), y: mask.map(i => mArr[i]), color: '#2ed573', label: 'Zoom', fill: true }],
        { xLabel: 'Frecvență (Hz)', yLabel: 'Magnitudine', title: 'Zoom Armonici Principale', grid: true, markers: true, vLines });
    }
  }

  projComparisonData: { comp: string, freqT: string, freqD: string, amp: string, interp: string }[] = [];

  private renderTab4() {
    const pFreq = 50;
    const pSR = 5000;
    const pDur = 2.0;
    const tP = linspace(0, pDur, Math.floor(pSR * pDur));
    const s50 = generateSingleHarmonic(tP, pFreq, 1, 1.0);
    const s150 = generateSingleHarmonic(tP, pFreq, 3, 0.5);
    const rng = mulberry32(123);
    const noise = new Float64Array(tP.length).map(() => 0.2 * (rng() * 2 - 1));
    const sTotal = tP.map((_, i) => s50[i] + s150[i] + noise[i]) as unknown as Float64Array;

    const { freq: pFreqs, magnitude: pMag } = computeFFT(sTotal, pSR);

    const idx50 = Array.from(pFreqs).reduce((best, f, i) => Math.abs(f - 50) < Math.abs(pFreqs[best] - 50) ? i : best, 0);
    const idx150 = Array.from(pFreqs).reduce((best, f, i) => Math.abs(f - 150) < Math.abs(pFreqs[best] - 150) ? i : best, 0);
    this.projMag50 = +pMag[idx50].toFixed(4);
    this.projMag150 = +pMag[idx150].toFixed(4);
    this.projComparisonData = [
      { comp: 'Fundamentală (1×RPM)', freqT: '50', freqD: pFreqs[idx50].toFixed(2), amp: pMag[idx50].toFixed(4), interp: 'Rotație normală' },
      { comp: 'Defect - Armonică 3 (3×RPM)', freqT: '150', freqD: pFreqs[idx150].toFixed(2), amp: pMag[idx150].toFixed(4), interp: 'Dezaxare/Neechilibru' }
    ];
    this.cdr.detectChanges();

    const N = 1000;
    const tVis = Array.from(tP).slice(0, N);

    if (this.c_proj_time?.nativeElement) {
      drawChart(this.c_proj_time.nativeElement,
        [{ x: tVis, y: Array.from(sTotal).slice(0, N), color: '#00e5ff', label: 'Semnal Total', fill: true }],
        { xLabel: 'Timp (s)', yLabel: 'Amplitudine', title: 'Semnal de Vibrație cu Zgomot', grid: true });
    }
    if (this.c_proj_fft?.nativeElement) {
      const pFArr = Array.from(pFreqs), pMArr = Array.from(pMag);
      const mask = pFArr.map((f, i) => f < 300 ? i : -1).filter(i => i >= 0);
      drawChart(this.c_proj_fft.nativeElement,
        [{ x: mask.map(i => pFArr[i]), y: mask.map(i => pMArr[i]), color: '#ff4757', label: 'FFT', fill: true }],
        { xLabel: 'Frecvență (Hz)', yLabel: 'Magnitudine', title: 'Analiza Spectrală - Identificare Defect', grid: true,
          vLines: [{ x: 50, color: '#2ed573', label: '50Hz Fundamentală' }, { x: 150, color: '#ffa502', label: '150Hz Defect' }] });
    }
    if (this.c_proj_decomp1?.nativeElement) {
      drawChart(this.c_proj_decomp1.nativeElement,
        [{ x: tVis, y: Array.from(s50).slice(0, N), color: '#2ed573', label: '50 Hz' }],
        { xLabel: 'Timp (s)', yLabel: 'Amplitudine', title: 'Componenta 50 Hz (Fundamentală)', grid: true });
    }
    if (this.c_proj_decomp2?.nativeElement) {
      drawChart(this.c_proj_decomp2.nativeElement,
        [{ x: tVis, y: Array.from(s150).slice(0, N), color: '#ffa502', label: '150 Hz' }],
        { xLabel: 'Timp (s)', yLabel: 'Amplitudine', title: 'Componenta 150 Hz (Defect)', grid: true });
    }
    if (this.c_proj_noise?.nativeElement) {
      drawChart(this.c_proj_noise.nativeElement,
        [{ x: tVis, y: Array.from(noise).slice(0, N), color: '#636e72', label: 'Zgomot' }],
        { xLabel: 'Timp (s)', yLabel: 'Amplitudine', title: 'Zgomot Aleator', grid: true });
    }
    if (this.c_proj_total?.nativeElement) {
      drawChart(this.c_proj_total.nativeElement,
        [{ x: tVis, y: Array.from(sTotal).slice(0, N), color: '#00e5ff', label: 'Total', fill: true }],
        { xLabel: 'Timp (s)', yLabel: 'Amplitudine', title: 'Semnal Total (50+150+Zgomot)', grid: true });
    }
  }

  private renderAudioTab() {
    // Generate audio for each harmonic
    for (let h = 0; h < this.numHarmonics; h++) {
      const t = linspace(0, this.duration, Math.floor(this.samplingRate * this.duration));
      const hs = generateSingleHarmonic(t, this.frequency, h + 1, this.amplitudes[h]);
      this.audioSrc[`harm_${h}`] = generateWAV(hs, this.samplingRate);
    }

    // Progressive
    this.generateProgressiveAudio();

    // Healthy motor
    const tH = linspace(0, 2, 2 * this.samplingRate);
    const healthy = generateSingleHarmonic(tH, 50, 1, 1.0);
    const rng1 = mulberry32(456);
    const hSig = healthy.map((v, i) => v + 0.1 * (rng1() * 2 - 1)) as unknown as Float64Array;
    this.audioSrc['healthy'] = generateWAV(hSig, this.samplingRate);

    // Defect motor
    const tD = linspace(0, 2, 2 * this.samplingRate);
    const d1 = generateSingleHarmonic(tD, 50, 1, 1.0);
    const d3 = generateSingleHarmonic(tD, 50, 3, 0.6);
    const rng2 = mulberry32(789);
    const dSig = d1.map((v, i) => v + d3[i] + 0.2 * (rng2() * 2 - 1)) as unknown as Float64Array;
    this.audioSrc['defect'] = generateWAV(dSig, this.samplingRate);

    this.cdr.detectChanges();
  }

  generateProgressiveAudio() {
    const t = linspace(0, this.duration, Math.floor(this.samplingRate * this.duration));
    const sig = new Float64Array(t.length);
    const rng = mulberry32(42);
    for (let h = 0; h < this.progressiveHarmonics; h++) {
      for (let i = 0; i < t.length; i++) {
        sig[i] += this.amplitudes[h] * Math.sin(2 * Math.PI * (h + 1) * this.frequency * t[i]);
      }
    }
    if (this.noiseLevel > 0) {
      for (let i = 0; i < sig.length; i++) sig[i] += this.noiseLevel * (rng() * 2 - 1);
    }
    this.audioSrc['progressive'] = generateWAV(sig, this.samplingRate);
    this.cdr.detectChanges();
  }

  generateCustomAudio() {
    const t = linspace(0, this.customDuration, Math.floor(this.samplingRate * this.customDuration));
    const sig = new Float64Array(t.length);
    for (let h = 0; h < 5; h++) {
      if (this.customAmps[h] > 0) {
        for (let i = 0; i < t.length; i++) {
          sig[i] += this.customAmps[h] * Math.sin(2 * Math.PI * (h + 1) * this.customBaseFreq * t[i]);
        }
      }
    }
    this.audioSrc['custom'] = generateWAV(sig, this.samplingRate);
    this.cdr.detectChanges();
  }

  getHarmonicFreq(i: number): number {
    return +((i + 1) * this.progressiveHarmonics === 0 ? 0 : (i + 1) * this.frequency).toFixed(1);
  }

  activeFreqs(): { n: number, f: number }[] {
    return Array.from({ length: this.progressiveHarmonics }, (_, i) => ({ n: i + 1, f: +((i + 1) * this.frequency).toFixed(1) }));
  }

  harmonicStrength(amp: number): string {
    if (amp > 0.5) return 'strong';
    if (amp > 0.2) return 'medium';
    return 'weak';
  }
}