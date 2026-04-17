from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import Optional, List
import psycopg2
from psycopg2.extras import RealDictCursor
import os
import requests
from dotenv import load_dotenv

load_dotenv()

app = FastAPI(title="VibroScan API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:4200", "https://vibroscan.netlify.app"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

DB_CONFIG = {
    "host": os.getenv("DB_HOST", "localhost"),
    "port": os.getenv("DB_PORT", "5432"),
    "database": os.getenv("DB_NAME", "motor_vibratii"),
    "user": os.getenv("DB_USER", "postgres"),
    "password": os.getenv("DB_PASSWORD"),
}

GROQ_API_KEY = os.getenv("GROQ_API_KEY")
if not GROQ_API_KEY:
    raise RuntimeError("GROQ_API_KEY lipsă din .env")


def get_connection():
    return psycopg2.connect(**DB_CONFIG)


def init_db():
    conn = get_connection()
    cur = conn.cursor()
    cur.execute("""
        CREATE TABLE IF NOT EXISTS public.analize_motor (
            id SERIAL PRIMARY KEY,
            rpm FLOAT NOT NULL,
            zgomot FLOAT NOT NULL,
            frecventa_fundamentala FLOAT,
            putere_totala FLOAT,
            diagnostic VARCHAR(255),
            data_salvarii TIMESTAMP DEFAULT NOW()
        );
    """)
    conn.commit()
    cur.close()
    conn.close()


try:
    init_db()
    print("Conexiune PostgreSQL OK si tabela verificata.")
except Exception as e:
    print(f"Eroare la initializarea DB: {e}")


# ─── Modele ───────────────────────────────────────────────────────

class MotorReading(BaseModel):
    rpm: float
    zgomot: float
    frecventa_fundamentala: Optional[float] = None
    putere_totala: Optional[float] = None
    diagnostic: Optional[str] = None


class ChatMessage(BaseModel):
    role: str
    parts: List[dict]


class ChatRequest(BaseModel):
    messages: List[ChatMessage]
    system_prompt: str = ""


# ─── AI endpoint (Groq - GRATUIT) ─────────────────────────────────

@app.post("/api/chatbot")
async def ask_groq(req: ChatRequest):
    url = "https://api.groq.com/openai/v1/chat/completions"

    groq_messages = []

    # System prompt (limitat la 2000 caractere ca sa nu depasim limita)
    if req.system_prompt:
        groq_messages.append({
            "role": "system",
            "content": req.system_prompt[:2000]
        })

    # Convertim mesajele din format Gemini in format OpenAI
    for msg in req.messages:
        role = "assistant" if msg.role == "model" else "user"
        text = msg.parts[0].get("text", "") if msg.parts else ""
        if text.strip():
            groq_messages.append({
                "role": role,
                "content": text
            })

    print(f"[DEBUG] groq_messages count: {len(groq_messages)}")
    for m in groq_messages:
        print(f"  role={m['role']}, content_len={len(m['content'])}")

    # Groq are nevoie de cel putin un mesaj user
    user_msgs = [m for m in groq_messages if m["role"] == "user"]
    if not user_msgs:
        raise HTTPException(status_code=400, detail="Nu exista mesaje de la user.")

    headers = {
        "Authorization": f"Bearer {GROQ_API_KEY}",
        "Content-Type": "application/json"
    }

    payload = {
        "model": "llama-3.1-8b-instant",
        "messages": groq_messages,
        "temperature": 0.7,
        "max_tokens": 1024,
    }

    try:
        response = requests.post(url, json=payload, headers=headers, timeout=30)
        print(f"[DEBUG] Groq status: {response.status_code}")
        print(f"[DEBUG] Groq body: {response.text[:500]}")
        response.raise_for_status()
        data = response.json()
        text = data["choices"][0]["message"]["content"]
        return {"response": text}
    except requests.exceptions.HTTPError as e:
        detail = response.text if response else str(e)
        raise HTTPException(status_code=response.status_code, detail=f"Groq error: {detail}")
    except requests.exceptions.ConnectionError:
        raise HTTPException(status_code=503, detail="Nu pot contacta Groq API.")
    except KeyError:
        raise HTTPException(status_code=500, detail="Raspuns neasteptat de la Groq API.")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Eroare interna: {str(e)}")


# ─── DB endpoints ─────────────────────────────────────────────────

@app.post("/api/readings")
def save_reading(reading: MotorReading):
    try:
        conn = get_connection()
        cur = conn.cursor()
        cur.execute("""
            INSERT INTO public.analize_motor
                (rpm, zgomot, frecventa_fundamentala, putere_totala, diagnostic, data_salvarii)
            VALUES (%s, %s, %s, %s, %s, NOW())
            RETURNING id, data_salvarii
        """, (reading.rpm, reading.zgomot, reading.frecventa_fundamentala, reading.putere_totala, reading.diagnostic))
        row = cur.fetchone()
        conn.commit()
        cur.close()
        conn.close()
        return {"id": row[0], "data_salvarii": str(row[1])}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Eroare salvare: {str(e)}")


@app.get("/api/readings")
def get_readings(limit: int = 50):
    try:
        conn = get_connection()
        cur = conn.cursor(cursor_factory=RealDictCursor)
        cur.execute("SELECT * FROM public.analize_motor ORDER BY data_salvarii DESC LIMIT %s", (limit,))
        rows = cur.fetchall()
        cur.close()
        conn.close()
        return list(rows)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Eroare citire: {str(e)}")


@app.get("/api/readings/latest")
def get_latest():
    try:
        conn = get_connection()
        cur = conn.cursor(cursor_factory=RealDictCursor)
        cur.execute("SELECT * FROM public.analize_motor ORDER BY data_salvarii DESC LIMIT 1")
        row = cur.fetchone()
        cur.close()
        conn.close()
        if not row:
            raise HTTPException(status_code=404, detail="Nu exista date inregistrate.")
        return dict(row)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Eroare DB: {str(e)}")


@app.get("/api/readings/stats")
def get_stats():
    try:
        conn = get_connection()
        cur = conn.cursor(cursor_factory=RealDictCursor)
        cur.execute("""
            SELECT
                COUNT(*) as total_readings,
                ROUND(AVG(rpm)::numeric, 2) as avg_rpm,
                ROUND(AVG(zgomot)::numeric, 4) as avg_noise,
                ROUND(MAX(zgomot)::numeric, 4) as max_noise,
                ROUND(MIN(rpm)::numeric, 2) as min_rpm,
                ROUND(MAX(rpm)::numeric, 2) as max_rpm,
                COUNT(CASE WHEN zgomot > 0.3 THEN 1 END) as alert_count
            FROM public.analize_motor
        """)
        row = cur.fetchone()
        cur.close()
        conn.close()
        return dict(row)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Eroare stats: {str(e)}")


@app.get("/")
def root():
    return {"status": "VibroScan API activ"}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000, reload=True)