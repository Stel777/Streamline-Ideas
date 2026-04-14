import os
import json
import uuid
import re
import base64
import time
from pathlib import Path
from datetime import date

from fastapi import FastAPI, File, UploadFile, HTTPException
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

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

# ── Rate limiting ──────────────────────────────────────────────────────────────
DAILY_LIMIT = int(os.getenv("DAILY_LIMIT", "50"))
MAX_UPLOAD_MB = int(os.getenv("MAX_UPLOAD_MB", "25"))
_rate: dict = {"date": date.today(), "count": 0}

def _check_rate_limit():
    today = date.today()
    if _rate["date"] != today:
        _rate["date"] = today
        _rate["count"] = 0
    if _rate["count"] >= DAILY_LIMIT:
        raise HTTPException(status_code=429, detail=f"Daily limit of {DAILY_LIMIT} ideas reached. Resets at midnight.")
    _rate["count"] += 1

# ── Provider setup ─────────────────────────────────────────────────────────────
GEMINI_API_KEY  = os.getenv("GEMINI_API_KEY")
MISTRAL_API_KEY = os.getenv("MISTRAL_API_KEY")
USE_CLOUD       = bool(GEMINI_API_KEY or MISTRAL_API_KEY)

gemini_model   = None
mistral_client = None

if GEMINI_API_KEY:
    import google.generativeai as genai
    genai.configure(api_key=GEMINI_API_KEY)
    gemini_model = genai.GenerativeModel("gemini-2.0-flash")
    print("Provider ready: Gemini 2.0 Flash")

if MISTRAL_API_KEY:
    from mistralai import Mistral
    mistral_client = Mistral(api_key=MISTRAL_API_KEY)
    print("Provider ready: Mistral")

if not USE_CLOUD:
    print("Mode: Local (Ollama + faster-whisper)")
    import requests as _requests
    from faster_whisper import WhisperModel
    WHISPER_MODEL_SIZE = os.getenv("WHISPER_MODEL", "base")
    OLLAMA_URL   = "http://localhost:11434/api/generate"
    OLLAMA_MODEL = os.getenv("OLLAMA_MODEL", "qwen2.5-coder:7b")
    print(f"Loading Whisper '{WHISPER_MODEL_SIZE}' model...")
    whisper_model = WhisperModel(WHISPER_MODEL_SIZE, device="cpu", compute_type="int8")
    print("Whisper model ready.")
else:
    whisper_model = None

# ── Prompts ────────────────────────────────────────────────────────────────────
TRANSCRIBE_PROMPT = "Transcribe this audio accurately. Return only the transcription text, nothing else."

CONCEPT_PROMPT = """You are a product designer and prototyper. Given a raw voice memo transcript of someone's idea, extract and structure the idea then generate a self-contained working HTML/CSS/JS prototype.

Return ONLY valid JSON — no markdown, no code fences, no extra text:
{
  "title": "Short catchy name for the idea",
  "one_liner": "One sentence that captures what this is",
  "problem": "The problem this solves",
  "solution": "How the idea solves it",
  "key_features": ["Feature 1", "Feature 2", "Feature 3"],
  "target_user": "Who this is for",
  "prototype_html": "<!DOCTYPE html>..."
}

The prototype_html must be a complete standalone HTML file with all CSS and JS inline, no external CDNs.
Make it look modern and polished with a clean color palette and interactive elements where it makes sense.
Return ONLY the JSON object. No explanation. No markdown.

Transcript:
"""

class GenerateRequest(BaseModel):
    session_id: str
    transcript: str

# ── Helpers ────────────────────────────────────────────────────────────────────
def _is_rate_limit(e: Exception) -> bool:
    return '429' in str(e) or 'rate_limit' in str(e).lower() or 'quota' in str(e).lower()

def _retry_delay(e: Exception) -> int:
    match = re.search(r'retry in (\d+)', str(e))
    return int(match.group(1)) + 1 if match else 5

def _parse_json(raw: str) -> dict:
    raw = raw.strip()
    raw = re.sub(r"^```(?:json)?\s*", "", raw)
    raw = re.sub(r"\s*```$", "", raw)
    try:
        return json.loads(raw.strip())
    except json.JSONDecodeError:
        match = re.search(r"\{.*\}", raw, re.DOTALL)
        if match:
            return json.loads(match.group())
        raise ValueError("No valid JSON in response")

def _mime_type(ext: str) -> str:
    return {".mp3":"audio/mp3",".mp4":"audio/mp4",".m4a":"audio/mp4",
            ".wav":"audio/wav",".ogg":"audio/ogg",".webm":"audio/webm"}.get(ext,"audio/webm")

# ── Transcription with fallback ────────────────────────────────────────────────
def _transcribe_gemini(audio_path: Path) -> str:
    ext = audio_path.suffix.lower()
    with open(audio_path, "rb") as f:
        data = base64.b64encode(f.read()).decode()
    response = gemini_model.generate_content([
        TRANSCRIBE_PROMPT,
        {"mime_type": _mime_type(ext), "data": data}
    ])
    return response.text.strip()

def _transcribe_mistral(audio_path: Path) -> str:
    # Mistral doesn't have audio transcription — fall through to next provider
    raise NotImplementedError("Mistral does not support audio transcription")

def _transcribe_local(audio_path: Path, beam_size=5) -> str:
    segments, _ = whisper_model.transcribe(str(audio_path), beam_size=beam_size)
    return " ".join(s.text.strip() for s in segments).strip()

def transcribe_with_fallback(audio_path: Path) -> tuple[str, str]:
    """Returns (transcript, provider_used). Gemini only for now — Mistral has no audio API."""
    if gemini_model:
        last_err = None
        for attempt in range(3):
            try:
                print("Transcribing with Gemini...")
                return _transcribe_gemini(audio_path), "Gemini"
            except Exception as e:
                if _is_rate_limit(e):
                    wait = _retry_delay(e)
                    print(f"Gemini rate limited, waiting {wait}s (attempt {attempt+1}/3)...")
                    time.sleep(wait)
                    last_err = e
                else:
                    raise
        raise last_err or RuntimeError("Gemini transcription failed after retries")
    raise RuntimeError("No transcription provider available")

# ── Generation with fallback ───────────────────────────────────────────────────
def _generate_gemini(transcript: str) -> str:
    response = gemini_model.generate_content(CONCEPT_PROMPT + transcript)
    return response.text

def _generate_mistral(transcript: str) -> str:
    response = mistral_client.chat.complete(
        model="mistral-large-latest",
        messages=[{"role": "user", "content": CONCEPT_PROMPT + transcript}],
        max_tokens=4096,
        temperature=0.7,
    )
    return response.choices[0].message.content

def _generate_local(transcript: str) -> str:
    import requests as _requests
    response = _requests.post(
        OLLAMA_URL,
        json={"model": OLLAMA_MODEL, "prompt": CONCEPT_PROMPT + transcript,
              "stream": False, "options": {"temperature": 0.7, "num_ctx": 8192, "num_predict": 4096}},
        timeout=120,
    )
    response.raise_for_status()
    return response.json().get("response", "")

def generate_with_fallback(transcript: str) -> tuple[str, str]:
    """Returns (raw_json_str, provider_used)"""
    providers = []
    if gemini_model:
        providers.append(("Gemini", _generate_gemini))
    if mistral_client:
        providers.append(("Mistral", _generate_mistral))
    if not USE_CLOUD:
        providers.append(("Local Ollama", _generate_local))

    last_err = None
    for name, fn in providers:
        try:
            print(f"Generating with {name}...")
            return fn(transcript), name
        except Exception as e:
            if _is_rate_limit(e):
                print(f"{name} rate limited, trying next provider...")
                last_err = e
                continue
            raise

    # All rate limited — wait and retry first
    if last_err and providers:
        wait = _retry_delay(last_err)
        print(f"All providers rate limited. Waiting {wait}s then retrying...")
        time.sleep(wait)
        name, fn = providers[0]
        return fn(transcript), name

    raise last_err or RuntimeError("No generation providers available")

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
        if USE_CLOUD:
            transcript, _ = transcribe_with_fallback(tmp_path)
        else:
            segments, _ = whisper_model.transcribe(str(tmp_path), beam_size=1, vad_filter=True)
            transcript = " ".join(s.text.strip() for s in segments)
    except Exception:
        transcript = ""
    finally:
        if tmp_path.exists():
            tmp_path.unlink()
    return {"transcript": transcript.strip()}


@app.post("/api/transcribe")
async def transcribe_audio(file: UploadFile = File(...)):
    allowed_types = {".m4a", ".mp3", ".wav", ".webm", ".ogg", ".mp4"}
    ext = Path(file.filename).suffix.lower()
    if ext not in allowed_types:
        raise HTTPException(status_code=400, detail=f"Unsupported file type: {ext}")

    contents = await file.read()
    if len(contents) > MAX_UPLOAD_MB * 1024 * 1024:
        raise HTTPException(status_code=413, detail=f"File too large. Max {MAX_UPLOAD_MB}MB.")

    session_id = str(uuid.uuid4())
    audio_path = UPLOADS_DIR / f"{session_id}{ext}"
    with open(audio_path, "wb") as f:
        f.write(contents)

    try:
        if USE_CLOUD:
            transcript, provider = transcribe_with_fallback(audio_path)
            print(f"Transcribed via {provider}")
        else:
            transcript = _transcribe_local(audio_path)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Transcription failed: {str(e)}")
    finally:
        if audio_path.exists():
            audio_path.unlink()

    return {"session_id": session_id, "transcript": transcript}


@app.post("/api/generate")
async def generate_concept(request: GenerateRequest):
    if not request.transcript.strip():
        raise HTTPException(status_code=400, detail="Transcript cannot be empty")
    _check_rate_limit()

    try:
        raw, provider = generate_with_fallback(request.transcript)
        print(f"Generated via {provider}")
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


@app.get("/api/usage")
async def get_usage():
    today = date.today()
    if _rate["date"] != today:
        return {"used": 0, "limit": DAILY_LIMIT, "remaining": DAILY_LIMIT}
    return {"used": _rate["count"], "limit": DAILY_LIMIT, "remaining": max(0, DAILY_LIMIT - _rate["count"])}


@app.get("/api/sessions")
async def list_sessions():
    sessions = []
    for path in sorted(SESSIONS_DIR.glob("*.json"), key=lambda p: p.stat().st_mtime, reverse=True):
        try:
            with open(path) as f:
                data = json.load(f)
            sessions.append({"session_id": data.get("session_id", path.stem),
                              "title": data.get("title", "Untitled"),
                              "one_liner": data.get("one_liner", "")})
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
