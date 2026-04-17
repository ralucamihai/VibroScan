import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';


@Injectable({ providedIn: 'root' })
export class MotorService {
  private apiUrl = 'http://127.0.0.1:8000/calculate';

  constructor(private http: HttpClient) {}

  getAnalysis(params: any): Observable<any> {
    return this.http.post(this.apiUrl, params);
  }
}
export class VibrationService {

  generateSignal(duration: number, samplingRate: number, rpm: number, amplitudes: number[], noiseLevel: number) {
    const t: number[] = [];
    const signal: number[] = [];
    const freq = rpm / 60; // Convertim RPM în Hz
    const numSamples = duration * samplingRate;

    for (let i = 0; i < numSamples; i++) {
      const timeVal = i / samplingRate;
      t.push(timeVal);

      let currentSample = 0;
      // Adăugăm armonicele (ca în loop-ul tău din Python)
      amplitudes.forEach((amp, index) => {
        const harmonicFreq = freq * (index + 1);
        currentSample += amp * Math.sin(2 * Math.PI * harmonicFreq * timeVal);
      });

      // Zgomot aleator
      currentSample += (Math.random() * 2 - 1) * noiseLevel;
      signal.push(currentSample);
    }

    return { t, signal };
  }
}