// Inline grain texture so we don't need a network round-trip for it.
const GRAIN_SVG = `data:image/svg+xml;utf8,${encodeURIComponent(
  `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 200 200'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2' stitchTiles='stitch'/><feColorMatrix values='0 0 0 0 0.94  0 0 0 0 0.91  0 0 0 0 0.83  0 0 0 0.04 0'/></filter><rect width='100%' height='100%' filter='url(%23n)'/></svg>`,
)}`

const css = `
  @import url('https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght,SOFT,WONK@9..144,300..900,0..100,0..1&family=Geist:wght@300..700&family=JetBrains+Mono:wght@400;500;700&display=swap');

  :root {
    --bg:        #0c0a14;
    --bg-glow:   #1a1224;
    --paper:     #161422;
    --paper-2:   #1d1a2b;
    --paper-3:   #221e34;
    --border:    #2a233a;
    --border-soft: #221c30;
    --ink:       #f0e8d4;
    --ink-dim:   #948a76;
    --ink-faint: #5e5566;
    --accent:    #f5a623;
    --accent-2:  #ff7d4a;
    --accent-soft: rgba(245, 166, 35, 0.12);
    --accent-glow: rgba(245, 166, 35, 0.22);

    --font-display: "Fraunces", "Cormorant Garamond", Georgia, serif;
    --font-body:    "Geist", "Söhne", -apple-system, BlinkMacSystemFont, sans-serif;
    --font-mono:    "JetBrains Mono", ui-monospace, "SF Mono", monospace;

    --radius:    14px;
    --radius-sm: 10px;
    --radius-lg: 18px;

    --max-w:     760px;
    --gutter:    1.5rem;
  }

  *, *::before, *::after { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; height: 100%; }

  body {
    background:
      radial-gradient(ellipse 60% 55% at 50% -10%, var(--bg-glow) 0%, transparent 60%),
      radial-gradient(ellipse 90% 50% at 50% 110%, rgba(245, 166, 35, 0.04) 0%, transparent 65%),
      var(--bg);
    color: var(--ink);
    font-family: var(--font-body);
    font-feature-settings: "ss01", "cv11";
    letter-spacing: -0.011em;
    line-height: 1.55;
    display: flex;
    flex-direction: column;
    min-height: 100%;
    position: relative;
  }
  body::before {
    content: "";
    position: fixed;
    inset: 0;
    pointer-events: none;
    background-image: url("${GRAIN_SVG}");
    opacity: 0.45;
    mix-blend-mode: overlay;
    z-index: 0;
    transition: opacity 0.25s ease;
  }
  body.streaming::before { opacity: 0.15; }

  @keyframes fade-up {
    from { opacity: 0; transform: translateY(8px); }
    to   { opacity: 1; transform: translateY(0); }
  }
  @keyframes fade-in {
    from { opacity: 0; }
    to   { opacity: 1; }
  }

  /* ──── conversation ──────────────────────────────────────────── */

  #ui-area {
    flex: 1;
    overflow-y: auto;
    padding: 3rem var(--gutter) 8rem;
    max-width: var(--max-w);
    margin: 0 auto;
    width: 100%;
    position: relative;
    z-index: 1;
    scrollbar-width: thin;
    scrollbar-color: var(--border) transparent;
    scroll-padding-bottom: 8rem;
  }
  #ui-area::-webkit-scrollbar { width: 6px; }
  #ui-area::-webkit-scrollbar-thumb { background: var(--border); border-radius: 3px; }

  .welcome {
    text-align: center;
    padding: 6rem 0 0;
    animation: fade-up 0.7s 0.1s ease-out backwards;
  }
  .welcome__mark {
    font-family: var(--font-mono);
    color: var(--accent);
    font-size: 0.7rem;
    letter-spacing: 0.4em;
    text-transform: uppercase;
    margin-bottom: 1.25rem;
    animation: fade-in 1s 0.25s ease-out backwards;
  }
  .welcome__title {
    font-family: var(--font-display);
    font-variation-settings: "opsz" 96, "SOFT" 30;
    font-weight: 320;
    font-size: clamp(2.5rem, 5vw, 3.75rem);
    letter-spacing: -0.022em;
    line-height: 1.05;
    margin: 0 0 1rem;
  }
  .welcome__title em {
    font-style: italic;
    font-variation-settings: "opsz" 96, "WONK" 1;
    color: var(--accent);
    font-weight: 360;
  }
  .welcome__sub {
    color: var(--ink-dim);
    font-size: 1rem;
    margin: 0;
    animation: fade-up 0.7s 0.35s ease-out backwards;
  }
  .welcome__hints {
    margin: 2.5rem auto 0;
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    justify-content: center;
    max-width: 460px;
    animation: fade-up 0.7s 0.5s ease-out backwards;
  }
  .welcome__hint {
    font-family: var(--font-mono);
    font-size: 0.78rem;
    color: var(--ink-dim);
    border: 1px solid var(--border);
    border-radius: 999px;
    padding: 0.4rem 0.9rem;
    cursor: pointer;
    background: transparent;
    transition: color 0.18s, border-color 0.18s, background 0.18s;
  }
  .welcome__hint:hover {
    color: var(--accent);
    border-color: var(--accent);
    background: var(--accent-soft);
  }

  /* turns: each is one prompt + one response */
  .turn {
    margin-bottom: 2.5rem;
    scroll-margin-top: 2rem;
  }
  .turn__user {
    display: flex;
    justify-content: flex-end;
    margin-bottom: 1.25rem;
  }
  .turn__user-bubble {
    max-width: min(80%, 520px);
    padding: 0.75rem 1.1rem;
    background: var(--paper-3);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    border-bottom-right-radius: 4px;
    font-size: 0.965rem;
    color: var(--ink);
    line-height: 1.5;
    white-space: pre-wrap;
    word-wrap: break-word;
    animation: fade-up 0.3s ease-out backwards;
  }
  .turn__assistant {
    /* assistant content (cards) lives here directly */
  }

  /* streaming affordance — a soft saffron bar at the top of the latest turn */
  .turn--streaming .turn__assistant {
    position: relative;
  }
  .turn--streaming .turn__assistant::before {
    content: "";
    position: absolute;
    inset: -0.25rem -0.5rem auto;
    height: 1px;
    background: linear-gradient(90deg, transparent, var(--accent), transparent);
    background-size: 50% 100%;
    background-repeat: no-repeat;
    animation: sweep 1.4s ease-in-out infinite;
    pointer-events: none;
    opacity: 0.7;
  }
  @keyframes sweep {
    0%   { background-position: -50% 0; }
    100% { background-position: 150% 0; }
  }

  /* post-stream gentle reveal */
  .turn--done > .turn__assistant > .recipe-card,
  .turn--done > .turn__assistant > .capture-card,
  .turn--done > .turn__assistant > .empty-state,
  .turn--done > .turn__assistant > .recipe-list {
    animation: fade-up 0.4s ease-out backwards;
  }

  /* step pills — surfaced while the agent is mid-tool-call */
  .turn__pills {
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem;
    margin-bottom: 1rem;
  }
  .turn__pills:empty { display: none; }
  .turn--done .turn__pills {
    opacity: 0.5;
    transform: scale(0.96);
    transition: opacity 0.5s ease 0.3s, transform 0.5s ease 0.3s;
  }
  .tool-pill {
    font-family: var(--font-mono);
    font-size: 0.7rem;
    color: var(--ink-dim);
    border: 1px solid var(--border);
    border-radius: 999px;
    padding: 0.25rem 0.7rem;
    background: var(--paper);
    letter-spacing: 0.02em;
    display: inline-flex;
    align-items: center;
    gap: 0.45rem;
    animation: fade-up 0.25s ease-out backwards;
  }
  .tool-pill::before {
    content: "";
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--ink-faint);
    transition: background 0.2s;
  }
  .tool-pill--running {
    color: var(--accent);
    border-color: var(--accent);
    background: var(--accent-soft);
  }
  .tool-pill--running::before {
    background: var(--accent);
    animation: pulse 0.9s ease-in-out infinite;
  }
  .tool-pill--ok { color: var(--ink-dim); }
  .tool-pill--ok::before { background: #6ec07f; }
  .tool-pill--err { color: #ff7d4a; border-color: #ff7d4a; }
  .tool-pill--err::before { background: #ff7d4a; }
  @keyframes pulse {
    0%, 100% { opacity: 1;   transform: scale(1); }
    50%      { opacity: 0.4; transform: scale(0.7); }
  }

  /* ──── base components rendered by the LLM ───────────────────── */

  .recipe-card,
  .capture-card {
    background: linear-gradient(180deg, var(--paper-2), var(--paper));
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 1.5rem 1.75rem;
    margin-bottom: 0.75rem;
    box-shadow:
      0 1px 0 rgba(255, 255, 255, 0.03) inset,
      0 18px 40px -22px rgba(0, 0, 0, 0.55);
  }
  .recipe-card:last-child,
  .capture-card:last-child { margin-bottom: 0; }

  .recipe-card__title,
  .capture-card__title {
    font-family: var(--font-display);
    font-variation-settings: "opsz" 36, "SOFT" 50;
    font-weight: 380;
    font-size: 1.6rem;
    letter-spacing: -0.022em;
    line-height: 1.1;
    margin: 0 0 0.25rem;
    color: var(--ink);
  }
  .recipe-card__meta {
    font-family: var(--font-mono);
    font-size: 0.72rem;
    color: var(--ink-dim);
    letter-spacing: 0.02em;
    margin-bottom: 1rem;
    text-transform: uppercase;
  }
  .recipe-card__section { margin-top: 1.5rem; }
  .recipe-card__section h3 {
    font-family: var(--font-mono);
    font-size: 0.66rem;
    text-transform: uppercase;
    letter-spacing: 0.2em;
    color: var(--accent);
    margin: 0 0 0.75rem;
    font-weight: 500;
  }
  .recipe-card__ingredients,
  .recipe-card__steps {
    padding-left: 1.25rem;
    margin: 0;
  }
  .recipe-card__ingredients li,
  .recipe-card__steps li {
    padding: 0.15rem 0;
    line-height: 1.55;
  }
  .recipe-card__ingredients li::marker { color: var(--ink-faint); }
  .recipe-card__steps li::marker {
    color: var(--accent);
    font-family: var(--font-mono);
    font-weight: 500;
  }

  .recipe-list { list-style: none; padding: 0; margin: 0; }
  .recipe-list-item {
    background: var(--paper);
    border: 1px solid var(--border);
    border-left: 3px solid var(--accent);
    border-radius: var(--radius-sm);
    padding: 0.875rem 1.125rem;
    margin-bottom: 0.5rem;
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    gap: 1rem;
    transition: border-color 0.18s, transform 0.18s;
  }
  .recipe-list-item:hover {
    border-color: var(--accent);
    transform: translateX(2px);
  }
  .recipe-list-item__title {
    font-family: var(--font-display);
    font-variation-settings: "opsz" 18, "SOFT" 40;
    font-weight: 420;
    font-size: 1.12rem;
    letter-spacing: -0.01em;
  }
  .recipe-list-item__meta {
    font-family: var(--font-mono);
    font-size: 0.7rem;
    color: var(--ink-dim);
    letter-spacing: 0.02em;
    white-space: nowrap;
    text-align: right;
  }

  .capture-card__body {
    white-space: pre-wrap;
    line-height: 1.65;
    font-size: 0.97rem;
  }

  .empty-state {
    text-align: center;
    padding: 2.5rem 1.5rem;
    color: var(--ink-dim);
    border: 1px dashed var(--border);
    border-radius: var(--radius);
    background: var(--paper);
  }
  .empty-state p {
    margin: 0;
    font-family: var(--font-display);
    font-style: italic;
    font-size: 1.05rem;
  }

  /* ──── composer ──────────────────────────────────────────────── */

  .composer {
    position: fixed;
    bottom: 0;
    left: 0;
    right: 0;
    padding: 1rem var(--gutter) 1.25rem;
    z-index: 10;
    background:
      linear-gradient(180deg, transparent 0, var(--bg) 35%);
    animation: fade-up 0.7s 0.2s ease-out backwards;
  }
  .composer__inner {
    max-width: var(--max-w);
    margin: 0 auto;
    width: 100%;
  }
  .composer__field {
    display: flex;
    align-items: flex-end;
    gap: 0.5rem;
    background: var(--paper);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 0.55rem 0.55rem 0.55rem 1rem;
    transition: border-color 0.2s, box-shadow 0.25s;
    box-shadow: 0 8px 28px -18px rgba(0, 0, 0, 0.5);
  }
  .composer__field:focus-within {
    border-color: var(--accent);
    box-shadow:
      0 0 0 3px var(--accent-soft),
      0 8px 28px -18px rgba(0, 0, 0, 0.5);
  }
  .composer__input {
    flex: 1;
    border: 0;
    outline: 0;
    background: transparent;
    color: var(--ink);
    font-family: var(--font-body);
    font-size: 1rem;
    letter-spacing: -0.005em;
    line-height: 1.45;
    resize: none;
    padding: 0.5rem 0;
    max-height: 200px;
    overflow-y: auto;
    scrollbar-width: thin;
  }
  .composer__input::placeholder { color: var(--ink-faint); }

  .composer__send {
    flex: 0 0 auto;
    width: 36px;
    height: 36px;
    border: 0;
    border-radius: 10px;
    background: var(--ink);
    color: var(--bg);
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    transition: background 0.18s, transform 0.06s, opacity 0.18s;
  }
  .composer__send:hover { background: var(--accent); }
  .composer__send:active { transform: scale(0.94); }
  .composer__send:disabled {
    background: var(--border);
    color: var(--ink-faint);
    cursor: not-allowed;
  }
  .composer__send svg { width: 16px; height: 16px; display: block; }
  .composer__send .icon-stop { display: none; }
  body.streaming .composer__send {
    background: var(--accent);
    color: var(--bg);
  }
  body.streaming .composer__send .icon-send { display: none; }
  body.streaming .composer__send .icon-stop { display: block; }

  .composer__hint {
    font-family: var(--font-mono);
    font-size: 0.68rem;
    color: var(--ink-faint);
    text-align: right;
    margin: 0.5rem 0.25rem 0 0;
    letter-spacing: 0.04em;
    user-select: none;
  }
`

const clientJs = `
  (function () {
    const ui = document.getElementById('ui-area');
    const form = document.getElementById('composer-form');
    const ta = document.getElementById('prompt-input');
    const sendBtn = document.getElementById('send-btn');

    let currentSource = null;

    function autoGrow() {
      ta.style.height = 'auto';
      ta.style.height = Math.min(ta.scrollHeight, 200) + 'px';
    }
    ta.addEventListener('input', autoGrow);

    ta.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        form.requestSubmit();
      }
    });

    function endStream() {
      if (currentSource) { currentSource.close(); currentSource = null; }
      document.body.classList.remove('streaming');
      ta.disabled = false;
      ta.focus();
    }

    sendBtn.addEventListener('click', function (e) {
      if (document.body.classList.contains('streaming')) {
        // streaming → button acts as stop
        e.preventDefault();
        const turn = ui.querySelector('.turn--streaming');
        if (turn) {
          turn.classList.remove('turn--streaming');
          turn.classList.add('turn--done');
        }
        endStream();
      }
    });

    function appendTurn(prompt) {
      const turn = document.createElement('section');
      turn.className = 'turn turn--streaming';

      const userRow = document.createElement('div');
      userRow.className = 'turn__user';
      const bubble = document.createElement('div');
      bubble.className = 'turn__user-bubble';
      bubble.textContent = prompt;
      userRow.appendChild(bubble);

      const pills = document.createElement('div');
      pills.className = 'turn__pills';

      const assistant = document.createElement('div');
      assistant.className = 'turn__assistant';

      turn.appendChild(userRow);
      turn.appendChild(pills);
      turn.appendChild(assistant);
      ui.appendChild(turn);
      return { turn, pills, assistant };
    }

    function send(prompt) {
      if (!prompt || currentSource) return;

      const welcome = ui.querySelector('.welcome');
      if (welcome) welcome.remove();

      const { turn, pills, assistant } = appendTurn(prompt);
      const pendingPills = [];
      document.body.classList.add('streaming');
      ta.disabled = true;
      ta.value = '';
      autoGrow();

      // scroll the new turn into view (smoothly).
      requestAnimationFrame(function () {
        turn.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });

      const url = '/ui/stream?prompt=' + encodeURIComponent(prompt);
      const es = new EventSource(url);
      currentSource = es;

      // LLM token chunks can split mid-tag. Buffer until '<' and '>'
      // counts balance before committing to innerHTML — otherwise the
      // browser paints partial markup (e.g. "<span") as text.
      // Also strip stray markdown fences the render LLM sometimes emits
      // despite the system prompt forbidding them.
      let buffer = '';
      let lastRendered = '';
      function cleanBuffer(s) {
        // Strip stray markdown fences the render LLM sometimes emits even
        // though the system prompt forbids them. Idempotent so repeated
        // calls during streaming converge as the closing fence arrives.
        return s
          .replace(/^\\s*\\\`\\\`\\\`(?:html)?\\s*\\n?/, '')
          .replace(/\\n?\\s*\\\`\\\`\\\`\\s*$/, '');
      }
      function tryCommit() {
        const cleaned = cleanBuffer(buffer);
        const opens = (cleaned.match(/</g) || []).length;
        const closes = (cleaned.match(/>/g) || []).length;
        if (opens !== closes) return;
        if (cleaned === lastRendered) return;
        lastRendered = cleaned;
        assistant.innerHTML = cleaned;
      }

      es.addEventListener('step', function (msg) {
        let payload;
        try { payload = JSON.parse(msg.data); } catch (_) { return; }
        if (payload.type === 'tool_call') {
          const pill = document.createElement('span');
          pill.className = 'tool-pill tool-pill--running';
          pill.textContent = payload.toolName;
          pills.appendChild(pill);
          pendingPills.push({ toolName: payload.toolName, el: pill });
        } else if (payload.type === 'tool_result') {
          const idx = pendingPills.findIndex(function (p) { return p.toolName === payload.toolName; });
          const entry = idx >= 0 ? pendingPills.splice(idx, 1)[0] : null;
          if (entry) {
            entry.el.classList.remove('tool-pill--running');
            entry.el.classList.add(payload.ok ? 'tool-pill--ok' : 'tool-pill--err');
          }
        }
      });
      es.addEventListener('ui', function (msg) {
        buffer += msg.data;
        tryCommit();
      });
      es.addEventListener('ui-done', function () {
        const finalBuffer = cleanBuffer(buffer);
        if (finalBuffer !== lastRendered) assistant.innerHTML = finalBuffer;
        turn.classList.remove('turn--streaming');
        turn.classList.add('turn--done');
        endStream();
      });
      es.addEventListener('ui-error', function (msg) {
        assistant.innerHTML = '<div class="empty-state"><p>' + msg.data + '</p></div>';
        turn.classList.remove('turn--streaming');
        turn.classList.add('turn--done');
        endStream();
      });
      es.onerror = function (err) {
        console.error('SSE error', err);
        if (!turn.classList.contains('turn--done')) {
          turn.classList.remove('turn--streaming');
          turn.classList.add('turn--done');
        }
        endStream();
      };
    }

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      if (document.body.classList.contains('streaming')) return;
      send(ta.value.trim());
    });

    document.addEventListener('click', function (e) {
      if (e.target && e.target.classList && e.target.classList.contains('welcome__hint')) {
        const text = e.target.textContent.trim();
        ta.value = text;
        autoGrow();
        send(text);
      }
    });

    window.addEventListener('beforeunload', endStream);
  })();
`

const sendIcon = `<svg class="icon-send" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 13.5V3"/><path d="M3.5 7.5L8 3l4.5 4.5"/></svg>`
const stopIcon = `<svg class="icon-stop" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><rect x="4" y="4" width="8" height="8" rx="1.5"/></svg>`

export const shell = (): string => `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>agent</title>
  <link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Ctext y='13' font-family='monospace' font-size='13' fill='%23f5a623'%3E%E2%8C%98%3C/text%3E%3C/svg%3E" />
  <style>${css}</style>
  <script src="https://unpkg.com/htmx.org@2.0.4" crossorigin="anonymous"></script>
</head>
<body>
  <main id="ui-area">
    <div class="welcome">
      <div class="welcome__mark">⌘ &nbsp;capture log</div>
      <h1 class="welcome__title">ask what you've <em>kept.</em></h1>
      <p class="welcome__sub">recipes, notes, anything you've captured.</p>
      <div class="welcome__hints">
        <button type="button" class="welcome__hint">show me my recipes</button>
        <button type="button" class="welcome__hint">what was the last thing I saved?</button>
        <button type="button" class="welcome__hint">show me the oat sticks recipe</button>
      </div>
    </div>
  </main>

  <div class="composer">
    <form class="composer__inner" id="composer-form" autocomplete="off">
      <div class="composer__field">
        <textarea
          id="prompt-input"
          class="composer__input"
          placeholder="ask anything about your captures…"
          rows="1"
          autofocus
        ></textarea>
        <button id="send-btn" class="composer__send" type="submit" aria-label="send">
          ${sendIcon}
          ${stopIcon}
        </button>
      </div>
      <p class="composer__hint">enter to send · shift + enter for newline</p>
    </form>
  </div>

  <script>${clientJs}</script>
</body>
</html>`
