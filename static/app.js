function streamlineApp() {
  return {
    state: 'idle',       // idle | recording | transcribing | transcript | interview | generating | result
    transcript: '',
    liveTranscript: '',
    result: {},
    history: [],
    sidebarOpen: false,
    errorMsg: '',
    copied: false,
    dragOver: false,
    recordingSeconds: 0,
    generatingLabel: 'Building your concept',

    // Interview
    interviewAnswers: [],   // [{question, answer}]
    currentQuestion: '',
    currentAnswer: '',

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

    // ── Live recording ─────────────────────────────────────────
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
          const blob = new Blob(this._audioChunks, { type: 'audio/webm' });
          const file = new File([blob], 'recording.webm', { type: 'audio/webm' });
          this.state = 'transcribing';
          await this.uploadFile(file);
        };

        this._mediaRecorder.start();
        this._chunkTimer = setInterval(() => this._transcribeChunkSoFar(), 3000);
      } catch (err) {
        this.showError('Microphone access denied or unavailable.');
      }
    },

    async _transcribeChunkSoFar() {
      if (!this._audioChunks.length) return;
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

    // ── Interview (Deep Dive) ──────────────────────────────────
    async startInterview() {
      this.interviewAnswers = [];
      this.currentAnswer = '';
      this.state = 'interview';
      await this._fetchNextQuestion();
    },

    async _fetchNextQuestion() {
      try {
        const res = await fetch('/api/interview', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ transcript: this.transcript, answers: this.interviewAnswers }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.detail);
        this.currentQuestion = data.question;
      } catch (err) {
        this.showError('Could not load question: ' + err.message);
      }
    },

    async submitAnswer() {
      if (!this.currentAnswer.trim() && !this.currentQuestion) return;
      this.interviewAnswers.push({ question: this.currentQuestion, answer: this.currentAnswer.trim() });
      this.currentAnswer = '';

      if (this.interviewAnswers.length >= 5) {
        await this._compileInterview();
      } else {
        await this._fetchNextQuestion();
      }
    },

    async skipAnswer() {
      this.interviewAnswers.push({ question: this.currentQuestion, answer: '(skipped)' });
      this.currentAnswer = '';
      if (this.interviewAnswers.length >= 5) {
        await this._compileInterview();
      } else {
        await this._fetchNextQuestion();
      }
    },

    async _compileInterview() {
      this.state = 'generating';
      this.generatingLabel = 'Compiling your deep dive...';
      const sessionId = this._currentSessionId || crypto.randomUUID();
      this._currentSessionId = sessionId;
      try {
        const res = await fetch('/api/interview/compile', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ session_id: sessionId, transcript: this.transcript, answers: this.interviewAnswers }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.detail || 'Compilation failed');
        this.result = data;
        this.state = 'result';
        this.loadHistory();
        await this.$nextTick();
        this._renderPrototype(data.prototype_html);
      } catch (err) {
        this.showError(err.message);
        this.state = 'transcript';
      }
    },

    // ── Quick Generate ─────────────────────────────────────────
    async generateConcept() {
      if (!this.transcript.trim()) return;
      this.state = 'generating';
      this.generatingLabel = 'Building your concept';
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
        await this.$nextTick();
        this._renderPrototype(data.prototype_html);
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

    // ── Prototype render ───────────────────────────────────────
    _renderPrototype(html) {
      const frame = document.getElementById('prototype-frame');
      if (!frame || !html) return;
      frame.srcdoc = html;
    },

    // ── Exports ────────────────────────────────────────────────
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
      const interviewSection = r.interview_answers?.length
        ? `\n## Interview Q&A\n${r.interview_answers.map(a => `**Q:** ${a.question}\n**A:** ${a.answer}`).join('\n\n')}\n`
        : '';
      const md = `# ${r.title}\n\n> ${r.one_liner}\n\n## Problem\n${r.problem}\n\n## Solution\n${r.solution}\n\n## Key Features\n${(r.key_features || []).map(f => `- ${f}`).join('\n')}\n\n## Target User\n${r.target_user}\n${interviewSection}\n---\n*Original transcript:*\n> ${r.transcript}\n`;
      this._download(md, `${this._slug()}-brief.md`, 'text/markdown');
    },

    exportClaudePrompt() {
      const r = this.result;
      const interviewContext = r.interview_answers?.length
        ? `\n## Discovery Interview\n${r.interview_answers.map(a => `Q: ${a.question}\nA: ${a.answer}`).join('\n\n')}\n`
        : '';
      const prompt = `# Build and improve this app idea: ${r.title}\n\n## Concept\n${r.one_liner}\n\n**Problem:** ${r.problem}\n**Solution:** ${r.solution}\n**Target user:** ${r.target_user}\n\n**Key features:**\n${(r.key_features || []).map(f => `- ${f}`).join('\n')}\n${interviewContext}\n## Starting prototype (HTML)\nUse this as a reference for the UI direction, then build a proper production-quality implementation.\n\n\`\`\`html\n${r.prototype_html}\n\`\`\`\n\n## Instructions\n1. Analyse the prototype and concept above\n2. Build a well-structured, production-ready version of this app\n3. Improve the UI/UX beyond the prototype\n4. Add missing functionality that makes sense for the concept\n5. Use modern best practices for whatever stack you choose\n`;
      this._download(prompt, `${this._slug()}-claude-prompt.md`, 'text/markdown');
    },

    // ── Misc ───────────────────────────────────────────────────
    copyTranscript() {
      navigator.clipboard.writeText(this.transcript).then(() => {
        this.copied = true;
        setTimeout(() => this.copied = false, 2000);
      });
    },

    resetAll() {
      this.state = 'idle';
      this.transcript = '';
      this.liveTranscript = '';
      this.result = {};
      this.interviewAnswers = [];
      this.currentQuestion = '';
      this.currentAnswer = '';
      this._currentSessionId = null;
      this.errorMsg = '';
    },

    showError(msg) {
      this.errorMsg = msg;
      setTimeout(() => this.errorMsg = '', 6000);
    },
  };
}
