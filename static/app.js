function streamlineApp() {
  return {
    state: 'idle',
    transcript: '',
    liveTranscript: '',
    result: {},
    history: [],
    sidebarOpen: false,
    errorMsg: '',
    copied: false,
    dragOver: false,
    recordingSeconds: 0,
    _recordingTimer: null,
    _mediaRecorder: null,
    _audioChunks: [],
    _chunkTimer: null,
    _currentSessionId: null,

    init() {
      this.loadHistory();
    },

    // ── Sidebar ────────────────────────────────────────────────
    async toggleSidebar() {
      this.sidebarOpen = !this.sidebarOpen;
      if (this.sidebarOpen) await this.loadHistory();
    },

    async loadHistory() {
      try {
        const res = await fetch('/api/sessions');
        if (res.ok) this.history = await res.json();
      } catch {}
    },

    async loadSession(sessionId) {
      try {
        const res = await fetch(`/api/session/${sessionId}`);
        if (!res.ok) throw new Error();
        this.result = await res.json();
        this.transcript = this.result.transcript || '';
        this.state = 'result';
        this.sidebarOpen = false;
      } catch {
        this.showError('Could not load session.');
      }
    },

    // ── File upload ────────────────────────────────────────────
    handleFileSelect(event) {
      const file = event.target.files[0];
      if (file) this.uploadFile(file);
    },

    handleDrop(event) {
      this.dragOver = false;
      const file = event.dataTransfer.files[0];
      if (file) this.uploadFile(file);
    },

    async uploadFile(file) {
      this.state = 'transcribing';
      const formData = new FormData();
      formData.append('file', file);
      try {
        const res = await fetch('/api/transcribe', { method: 'POST', body: formData });
        const data = await res.json();
        if (!res.ok) throw new Error(data.detail || 'Transcription failed');
        this.transcript = data.transcript;
        this.state = 'transcript';
      } catch (err) {
        this.showError(err.message);
        this.state = 'idle';
      }
    },

    // ── Live recording with live transcription ─────────────────
    async startRecording() {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        this._audioChunks = [];
        this.liveTranscript = '';
        this.state = 'recording';
        this.recordingSeconds = 0;
        this._recordingTimer = setInterval(() => this.recordingSeconds++, 1000);

        this._mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });

        this._mediaRecorder.ondataavailable = (e) => {
          if (e.data.size > 0) this._audioChunks.push(e.data);
        };

        this._mediaRecorder.onstop = async () => {
          stream.getTracks().forEach(t => t.stop());
          clearInterval(this._chunkTimer);
          // Final full transcription
          const blob = new Blob(this._audioChunks, { type: 'audio/webm' });
          const file = new File([blob], 'recording.webm', { type: 'audio/webm' });
          this.state = 'transcribing';
          await this.uploadFile(file);
        };

        // Start recording in 3s chunks for live preview
        this._mediaRecorder.start();
        this._chunkTimer = setInterval(() => this._transcribeChunkSoFar(), 3000);

      } catch (err) {
        this.showError('Microphone access denied or unavailable.');
      }
    },

    async _transcribeChunkSoFar() {
      if (!this._audioChunks.length && this._mediaRecorder?.state === 'recording') return;
      // Request a chunk without stopping
      this._mediaRecorder.requestData();
      await new Promise(r => setTimeout(r, 100));
      if (!this._audioChunks.length) return;

      const blob = new Blob([...this._audioChunks], { type: 'audio/webm' });
      if (blob.size < 1000) return;

      const formData = new FormData();
      formData.append('file', new File([blob], 'chunk.webm', { type: 'audio/webm' }));
      try {
        const res = await fetch('/api/transcribe-chunk', { method: 'POST', body: formData });
        if (res.ok) {
          const data = await res.json();
          if (data.transcript) this.liveTranscript = data.transcript;
        }
      } catch {}
    },

    stopRecording() {
      clearInterval(this._recordingTimer);
      clearInterval(this._chunkTimer);
      if (this._mediaRecorder && this._mediaRecorder.state !== 'inactive') {
        this._mediaRecorder.stop();
      }
    },

    formatTime(seconds) {
      const m = String(Math.floor(seconds / 60)).padStart(2, '0');
      const s = String(seconds % 60).padStart(2, '0');
      return `${m}:${s}`;
    },

    // ── Generate ───────────────────────────────────────────────
    async generateConcept() {
      if (!this.transcript.trim()) return;
      this.state = 'generating';
      const sessionId = this._currentSessionId || crypto.randomUUID();
      this._currentSessionId = sessionId;
      try {
        const res = await fetch('/api/generate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ session_id: sessionId, transcript: this.transcript }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.detail || 'Generation failed');
        this.result = data;
        this.state = 'result';
        this.loadHistory();
      } catch (err) {
        this.showError(err.message);
        this.state = 'transcript';
      }
    },

    async regenerate() {
      this._currentSessionId = crypto.randomUUID();
      this.state = 'transcript';
      await this.$nextTick();
      this.generateConcept();
    },

    // ── Actions ────────────────────────────────────────────────
    copyTranscript() {
      navigator.clipboard.writeText(this.transcript).then(() => {
        this.copied = true;
        setTimeout(() => this.copied = false, 2000);
      });
    },

    downloadPrototype() {
      const blob = new Blob([this.result.prototype_html], { type: 'text/html' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${(this.result.title || 'prototype').replace(/\s+/g, '-').toLowerCase()}.html`;
      a.click();
      URL.revokeObjectURL(a.href);
    },

    resetAll() {
      this.state = 'idle';
      this.transcript = '';
      this.liveTranscript = '';
      this.result = {};
      this._currentSessionId = null;
      this.errorMsg = '';
    },

    showError(msg) {
      this.errorMsg = msg;
      setTimeout(() => this.errorMsg = '', 5000);
    },
  };
}
