@echo off
cd /d "%~dp0"

echo ============================================
echo  Streamline Ideas - Local AI Setup
echo ============================================
echo.

:: Check Python
where python >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Python not found.
    echo Please install Python 3.9+ from https://python.org and try again.
    pause
    exit /b 1
)

:: Check Ollama
where ollama >nul 2>&1
if errorlevel 1 (
    echo [SETUP NEEDED] Ollama is not installed.
    echo.
    echo Please do the following:
    echo  1. Go to https://ollama.com and download Ollama for Windows
    echo  2. Install it, then run:  ollama pull qwen2.5-coder:7b
    echo  3. Double-click this start.bat again
    echo.
    pause
    exit /b 1
)

:: Check if Ollama is running, if not start it
curl -s http://localhost:11434 >nul 2>&1
if errorlevel 1 (
    echo Starting Ollama in background...
    start /min "" ollama serve
    timeout /t 3 /nobreak >nul
)

:: Check if model is pulled
echo Checking for qwen2.5-coder:7b model...
ollama list | findstr "qwen2.5-coder:7b" >nul 2>&1
if errorlevel 1 (
    echo [SETUP] Model not found. Downloading qwen2.5-coder:7b (~4.7GB)...
    echo This only happens once. Grab a coffee!
    echo.
    ollama pull qwen2.5-coder:7b
)

:: Create venv if needed
if not exist "venv" (
    echo Creating Python virtual environment...
    python -m venv venv
)

call venv\Scripts\activate.bat

:: Install dependencies
echo Installing Python dependencies...
pip install -q -r requirements-local.txt

echo.
echo ============================================
echo  App running at: http://localhost:8000
echo  Press Ctrl+C to stop.
echo ============================================
echo.

start http://localhost:8000
uvicorn main:app --host 0.0.0.0 --port 8000

pause
