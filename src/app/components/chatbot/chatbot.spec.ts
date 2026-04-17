import { ComponentFixture, TestBed, fakeAsync, tick } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting, HttpTestingController } from '@angular/common/http/testing';
import { FormsModule } from '@angular/forms';
import { ChatbotComponent } from './chatbot';

describe('Chatbot', () => {
  let component: ChatbotComponent;
  let fixture: ComponentFixture<ChatbotComponent>;
  let httpMock: HttpTestingController;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      // Importăm componenta standalone și modulele necesare
      imports: [ChatbotComponent, FormsModule],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(ChatbotComponent);
    component = fixture.componentInstance;
    httpMock = TestBed.inject(HttpTestingController);
    
    // Detectăm schimbările inițiale
    fixture.detectChanges();
  });

  afterEach(() => {
    // Ne asigurăm că nu rămân cereri HTTP nerezolvate între teste
    httpMock.verify();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('should have the greeting message as the first message', () => {
    expect(component.messages.length).toBe(1);
    expect(component.messages[0].text).toContain('Salut!');
    expect(component.messages[0].type).toBe('bot');
  });

  it('should toggle chat visibility', () => {
    expect(component.isOpen).toBeFalsy();
    component.toggleChat();
    expect(component.isOpen).toBeTruthy();
    component.toggleChat();
    expect(component.isOpen).toBeFalsy();
  });

  it('should not send a message if currentQuery is empty or whitespace', async () => {
    const initialCount = component.messages.length;
    
    component.currentQuery = '   ';
    await component.sendMessage();
    
    expect(component.messages.length).toBe(initialCount);
  });

  it('should format Markdown bold correctly', () => {
    // Testăm funcția privată prin accesare (cast la any pentru test)
    const rawText = 'Sunt **asistentul** tău.';
    const parsed = (component as any).parseMarkdown(rawText);
    
    expect(parsed).toContain('<strong>asistentul</strong>');
  });

  it('should format Markdown lists correctly', () => {
    const rawText = '- Item 1\n- Item 2';
    const parsed = (component as any).parseMarkdown(rawText);
    
    expect(parsed).toContain('<ul>');
    expect(parsed).toContain('<li>Item 1</li>');
  });

  it('should show typing indicator when sending a message', fakeAsync(() => {
    component.currentQuery = 'Salut!';
    
    // Lansăm metoda fără await pentru a verifica starea intermediară (loading)
    component.sendMessage();
    
    expect(component.isLoading).toBeTruthy();
    // Verificăm dacă indicatorul de typing a fost adăugat în listă
    const lastMessage = component.messages[component.messages.length - 1];
    expect(lastMessage.isTyping).toBeTruthy();

    // Curățăm cererile mock pentru a evita erorile în consolă
    httpMock.expectOne('http://localhost:8000/api/readings/stats').flush({ body: null });
    httpMock.expectOne('http://localhost:8000/api/readings/latest').flush({ body: null });
    httpMock.expectOne('http://localhost:8000/ask-ai').flush({ body: { response: 'Test' } });
    
    tick(); // Procesăm timpii asincroni
  }));
});