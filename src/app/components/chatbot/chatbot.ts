import { Component, Input, OnInit, ViewChild, ElementRef, AfterViewChecked, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';

@Component({
  selector: 'app-chatbot',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './chatbot.html',
  styleUrl: './chatbot.css'
})
export class ChatbotComponent implements OnInit, AfterViewChecked {
  @Input() currentRpm: number = 0;
  @Input() currentNoise: number = 0;
  @Input() harmonicsCount: number = 0;
  @Input() dominantFreq: number = 0;
  @Input() totalPower: number = 0;

  @ViewChild('messagesContainer') messagesContainer!: ElementRef;

  private apiUrl = 'https://vibroscan.onrender.com/api/chatbot';
  private aiUrl = 'https://vibroscan.onrender.com/api/chatbot';

  isOpen = false;
  isLoading = false;
  currentQuery = '';
  private shouldScrollToBottom = false;

  private conversationHistory: { role: 'user' | 'model'; parts: { text: string }[] }[] = [];

  messages: { text: string; html: string; type: 'user' | 'bot'; isTyping?: boolean }[] = [
    {
      text: 'Salut!',
      html: 'Salut! Sunt <strong>Vibro-AI</strong>. Cu ce te pot ajuta?',
      type: 'bot'
    }
  ];
  

  constructor(private http: HttpClient, private cdr: ChangeDetectorRef) {}

  ngOnInit() {}

  ngAfterViewChecked() {
    if (this.shouldScrollToBottom) {
      this.scrollToBottom();
      this.shouldScrollToBottom = false;
    }
  }

  private scrollToBottom() {
    try {
      const el = this.messagesContainer?.nativeElement;
      if (el) el.scrollTop = el.scrollHeight;
    } catch {}
  }

  toggleChat() {
    this.isOpen = !this.isOpen;
    if (this.isOpen) {
      this.shouldScrollToBottom = true;
    }
  }

  private parseMarkdown(text: string): string {
    return text
      .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.*?)\*/g, '<em>$1</em>')
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/^### (.+)$/gm, '<h4>$1</h4>')
      .replace(/^## (.+)$/gm, '<h3>$1</h3>')
      .replace(/^# (.+)$/gm, '<h2>$1</h2>')
      .replace(/^[-•] (.+)$/gm, '<li>$1</li>')
      .replace(/(<li>.*<\/li>\n?)+/g, (match) => `<ul>${match}</ul>`)
      .replace(/\n(?!<)/g, '<br>');
  }

  async sendMessage() {
    if (!this.currentQuery.trim() || this.isLoading) return;

    const userText = this.currentQuery.trim();
    this.messages.push({ text: userText, html: userText, type: 'user' });
    this.currentQuery = '';
    this.isLoading = true;
    this.shouldScrollToBottom = true;
    this.cdr.detectChanges();

    this.conversationHistory.push({
      role: 'user',
      parts: [{ text: userText }]
    });

    // Typing indicator
    this.messages.push({ text: '', html: '', type: 'bot', isTyping: true });
    const lastIndex = this.messages.length - 1;
    this.shouldScrollToBottom = true;
    this.cdr.detectChanges();

    try {
      const [dbStats, latestReading] = await Promise.all([
        this.fetchStatsData(),
        this.fetchLatestData()
      ]);

      const systemPrompt = this.buildSystemPrompt(dbStats, latestReading);

      const result = await firstValueFrom(
        this.http.post<{ response: string }>(this.aiUrl, {
          messages: this.conversationHistory,
          system_prompt: systemPrompt
        })
      );

      const botReply = result?.response ?? 'Nu am primit un raspuns valid.';

      this.conversationHistory.push({
        role: 'model',
        parts: [{ text: botReply }]
      });

      if (this.conversationHistory.length > 20) {
        this.conversationHistory = this.conversationHistory.slice(-20);
        if (this.conversationHistory[0]?.role !== 'user') {
          this.conversationHistory = this.conversationHistory.slice(1);
        }
      }

      this.messages[lastIndex] = {
        text: botReply,
        html: this.parseMarkdown(botReply),
        type: 'bot',
        isTyping: false
      };

    } catch (error: any) {
      this.conversationHistory.pop();

      let errMsg = 'Eroare la conectarea cu AI-ul.';
      if (error?.status === 0) {
        errMsg = 'Backend-ul Python nu ruleaza. Porneste serverul pe portul 8000.';
      } else if (error?.status === 403 || error?.status === 401) {
        errMsg = 'Cheie API invalida sau expirata.';
      } else if (error?.status === 429) {
        errMsg = 'Prea multe cereri. Mai incearca in cateva secunde.';
      } else if (error?.status === 503) {
        errMsg = 'Nu se poate contacta Groq API. Verifica conexiunea la internet.';
      } else if (error?.error?.detail) {
        errMsg = error.error.detail;
      }

      this.messages[lastIndex] = { text: errMsg, html: errMsg, type: 'bot', isTyping: false };
    } finally {
      this.isLoading = false;
      this.shouldScrollToBottom = true;
      this.cdr.detectChanges();
    }
  }

  resetConversation() {
    this.conversationHistory = [];
    this.messages = [
      {
        text: 'Conversatie resetata.',
        html: 'Conversatie resetata. Cu ce te pot ajuta?',
        type: 'bot'
      }
    ];
    this.cdr.detectChanges();
  }

  private buildSystemPrompt(dbStats: any, latestReading: any): string {
    const liveContext = this.currentRpm > 0
      ? `DATE LIVE: RPM=${this.currentRpm}, Zgomot=${this.currentNoise.toFixed(4)}, FreqDom=${this.dominantFreq.toFixed(2)}Hz, Putere=${this.totalPower.toFixed(4)}, Armonici=${this.harmonicsCount}, Diagnostic=${this.getLiveDiagnostic()}`
      : 'Simularea nu este activa.';

    const dbContext = latestReading
      ? `ULTIMA INREGISTRARE: RPM=${latestReading.rpm}, Zgomot=${latestReading.zgomot}, Diagnostic=${latestReading.diagnostic ?? 'N/A'}`
      : 'Nu exista inregistrari in DB.';

    const statsContext = dbStats
      ? `STATISTICI: Total=${dbStats.total_readings}, RPM_avg=${dbStats.avg_rpm}, Zgomot_avg=${dbStats.avg_noise}, Alerte=${dbStats.alert_count}`
      : 'Statistici indisponibile.';

    return `Esti asistentul AI al aplicatiei VibroScan pentru monitorizarea motoarelor electrice. Raspunzi in limba romana. Esti concis si folosesti Markdown. ${liveContext} ${dbContext} ${statsContext} Praguri: zgomot normal<0.1, atentie 0.1-0.3, critic>0.3. RPM normal 2000-5500.`;
  }

  private getLiveDiagnostic(): string {
    if (this.currentNoise > 0.3) return 'ALERTA critic';
    if (this.currentRpm > 5000) return 'Viteza mare';
    if (this.currentRpm === 0) return 'Motor oprit';
    return 'Normal';
  }

  private async fetchStatsData(): Promise<any> {
    try {
      return await firstValueFrom(this.http.get<any>(`${this.apiUrl}/readings/stats`));
    } catch {
      return null;
    }
  }

  private async fetchLatestData(): Promise<any> {
    try {
      return await firstValueFrom(this.http.get<any>(`${this.apiUrl}/readings/latest`));
    } catch {
      return null;
    }
  }
}