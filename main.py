import os
import json
import uuid
import re
import base64
from pathlib import Path
from datetime import datetime, date

from fastapi import FastAPI, File, UploadFile, HTTPException
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

# ── Rate limiting ──────────────────────────────────────────────────────────────
DAILY_LIMIT = int(os.getenv("DAILY_LIMIT", "50"))   # max ideas per day
MAX_UPLOAD_MB = int(os.getenv("MAX_UPLOAD_MB", "25")) # max audio file size

_rate: dict = {"date": date.today(), "count": 0}

def _check_rate_limit():
    today = date.today()
    if _rate["date"] != today:
        _rate["date"] = today
        _rate["count"] = 0
    if _rate["count"] >= DAILY_LIMIT:
        raise HTTPException(
            status_code=429,
            detail=f"Daily limit of {DAILY_LIMIT} ideas reached. Resets at midnight."
        )
    _rate["count"] += 1

try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass

app = FastAPI()

UPLOADS_DIR = Path("uploads")
SESSIONS_DIR = Path("sessions")
UPLOADS_DIR.mkdir(exist_ok=True)
SESSIONS_DIR.mkdir(exist_ok=True)

# ── Mode detection ─────────────────────────────────────────────────────────────
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY")
USE_CLOUD = bool(GEMINI_API_KEY)

if USE_CLOUD:
    print("Mode: Cloud (Gemini API)")
    import google.generativeai as genai
    genai.configure(api_key=GEMINI_API_KEY)
    gemini_model = genai.GenerativeModel("gemini-2.5-flash")
else:
    print("Mode: Local (Ollama + faster-whisper)")
    import requests
    from faster_whisper import WhisperModel
    WHISPER_MODEL_SIZE = os.getenv("WHISPER_MODEL", "base")
    OLLAMA_URL = "http://localhost:11434/api/generate"
    OLLAMA_MODEL = os.getenv("OLLAMA_MODEL", "qwen2.5-coder:7b")
    print(f"Loading Whisper '{WHISPER_MODEL_SIZE}' model...")
    whisper_model = WhisperModel(WHISPER_MODEL_SIZE, device="cpu", compute_type="int8")
    print("Whisper model ready.")

# ── Prompts ────────────────────────────────────────────────────────────────────
TRANSCRIBE_PROMPT = "Transcribe this audio accurately. Return only the transcription text, nothing else."

CONCEPT_PROMPT = """You are a product designer and prototyper. Given a raw voice memo transcript of someone's idea, you will:
1. Extract and structure the idea into a clear concept
2. Generate a self-contained, working HTML/CSS/JS prototype that visually demonstrates the core concept

Return ONLY valid JSON — no markdown, no code fences, no extra text — in exactly this shape:
{
  "title": "Short catchy name for the idea",
  "one_liner": "One sentence that captures what this is",
  "problem": "The problem this solves",
  "solution": "How the idea solves it",
  "key_features": ["Feature 1", "Feature 2", "Feature 3"],
  "target_user": "Who this is for",
  "prototype_html": "<!DOCTYPE html>..."
}

The prototype_html must be a complete, standalone HTML file with all CSS and JS inline.
Make it look modern and polished — use a clean color palette, good typography, and demonstrate the core UI/UX concept.
Do NOT use external CDN links in the prototype — keep it fully self-contained.
The prototype should be interactive where it makes sense (buttons, inputs, mock data, etc.).
Return ONLY the JSON object. No explanation. No markdown.

Transcript:
"""


class GenerateRequest(BaseModel):
    session_id: str
    transcript: str


# ── Helpers ────────────────────────────────────────────────────────────────────
def _parse_json(raw: str) -> dict:
    raw = raw.strip()
    # Strip markdown code fences if present
    raw = re.sub(r"^```(?:json)?\s*", "", raw)
    raw = re.sub(r"\s*```$", "", raw)
    try:
        return json.loads(raw.strip())
    except json.JSONDecodeError:
        match = re.search(r"\{.*\}", raw, re.DOTALL)
        if match:
            return json.loads(match.group())
        raise ValueError("No valid JSON found in response")


def _mime_type(ext: str) -> str:
    return {
        ".mp3": "audio/mp3",
        ".mp4": "audio/mp4",
        ".m4a": "audio/mp4",
        ".wav": "audio/wav",
        ".ogg": "audio/ogg",
        ".webm": "audio/webm",
    }.get(ext, "audio/webm")


def _transcribe_cloud(audio_path: Path) -> str:
    ext = audio_path.suffix.lower()
    with open(audio_path, "rb") as f:
        audio_data = f.read()
    response = gemini_model.generate_content([
        TRANSCRIBE_PROMPT,
        {"mime_type": _mime_type(ext), "data": base64.b64encode(audio_data).decode()}
    ])
    return response.text.strip()


def _transcribe_local(audio_path: Path) -> str:
    segments, _ = whisper_model.transcribe(str(audio_path), beam_size=5)
    return " ".join(s.text.strip() for s in segments).strip()


def _generate_cloud(transcript: str) -> str:
    response = gemini_model.generate_content(CONCEPT_PROMPT + transcript)
    return response.text


def _generate_local(transcript: str) -> str:
    response = requests.post(
        OLLAMA_URL,
        json={
            "model": OLLAMA_MODEL,
            "prompt": CONCEPT_PROMPT + transcript,
            "stream": False,
            "options": {"temperature": 0.7, "num_ctx": 8192, "num_predict": 4096},
        },
        timeout=120,
    )
    response.raise_for_status()
    return response.json().get("response", "")


# ── Routes ─────────────────────────────────────────────────────────────────────
@app.post("/api/transcribe-chunk")
async def transcribe_chunk(file: UploadFile = File(...)):
    ext = Path(file.filename).suffix.lower() or ".webm"
    tmp_path = UPLOADS_DIR / f"chunk_{uuid.uuid4()}{ext}"
    contents = await file.read()
    if len(contents) < 1000:
        return {"transcript": ""}
    with open(tmp_path, "wb") as f:
        f.write(contents)
    try:
        transcript = _transcribe_cloud(tmp_path) if USE_CLOUD else _transcribe_local_chunk(tmp_path)
    except Exception:
        transcript = ""
    finally:
        if tmp_path.exists():
            tmp_path.unlink()
    return {"transcript": transcript.strip()}


def _transcribe_local_chunk(audio_path: Path) -> str:
    segments, _ = whisper_model.transcribe(str(audio_path), beam_size=1, vad_filter=True)
    return " ".join(s.text.strip() for s in segments)


@app.post("/api/transcribe")
async def transcribe_audio(file: UploadFile = File(...)):
    allowed_types = {".m4a", ".mp3", ".wav", ".webm", ".ogg", ".mp4"}
    ext = Path(file.filename).suffix.lower()
    if ext not in allowed_types:
        raise HTTPException(status_code=400, detail=f"Unsupported file type: {ext}")

    session_id = str(uuid.uuid4())
    audio_path = UPLOADS_DIR / f"{session_id}{ext}"
    contents = await file.read()

    if len(contents) > MAX_UPLOAD_MB * 1024 * 1024:
        raise HTTPException(status_code=413, detail=f"File too large. Max size is {MAX_UPLOAD_MB}MB.")

    with open(audio_path, "wb") as f:
        f.write(contents)

    try:
        transcript = _transcribe_cloud(audio_path) if USE_CLOUD else _transcribe_local(audio_path)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Transcription failed: {str(e)}")
    finally:
        if audio_path.exists():
            audio_path.unlink()

    return {"session_id": session_id, "transcript": transcript}


@app.get("/api/usage")
async def get_usage():
    today = date.today()
    if _rate["date"] != today:
        return {"used": 0, "limit": DAILY_LIMIT, "remaining": DAILY_LIMIT}
    return {
        "used": _rate["count"],
        "limit": DAILY_LIMIT,
        "remaining": max(0, DAILY_LIMIT - _rate["count"])
    }


@app.post("/api/generate")
async def generate_concept(request: GenerateRequest):
    if not request.transcript.strip():
        raise HTTPException(status_code=400, detail="Transcript cannot be empty")
    _check_rate_limit()
    try:
        raw = _generate_cloud(request.transcript) if USE_CLOUD else _generate_local(request.transcript)
        result = _parse_json(raw)
    except ValueError:
        raise HTTPException(status_code=500, detail="Model did not return valid JSON. Try regenerating.")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Generation failed: {str(e)}")

    result["session_id"] = request.session_id
    result["transcript"] = request.transcript

    session_path = SESSIONS_DIR / f"{request.session_id}.json"
    with open(session_path, "w") as f:
        json.dump(result, f, indent=2)

    return result


@app.get("/api/sessions")
async def list_sessions():
    sessions = []
    for path in sorted(SESSIONS_DIR.glob("*.json"), key=lambda p: p.stat().st_mtime, reverse=True):
        try:
            with open(path) as f:
                data = json.load(f)
            sessions.append({
                "session_id": data.get("session_id", path.stem),
                "title": data.get("title", "Untitled"),
                "one_liner": data.get("one_liner", ""),
            })
        except Exception:
            continue
    return sessions


@app.get("/api/session/{session_id}")
async def get_session(session_id: str):
    path = SESSIONS_DIR / f"{session_id}.json"
    if not path.exists():
        raise HTTPException(status_code=404, detail="Session not found")
    with open(path) as f:
        return json.load(f)


app.mount("/", StaticFiles(directory="static", html=True), name="static")
