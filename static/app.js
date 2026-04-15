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
    protoViewMode: 'desktop',
    protoFullscreen: false,
    protoLoading: false,
    protoTab: 'card',      // 'card' | 'prototype'

    // Interview
    interviewAnswers: [],   // [{question, answer}]
    currentQuestion: '',
    currentAnswer: '',

    _recordingTimer: null,
    _mediaRecorder: null,
    _audioChunks: [],
    _chunkTimer: null,
    _currentSessionId: null,
    _protoCardHtml: '',
    _protoPrototypeHtml: '',

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
      this._protoPrototypeHtml = html || '';
      this._protoCardHtml = this._buildConceptCard(this.result);
      this.protoTab = 'card';
      this._writeToFrame(this._protoCardHtml);
    },

    switchProtoTab(tab) {
      this.protoTab = tab;
      this._writeToFrame(tab === 'card' ? this._protoCardHtml : this._protoPrototypeHtml);
    },

    _writeToFrame(html) {
      const frame = document.getElementById('prototype-frame');
      if (!frame || !html) return;
      this.protoLoading = true;
      frame.srcdoc = html;
    },

    openPrototypeTab() {
      const html = this.protoTab === 'card' ? this._protoCardHtml : this._protoPrototypeHtml;
      if (!html) return;
      const blob = new Blob([html], { type: 'text/html' });
      const url = URL.createObjectURL(blob);
      window.open(url, '_blank');
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    },

    toggleProtoFullscreen() {
      this.protoFullscreen = !this.protoFullscreen;
    },

    // ── Concept card builder ────────────────────────────────────
    _esc(s) {
      return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    },

    _buildConceptCard(r) {
      const feats = (r.key_features || []).slice(0, 5);
      const nf = feats.length;
      const sep2Delay  = (1.5 + nf * 0.18 + 0.15).toFixed(2);
      const forDelay   = (1.5 + nf * 0.18 + 0.35).toFixed(2);
      const for2Delay  = (1.5 + nf * 0.18 + 0.5).toFixed(2);
      const footDelay  = (1.5 + nf * 0.18 + 0.85).toFixed(2);

      return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&display=swap" rel="stylesheet">
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
html,body{height:100%;overflow:hidden;background:#080810;color:#f0f0f5;font-family:'Inter',-apple-system,BlinkMacSystemFont,sans-serif;-webkit-font-smoothing:antialiased}
body{display:flex;align-items:center;justify-content:center;padding:32px 28px;position:relative}

/* ambient glow */
body::before{content:'';position:fixed;top:-20%;left:50%;transform:translateX(-50%);width:70%;height:55%;background:radial-gradient(ellipse,rgba(139,92,246,0.13) 0%,transparent 70%);pointer-events:none;animation:glow 0.8s ease forwards;opacity:0}
@keyframes glow{to{opacity:1}}

@keyframes up{from{opacity:0;transform:translateY(22px)}to{opacity:1;transform:translateY(0)}}
@keyframes fadeIn{from{opacity:0}to{opacity:1}}
@keyframes drawLine{from{transform:scaleX(0)}to{transform:scaleX(1)}}
@keyframes dotPop{0%{transform:scale(0);opacity:0}70%{transform:scale(1.3)}100%{transform:scale(1);opacity:1}}

.card{width:100%;max-width:500px;display:flex;flex-direction:column;position:relative;z-index:1}

.tag{font-size:11px;font-weight:700;letter-spacing:1.3px;text-transform:uppercase;color:#8b5cf6;opacity:0;animation:fadeIn 0.5s ease forwards 0.05s;margin-bottom:18px;display:flex;align-items:center;gap:7px}
.tag::before{content:'';width:5px;height:5px;border-radius:50%;background:#8b5cf6;display:inline-block;animation:dotPop 0.4s cubic-bezier(0.34,1.56,0.64,1) forwards 0.15s;opacity:0}

.title{font-size:clamp(26px,4.5vw,40px);font-weight:800;letter-spacing:-1.5px;line-height:1.1;background:linear-gradient(140deg,#ffffff 35%,rgba(196,181,253,0.92) 65%,rgba(139,92,246,0.9) 100%);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;opacity:0;animation:up 0.65s cubic-bezier(0.16,1,0.3,1) forwards 0.25s;margin-bottom:11px}

.oneliner{font-size:14px;line-height:1.65;color:rgba(240,240,245,0.55);font-weight:400;opacity:0;animation:up 0.5s cubic-bezier(0.16,1,0.3,1) forwards 0.65s;margin-bottom:26px}

.sep{height:1px;background:rgba(255,255,255,0.08);transform-origin:left;transform:scaleX(0);animation:drawLine 0.55s cubic-bezier(0.4,0,0.2,1) forwards 1.0s;margin-bottom:22px}

.section-label{font-size:10px;font-weight:700;letter-spacing:1.1px;text-transform:uppercase;color:rgba(240,240,245,0.28);opacity:0;animation:fadeIn 0.4s ease forwards 1.3s;margin-bottom:13px}

.feats{list-style:none;display:flex;flex-direction:column;gap:9px;margin-bottom:26px}
.feat{font-size:13.5px;color:rgba(240,240,245,0.72);display:flex;align-items:flex-start;gap:11px;opacity:0;animation:up 0.45s cubic-bezier(0.16,1,0.3,1) forwards;line-height:1.5}
.feat-dot{width:5px;height:5px;border-radius:50%;background:linear-gradient(135deg,#8b5cf6,#c4b5fd);flex-shrink:0;margin-top:6px}

.sep2{height:1px;background:rgba(255,255,255,0.08);transform-origin:left;transform:scaleX(0);animation:drawLine 0.4s ease forwards ${sep2Delay}s;margin-bottom:18px}

.for-label{font-size:10px;font-weight:700;letter-spacing:1.1px;text-transform:uppercase;color:rgba(240,240,245,0.28);opacity:0;animation:fadeIn 0.35s ease forwards ${forDelay}s;margin-bottom:6px}
.for-text{font-size:13px;color:rgba(240,240,245,0.58);opacity:0;animation:up 0.4s cubic-bezier(0.16,1,0.3,1) forwards ${for2Delay}s;line-height:1.55;margin-bottom:0}

.footer{font-size:11px;color:rgba(240,240,245,0.18);font-weight:400;opacity:0;animation:fadeIn 0.5s ease forwards ${footDelay}s;text-align:center;margin-top:28px;letter-spacing:0.1px}
.footer-accent{color:rgba(139,92,246,0.5)}
</style>
</head>
<body>
<div class="card">
  <div class="tag">Concept</div>
  <h1 class="title">${this._esc(r.title)}</h1>
  <p class="oneliner">${this._esc(r.one_liner)}</p>
  <div class="sep"></div>
  <div class="section-label">Key Features</div>
  <ul class="feats">
    ${feats.map((f, i) => {
      const d = (1.5 + i * 0.18).toFixed(2);
      return `<li class="feat" style="animation-delay:${d}s"><span class="feat-dot"></span>${this._esc(f)}</li>`;
    }).join('')}
  </ul>
  <div class="sep2"></div>
  <div class="for-label">Built for</div>
  <p class="for-text">${this._esc(r.target_user)}</p>
  <p class="footer">Made with <span class="footer-accent">Streamline by Stel</span></p>
</div>
</body>
</html>`;
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
