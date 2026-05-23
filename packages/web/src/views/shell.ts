// Inline grain texture so we don't need a network round-trip for it.
const GRAIN_SVG = `data:image/svg+xml;utf8,${encodeURIComponent(
  `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 200 200'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2' stitchTiles='stitch'/><feColorMatrix values='0 0 0 0 0.94  0 0 0 0 0.91  0 0 0 0 0.83  0 0 0 0.045 0'/></filter><rect width='100%' height='100%' filter='url(%23n)'/></svg>`,
)}`

const css = `
  @import url('https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght,SOFT,WONK@9..144,300..900,0..100,0..1&family=Geist:wght@300..700&family=JetBrains+Mono:wght@400;500;700&display=swap');

  :root {
    --bg:        #0c0a14;
    --bg-glow:   #1a1224;
    --paper:     #161422;
    --paper-2:   #1d1a2b;
    --border:    #2a233a;
    --ink:       #f0e8d4;
    --ink-dim:   #948a76;
    --ink-faint: #5e5566;
    --accent:    #f5a623;     /* saffron */
    --accent-2:  #ff7d4a;     /* terracotta */
    --accent-soft: rgba(245, 166, 35, 0.12);

    --font-display: "Fraunces", "Cormorant Garamond", Georgia, serif;
    --font-body:    "Geist", "Söhne", -apple-system, BlinkMacSystemFont, sans-serif;
    --font-mono:    "JetBrains Mono", ui-monospace, "SF Mono", monospace;

    --radius: 14px;
  }

  *, *::before, *::after { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; height: 100%; }

  body {
    background:
      radial-gradient(ellipse 60% 55% at 50% -10%, var(--bg-glow) 0%, transparent 60%),
      radial-gradient(ellipse 90% 50% at 50% 110%, rgba(245, 166, 35, 0.045) 0%, transparent 65%),
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
    /* film-grain overlay */
    content: "";
    position: fixed;
    inset: 0;
    pointer-events: none;
    background-image: url("${GRAIN_SVG}");
    opacity: 0.5;
    mix-blend-mode: overlay;
    z-index: 0;
  }

  /* one well-orchestrated page load — staggered fade-up */
  @keyframes fade-up {
    from { opacity: 0; transform: translateY(10px); filter: blur(4px); }
    to   { opacity: 1; transform: translateY(0);    filter: blur(0); }
  }
  @keyframes fade-in {
    from { opacity: 0; }
    to   { opacity: 1; }
  }
  @keyframes pulse-glow {
    0%, 100% { box-shadow: 0 0 0 0 rgba(245, 166, 35, 0.0); }
    50%      { box-shadow: 0 0 0 6px rgba(245, 166, 35, 0.18); }
  }
  @keyframes cursor-blink {
    0%, 49% { opacity: 1; }
    50%, 100% { opacity: 0; }
  }

  #ui-area {
    flex: 1;
    overflow-y: auto;
    padding: 4rem 1.5rem 2rem;
    max-width: 760px;
    margin: 0 auto;
    width: 100%;
    position: relative;
    z-index: 1;
    scrollbar-width: thin;
    scrollbar-color: var(--border) transparent;
  }

  /* welcome */
  .welcome {
    text-align: center;
    padding: 5rem 0 0;
    animation: fade-up 0.9s 0.1s ease-out backwards;
  }
  .welcome__mark {
    font-family: var(--font-mono);
    color: var(--accent);
    font-size: 0.75rem;
    letter-spacing: 0.4em;
    text-transform: uppercase;
    margin-bottom: 1.25rem;
    animation: fade-in 1.4s 0.3s ease-out backwards;
  }
  .welcome__title {
    font-family: var(--font-display);
    font-variation-settings: "opsz" 96, "SOFT" 30;
    font-weight: 320;
    font-size: clamp(2.5rem, 5vw, 3.75rem);
    letter-spacing: -0.022em;
    line-height: 1.05;
    margin: 0 0 1rem;
    color: var(--ink);
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
    animation: fade-up 0.9s 0.45s ease-out backwards;
  }
  .welcome__hints {
    margin: 2.5rem auto 0;
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    justify-content: center;
    max-width: 420px;
    animation: fade-up 0.9s 0.6s ease-out backwards;
  }
  .welcome__hint {
    font-family: var(--font-mono);
    font-size: 0.78rem;
    color: var(--ink-dim);
    border: 1px solid var(--border);
    border-radius: 999px;
    padding: 0.375rem 0.75rem;
    cursor: pointer;
    background: transparent;
    transition: color 0.18s, border-color 0.18s, background 0.18s;
  }
  .welcome__hint:hover {
    color: var(--accent);
    border-color: var(--accent);
    background: var(--accent-soft);
  }

  /* chat strip */
  .chat-strip {
    display: flex;
    gap: 0.5rem;
    padding: 1rem 1.5rem 1.5rem;
    max-width: 760px;
    margin: 0 auto;
    width: 100%;
    position: sticky;
    bottom: 0;
    z-index: 2;
    animation: fade-up 0.9s 0.3s ease-out backwards;
    background:
      linear-gradient(180deg, transparent 0, var(--bg) 30%);
  }
  .chat-strip__field {
    flex: 1;
    display: flex;
    align-items: center;
    gap: 0.625rem;
    background: var(--paper);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 0 1rem;
    transition: border-color 0.2s, box-shadow 0.25s;
  }
  .chat-strip__field:focus-within {
    border-color: var(--accent);
    box-shadow: 0 0 0 4px var(--accent-soft);
  }
  .chat-strip__prompt-mark {
    color: var(--accent);
    font-family: var(--font-mono);
    font-size: 0.875rem;
    user-select: none;
  }
  .chat-strip input[type="text"] {
    flex: 1;
    padding: 0.95rem 0;
    background: transparent;
    border: 0;
    outline: none;
    color: var(--ink);
    font-family: var(--font-body);
    font-size: 1rem;
    letter-spacing: -0.005em;
  }
  .chat-strip input::placeholder { color: var(--ink-faint); }
  .chat-strip button {
    padding: 0 1.25rem;
    height: 3rem;
    background: var(--ink);
    color: var(--bg);
    border: 0;
    border-radius: var(--radius);
    font-family: var(--font-body);
    font-weight: 600;
    font-size: 0.95rem;
    cursor: pointer;
    transition: background 0.18s, transform 0.06s;
    letter-spacing: -0.01em;
  }
  .chat-strip button:hover { background: var(--accent); }
  .chat-strip button:active { transform: translateY(1px); }
  .chat-strip button:disabled { background: var(--border); color: var(--ink-faint); cursor: not-allowed; }

  body.streaming .chat-strip__field {
    animation: pulse-glow 1.6s ease-in-out infinite;
    border-color: var(--accent);
  }

  /* chat turns — each prompt + rendered response is a stacked turn */
  .turn {
    padding: 2rem 0;
    border-top: 1px dashed var(--border);
  }
  .turn:first-child { border-top: 0; padding-top: 0.5rem; }
  .turn__prompt {
    font-family: var(--font-mono);
    font-size: 0.82rem;
    color: var(--ink-dim);
    margin: 0 0 1.25rem;
    letter-spacing: 0.005em;
    display: flex;
    gap: 0.5rem;
    align-items: baseline;
  }
  .turn__prompt::before {
    content: "›";
    color: var(--accent);
    font-weight: 500;
  }
  .turn__response { display: contents; }
  .turn--streaming .turn__prompt { color: var(--accent); }

  /* During streaming, no per-element animations — they'd replay on every
     chunk re-render and cause flashing. The streaming itself is the motion. */
  /* After streaming, a single soft fade-in once. */
  .turn--done > .turn__response > .recipe-card,
  .turn--done > .turn__response > .capture-card,
  .turn--done > .turn__response > .empty-state,
  .turn--done > .turn__response > .recipe-list {
    animation: fade-up 0.45s ease-out backwards;
  }
  .turn--done > .turn__response > .recipe-list .recipe-list-item {
    animation: fade-up 0.4s ease-out backwards;
  }
  .turn--done > .turn__response > .recipe-list .recipe-list-item:nth-child(1) { animation-delay: 0.02s; }
  .turn--done > .turn__response > .recipe-list .recipe-list-item:nth-child(2) { animation-delay: 0.1s; }
  .turn--done > .turn__response > .recipe-list .recipe-list-item:nth-child(3) { animation-delay: 0.18s; }
  .turn--done > .turn__response > .recipe-list .recipe-list-item:nth-child(4) { animation-delay: 0.26s; }
  .turn--done > .turn__response > .recipe-list .recipe-list-item:nth-child(n+5) { animation-delay: 0.34s; }

  /* gentle in-stream affordance: a thin saffron sweep along the top of #ui-area
     while content is being generated */
  body.streaming #ui-area::before {
    content: "";
    position: sticky;
    top: 0;
    display: block;
    height: 2px;
    margin: 0 -1.5rem 1rem;
    background: linear-gradient(90deg, transparent, var(--accent), transparent);
    background-size: 50% 100%;
    background-repeat: no-repeat;
    animation: sweep 1.4s ease-in-out infinite;
    pointer-events: none;
  }
  @keyframes sweep {
    0%   { background-position: -50% 0; }
    100% { background-position: 150% 0; }
  }

  .recipe-card,
  .capture-card {
    background:
      linear-gradient(180deg, var(--paper-2), var(--paper));
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 1.5rem 1.75rem;
    margin-bottom: 1rem;
    box-shadow:
      0 1px 0 rgba(255, 255, 255, 0.03) inset,
      0 18px 40px -20px rgba(0, 0, 0, 0.6);
  }
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
    font-size: 0.75rem;
    color: var(--ink-dim);
    letter-spacing: 0.02em;
    margin-bottom: 1rem;
  }
  .recipe-card__section { margin-top: 1.5rem; }
  .recipe-card__section h3 {
    font-family: var(--font-mono);
    font-size: 0.68rem;
    text-transform: uppercase;
    letter-spacing: 0.18em;
    color: var(--accent);
    margin: 0 0 0.75rem;
    font-weight: 500;
  }
  .recipe-card__ingredients,
  .recipe-card__steps {
    padding-left: 1.25rem;
    margin: 0;
    color: var(--ink);
  }
  .recipe-card__ingredients li,
  .recipe-card__steps li {
    padding: 0.125rem 0;
    line-height: 1.55;
  }
  .recipe-card__ingredients li::marker {
    color: var(--ink-faint);
  }
  .recipe-card__steps li::marker {
    color: var(--accent);
    font-family: var(--font-mono);
    font-weight: 500;
  }

  .recipe-list {
    list-style: none;
    padding: 0;
    margin: 0;
  }
  .recipe-list-item {
    background: var(--paper);
    border: 1px solid var(--border);
    border-left: 3px solid var(--accent);
    border-radius: 10px;
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
    font-size: 1.15rem;
    letter-spacing: -0.01em;
    color: var(--ink);
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
    color: var(--ink);
    font-size: 0.97rem;
  }

  .empty-state {
    text-align: center;
    padding: 3rem 1.5rem;
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

  /* scrollbars */
  #ui-area::-webkit-scrollbar { width: 6px; }
  #ui-area::-webkit-scrollbar-thumb { background: var(--border); border-radius: 3px; }
`

const clientJs = `
  (function () {
    const form = document.getElementById('chat-form');
    const ui = document.getElementById('ui-area');
    const input = document.getElementById('prompt-input');
    const button = form.querySelector('button[type="submit"]');
    let currentSource = null;

    function endStream() {
      if (currentSource) { currentSource.close(); currentSource = null; }
      document.body.classList.remove('streaming');
      button.disabled = false;
      input.disabled = false;
    }

    function send(prompt) {
      if (!prompt || currentSource) return;

      // Remove the welcome state on first send.
      const welcome = ui.querySelector('.welcome');
      if (welcome) welcome.remove();

      // Create a new turn (prompt echo + empty response container).
      const turn = document.createElement('section');
      turn.className = 'turn turn--streaming';
      const promptEl = document.createElement('div');
      promptEl.className = 'turn__prompt';
      promptEl.textContent = prompt;
      const responseEl = document.createElement('div');
      responseEl.className = 'turn__response';
      turn.appendChild(promptEl);
      turn.appendChild(responseEl);
      ui.appendChild(turn);

      document.body.classList.add('streaming');
      button.disabled = true;
      input.disabled = true;
      turn.scrollIntoView({ behavior: 'smooth', block: 'start' });

      const url = '/ui/stream?prompt=' + encodeURIComponent(prompt);
      const es = new EventSource(url);
      currentSource = es;

      // LLM tokens can split mid-tag. Two protections:
      //  1. Re-render the current turn's response innerHTML on every chunk.
      //  2. Only commit when '<' and '>' counts balance — otherwise we'd
      //     paint partial markup like '<span' which the browser turns into
      //     literal text and looks like flashing garbage.
      let buffer = '';
      let lastRendered = '';
      function tryCommit() {
        const opens = (buffer.match(/</g) || []).length;
        const closes = (buffer.match(/>/g) || []).length;
        if (opens !== closes) return;
        if (buffer === lastRendered) return;
        lastRendered = buffer;
        responseEl.innerHTML = buffer;
      }
      es.addEventListener('ui', function (msg) {
        buffer += msg.data;
        tryCommit();
      });
      es.addEventListener('ui-done', function () {
        if (buffer !== lastRendered) {
          responseEl.innerHTML = buffer;
        }
        endStream();
        turn.classList.remove('turn--streaming');
        turn.classList.add('turn--done');
        input.value = '';
        input.focus();
        turn.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
      es.addEventListener('ui-error', function (msg) {
        responseEl.innerHTML = '<div class="empty-state"><p>' + msg.data + '</p></div>';
        endStream();
        turn.classList.remove('turn--streaming');
        turn.classList.add('turn--done');
      });
      es.onerror = function (err) {
        console.error('SSE error', err);
        endStream();
      };
    }

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      send(input.value.trim());
    });

    document.addEventListener('click', function (e) {
      if (e.target && e.target.classList && e.target.classList.contains('welcome__hint')) {
        const text = e.target.textContent.trim();
        input.value = text;
        send(text);
      }
    });

    window.addEventListener('beforeunload', endStream);
  })();
`

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
  <form id="chat-form" class="chat-strip" autocomplete="off">
    <div class="chat-strip__field">
      <span class="chat-strip__prompt-mark">›</span>
      <input
        id="prompt-input"
        name="prompt"
        type="text"
        placeholder="what do you want to see?"
        autocomplete="off"
        autofocus
      />
    </div>
    <button type="submit">send</button>
  </form>
  <script>${clientJs}</script>
</body>
</html>`
