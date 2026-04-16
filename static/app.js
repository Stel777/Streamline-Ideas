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
    successMsg: '',

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
        this._showSuccess();
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
        this._showSuccess();
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
      this._protoCardHtml = this._buildConceptCard(this.result, html);
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

    _buildConceptCard(r, protoHtml = '') {
      const feats = (r.key_features || []).slice(0, 5);
      const nf = feats.length;
      const featStart  = 1.25;
      const featStep   = 0.16;
      const sep2Delay  = (featStart + nf * featStep + 0.12).toFixed(2);
      const forDelay   = (featStart + nf * featStep + 0.28).toFixed(2);
      const for2Delay  = (featStart + nf * featStep + 0.42).toFixed(2);
      const footDelay  = (featStart + nf * featStep + 0.72).toFixed(2);
      const protoJson  = JSON.stringify(protoHtml || '');

      return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&display=swap" rel="stylesheet">
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
html,body{height:100%;overflow:hidden;background:#080810;color:#f0f0f5;font-family:'Inter',-apple-system,BlinkMacSystemFont,sans-serif;-webkit-font-smoothing:antialiased}
body{display:flex;align-items:center;justify-content:center;padding:24px 20px;position:relative}
body::before{content:'';position:fixed;top:-30%;left:50%;transform:translateX(-50%);width:80%;height:60%;background:radial-gradient(ellipse,rgba(139,92,246,0.11) 0%,transparent 70%);pointer-events:none;animation:glow 1s ease forwards;opacity:0}
@keyframes glow{to{opacity:1}}
@keyframes up{from{opacity:0;transform:translateY(20px)}to{opacity:1;transform:translateY(0)}}
@keyframes fadeIn{from{opacity:0}to{opacity:1}}
@keyframes drawLine{from{transform:scaleX(0)}to{transform:scaleX(1)}}
@keyframes slideLeft{from{opacity:0;transform:translateX(-16px)}to{opacity:1;transform:translateX(0)}}
@keyframes dotPop{0%{transform:scale(0);opacity:0}70%{transform:scale(1.3)}100%{transform:scale(1);opacity:1}}
@keyframes spin{to{transform:rotate(360deg)}}

.wrap{width:100%;max-width:620px;display:flex;flex-direction:column;gap:18px;position:relative;z-index:1}
.tag{font-size:11px;font-weight:700;letter-spacing:1.3px;text-transform:uppercase;color:#8b5cf6;opacity:0;animation:fadeIn 0.5s ease forwards 0.05s;display:flex;align-items:center;gap:7px}
.tag::before{content:'';width:5px;height:5px;border-radius:50%;background:#8b5cf6;display:inline-block;animation:dotPop 0.4s cubic-bezier(0.34,1.56,0.64,1) forwards 0.12s;opacity:0}

.body{display:flex;gap:22px;align-items:flex-start}

/* Phone frame */
.phone-wrap{flex-shrink:0;opacity:0;animation:slideLeft 0.65s cubic-bezier(0.16,1,0.3,1) forwards 0.1s}
.phone-shell{width:148px;height:274px;border-radius:24px;overflow:hidden;background:#12121e;box-shadow:0 0 0 6px #151525,0 0 0 7px rgba(255,255,255,0.05),0 24px 56px rgba(0,0,0,0.7);position:relative}
.proto-mini{position:absolute;top:0;left:0;width:390px;height:726px;border:none;transform:scale(0.379);transform-origin:top left;pointer-events:none}
.phone-loader{position:absolute;inset:0;background:#12121e;display:flex;align-items:center;justify-content:center;transition:opacity 0.35s ease}
.phone-loader svg{animation:spin 1.2s linear infinite;opacity:0.3}

/* Text column */
.text{flex:1;min-width:0;display:flex;flex-direction:column}
.title{font-size:clamp(18px,3vw,26px);font-weight:800;letter-spacing:-0.8px;line-height:1.1;background:linear-gradient(140deg,#ffffff 35%,rgba(196,181,253,0.92) 65%,rgba(139,92,246,0.9) 100%);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;opacity:0;animation:up 0.6s cubic-bezier(0.16,1,0.3,1) forwards 0.2s;margin-bottom:7px}
.oneliner{font-size:12.5px;line-height:1.6;color:rgba(240,240,245,0.5);font-weight:400;opacity:0;animation:up 0.5s ease forwards 0.52s;margin-bottom:16px}
.sep{height:1px;background:rgba(255,255,255,0.08);transform-origin:left;transform:scaleX(0);animation:drawLine 0.5s ease forwards 0.88s;margin-bottom:14px}
.slabel{font-size:9.5px;font-weight:700;letter-spacing:1.1px;text-transform:uppercase;color:rgba(240,240,245,0.27);opacity:0;animation:fadeIn 0.4s ease forwards 1.1s;margin-bottom:10px}
.feats{list-style:none;display:flex;flex-direction:column;gap:8px;margin-bottom:16px}
.feat{font-size:12px;color:rgba(240,240,245,0.7);display:flex;align-items:flex-start;gap:8px;opacity:0;animation:up 0.4s cubic-bezier(0.16,1,0.3,1) forwards;line-height:1.45}
.fdot{width:4px;height:4px;border-radius:50%;background:linear-gradient(135deg,#8b5cf6,#c4b5fd);flex-shrink:0;margin-top:5px}
.sep2{height:1px;background:rgba(255,255,255,0.08);transform-origin:left;transform:scaleX(0);animation:drawLine 0.4s ease forwards ${sep2Delay}s;margin-bottom:12px}
.flabel{font-size:9.5px;font-weight:700;letter-spacing:1.1px;text-transform:uppercase;color:rgba(240,240,245,0.27);opacity:0;animation:fadeIn 0.35s ease forwards ${forDelay}s;margin-bottom:4px}
.ftext{font-size:12px;color:rgba(240,240,245,0.52);opacity:0;animation:up 0.4s ease forwards ${for2Delay}s;line-height:1.5}

.footer{font-size:10.5px;color:rgba(240,240,245,0.15);text-align:center;opacity:0;animation:fadeIn 0.5s ease forwards ${footDelay}s;letter-spacing:0.1px}
.fa{color:rgba(139,92,246,0.4)}
</style>
</head>
<body>
<div class="wrap">
  <div class="tag">Concept</div>
  <div class="body">
    <div class="phone-wrap">
      <div class="phone-shell">
        <div class="phone-loader" id="ploader">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#8b5cf6" stroke-width="2"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/></svg>
        </div>
        <iframe id="mini-proto" class="proto-mini" sandbox="allow-scripts allow-same-origin"></iframe>
      </div>
    </div>
    <div class="text">
      <h1 class="title">${this._esc(r.title)}</h1>
      <p class="oneliner">${this._esc(r.one_liner)}</p>
      <div class="sep"></div>
      <div class="slabel">Key Features</div>
      <ul class="feats">
        ${feats.map((f, i) => {
          const d = (featStart + i * featStep).toFixed(2);
          return `<li class="feat" style="animation-delay:${d}s"><span class="fdot"></span>${this._esc(f)}</li>`;
        }).join('')}
      </ul>
      <div class="sep2"></div>
      <div class="flabel">Built for</div>
      <p class="ftext">${this._esc(r.target_user)}</p>
    </div>
  </div>
  <p class="footer">Made with <span class="fa">Streamline by Stel</span></p>
</div>
<script>
const ph = ${protoJson};
const frame = document.getElementById('mini-proto');
const loader = document.getElementById('ploader');
if (ph && frame) {
  frame.addEventListener('load', () => {
    if (loader) { loader.style.opacity = '0'; setTimeout(() => loader.style.display = 'none', 350); }
  });
  frame.srcdoc = ph;
} else if (loader) {
  loader.style.display = 'none';
}
</script>
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

    exportPitch() {
      this._download(this._buildPitchDeck(this.result), `${this._slug()}-pitch.html`, 'text/html');
    },

    _buildPitchDeck(r) {
      const feats = (r.key_features || []).slice(0, 6);
      const today = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long' });
      const featCards = feats.map(f => `<div class="fc"><div class="fc-dot"></div><p>${this._esc(f)}</p></div>`).join('');
      return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${this._esc(r.title)} — Concept Pitch</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&display=swap" rel="stylesheet">
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
html{scroll-behavior:smooth}
body{background:#080810;color:#f0f0f5;font-family:'Inter',-apple-system,sans-serif;-webkit-font-smoothing:antialiased;overflow-x:hidden}
section{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:80px 48px;position:relative}
.inner{max-width:760px;width:100%}
/* Reveal animation */
.reveal{opacity:0;transform:translateY(28px);transition:opacity 0.7s ease,transform 0.7s cubic-bezier(0.16,1,0.3,1)}
.reveal.visible{opacity:1;transform:none}
/* Cover */
.cover{background:radial-gradient(ellipse at 50% -20%,rgba(139,92,246,0.18) 0%,transparent 65%),#080810}
.cover-badge{font-size:11px;font-weight:700;letter-spacing:1.4px;text-transform:uppercase;color:#8b5cf6;margin-bottom:28px;display:flex;align-items:center;gap:8px}
.cover-badge::before{content:'✦'}
.cover-title{font-size:clamp(48px,8vw,88px);font-weight:800;letter-spacing:-3px;line-height:1;background:linear-gradient(140deg,#ffffff 30%,rgba(196,181,253,0.9) 60%,rgba(139,92,246,0.85) 100%);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;margin-bottom:24px}
.cover-tagline{font-size:clamp(16px,2.5vw,22px);color:rgba(240,240,245,0.55);font-weight:300;line-height:1.5;max-width:560px;margin-bottom:48px}
.cover-meta{font-size:12px;color:rgba(240,240,245,0.25);letter-spacing:0.2px}
/* Section shared */
.section-label{font-size:11px;font-weight:700;letter-spacing:1.3px;text-transform:uppercase;color:#8b5cf6;margin-bottom:20px;opacity:0.8}
.section-num{font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:rgba(240,240,245,0.2);margin-bottom:10px}
.section-title{font-size:clamp(28px,4.5vw,48px);font-weight:800;letter-spacing:-1.5px;line-height:1.1;margin-bottom:24px;background:linear-gradient(135deg,#fff,rgba(196,181,253,0.8));-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text}
.section-body{font-size:18px;color:rgba(240,240,245,0.58);line-height:1.75;font-weight:300;max-width:600px}
/* Dividers */
section:not(.cover)::before{content:'';position:absolute;top:0;left:48px;right:48px;height:1px;background:rgba(255,255,255,0.06)}
/* Features grid */
.feat-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:14px;margin-top:32px}
.fc{background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);border-radius:14px;padding:20px;display:flex;gap:14px;align-items:flex-start}
.fc-dot{width:6px;height:6px;border-radius:50%;background:#8b5cf6;flex-shrink:0;margin-top:6px}
.fc p{font-size:14px;color:rgba(240,240,245,0.72);line-height:1.5}
/* Audience */
.audience-card{background:rgba(139,92,246,0.07);border:1px solid rgba(139,92,246,0.2);border-radius:20px;padding:32px 36px;margin-top:28px;font-size:18px;color:rgba(240,240,245,0.75);line-height:1.7;font-weight:300;font-style:italic}
/* CTA */
.cta-section{background:radial-gradient(ellipse at 50% 120%,rgba(139,92,246,0.16) 0%,transparent 65%),#080810;text-align:center}
.cta-title{font-size:clamp(36px,6vw,64px);font-weight:800;letter-spacing:-2px;line-height:1.05;margin-bottom:20px;background:linear-gradient(140deg,#ffffff 40%,rgba(196,181,253,0.85));-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text}
.cta-sub{font-size:16px;color:rgba(240,240,245,0.45);margin-bottom:44px;font-weight:300}
.cta-btn{display:inline-flex;align-items:center;gap:10px;background:#7c3aed;color:#fff;padding:16px 40px;border-radius:50px;font-size:15px;font-weight:600;text-decoration:none;letter-spacing:-0.2px;transition:all 0.18s ease}
.cta-btn:hover{background:#6d28d9;transform:scale(0.98)}
.watermark{margin-top:64px;font-size:12px;color:rgba(240,240,245,0.18);display:flex;align-items:center;justify-content:center;gap:6px}
.watermark-dot{color:#8b5cf6;opacity:0.5}
/* Scrollbar */
::-webkit-scrollbar{width:4px}::-webkit-scrollbar-track{background:transparent}::-webkit-scrollbar-thumb{background:rgba(139,92,246,0.3);border-radius:99px}
@media(max-width:600px){section{padding:60px 24px}section:not(.cover)::before{left:24px;right:24px}.cover-title{letter-spacing:-2px}}
@media print{.reveal{opacity:1;transform:none}section{min-height:unset;page-break-after:always}}
</style>
</head>
<body>
<section class="cover">
  <div class="inner">
    <div class="cover-badge">Concept Brief</div>
    <h1 class="cover-title">${this._esc(r.title)}</h1>
    <p class="cover-tagline">${this._esc(r.one_liner)}</p>
    <div class="cover-meta">${today} &nbsp;·&nbsp; Made with Streamline by Stel</div>
  </div>
</section>
<section>
  <div class="inner reveal">
    <div class="section-num">01</div>
    <div class="section-label">The Problem</div>
    <h2 class="section-title">What's broken today</h2>
    <p class="section-body">${this._esc(r.problem)}</p>
  </div>
</section>
<section>
  <div class="inner reveal">
    <div class="section-num">02</div>
    <div class="section-label">The Solution</div>
    <h2 class="section-title">${this._esc(r.title)} changes that</h2>
    <p class="section-body">${this._esc(r.solution)}</p>
  </div>
</section>
<section>
  <div class="inner reveal">
    <div class="section-num">03</div>
    <div class="section-label">Key Features</div>
    <h2 class="section-title">Built to deliver</h2>
    <div class="feat-grid">${featCards}</div>
  </div>
</section>
<section>
  <div class="inner reveal">
    <div class="section-num">04</div>
    <div class="section-label">Audience</div>
    <h2 class="section-title">Who this is for</h2>
    <div class="audience-card">"${this._esc(r.target_user)}"</div>
  </div>
</section>
<section class="cta-section">
  <div class="inner reveal">
    <h2 class="cta-title">Ready to build it?</h2>
    <p class="cta-sub">This concept was generated with Streamline by Stel.</p>
    <a href="https://claude.ai/claude-code" class="cta-btn" target="_blank">
      Build with Claude Code
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
    </a>
    <div class="watermark"><span class="watermark-dot">✦</span> Streamline by Stel</div>
  </div>
</section>
<script>
const obs = new IntersectionObserver(entries => {
  entries.forEach(e => { if (e.isIntersecting) e.target.classList.add('visible'); });
}, { threshold: 0.12 });
document.querySelectorAll('.reveal').forEach(el => obs.observe(el));
</script>
</body>
</html>`;
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

    _showSuccess() {
      this.successMsg = 'Your idea, realized.';
      setTimeout(() => this.successMsg = '', 3000);
    },
  };
}
