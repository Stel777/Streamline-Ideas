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
        await this.$nextTick();
        this._renderPrototype(this.result.prototype_html);
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
        // Render prototype into iframe after DOM updates
        await this.$nextTick();
        this._renderPrototype(data.prototype_html);
      } catch (err) {
        this.showError(err.message);
        this.state = 'transcript';
      }
    },

    _renderPrototype(html) {
      const frame = document.getElementById('prototype-frame');
      if (!frame || !html) return;
      frame.srcdoc = html;
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

    _download(content, filename, type) {
      const blob = new Blob([content], { type });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = filename;
      a.click();
      URL.revokeObjectURL(a.href);
    },

    _slug() {
      return (this.result.title || 'idea').replace(/\s+/g, '-').toLowerCase();
    },

    exportHTML() {
      this._download(this.result.prototype_html, `${this._slug()}-prototype.html`, 'text/html');
    },

    exportJSON() {
      this._download(JSON.stringify(this.result, null, 2), `${this._slug()}.json`, 'application/json');
    },

    exportMarkdown() {
      const r = this.result;
      const md = `# ${r.title}

> ${r.one_liner}

## Problem
${r.problem}

## Solution
${r.solution}

## Key Features
${(r.key_features || []).map(f => `- ${f}`).join('\n')}

## Target User
${r.target_user}

---
*Original transcript:*
> ${r.transcript}
`;
      this._download(md, `${this._slug()}-brief.md`, 'text/markdown');
    },

    exportClaudePrompt() {
      const r = this.result;
      const prompt = `# Build and improve this app idea: ${r.title}

## Concept
${r.one_liner}

**Problem:** ${r.problem}
**Solution:** ${r.solution}
**Target user:** ${r.target_user}

**Key features:**
${(r.key_features || []).map(f => `- ${f}`).join('\n')}

## Starting prototype (HTML)
Below is a rough prototype I generated. Please use it as a reference for the UI direction, then build a proper, production-quality implementation with clean code structure, real functionality, and improvements.

\`\`\`html
${r.prototype_html}
\`\`\`

## Instructions
1. Analyse the prototype and concept above
2. Build a well-structured, production-ready version of this app
3. Improve the UI/UX beyond the prototype
4. Add any missing functionality that makes sense for the concept
5. Use modern best practices for whatever stack you choose
`;
      this._download(prompt, `${this._slug()}-claude-prompt.md`, 'text/markdown');
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
