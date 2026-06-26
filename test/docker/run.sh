#!/usr/bin/env bash
# In-container e2e for the installed `efferent` package. Hard checks fail the run
# (exit 1); keyed checks run only when /root/.efferent/auth.json is mounted.
set -uo pipefail

FAIL=0
PROMPT="reply with exactly the three words: hello from efferent"
hr() { printf '\n\033[1m=== %s ===\033[0m\n' "$1"; }
ok() { printf '  \033[32mok\033[0m   %s\n' "$1"; }
bad() { printf '  \033[31mFAIL\033[0m %s\n' "$1"; FAIL=1; }
soft() { printf '  \033[33mSOFT\033[0m %s\n' "$1"; }

hr "version + bins"
WANT_VERSION="${EXPECT_VERSION:-0.3.0}"
V=$(efferent --version 2>/dev/null | tr -d '[:space:]')
[ "$V" = "$WANT_VERSION" ] && ok "efferent --version = $V" || bad "version is '$V' (want $WANT_VERSION)"
command -v efferent >/dev/null && ok "efferent on PATH" || bad "efferent not on PATH"
command -v eff      >/dev/null && ok "eff on PATH"      || bad "eff not on PATH"
# The VS-Code-colliding `code` bin must be GONE.
if command -v code >/dev/null 2>&1; then bad "'code' bin present (should be removed)"; else ok "no 'code' bin (collision avoided)"; fi

hr "subcommands resolve (parse-only, no key)"
H=$(efferent --help 2>&1)
echo "$H" | grep -q "code"   && ok "help lists 'code'"   || bad "help missing 'code'"
echo "$H" | grep -q "attach" && ok "help lists 'attach'" || bad "help missing 'attach'"
echo "$H" | grep -q "daemon" && ok "help lists 'daemon'" || bad "help missing 'daemon'"
efferent code   --help >/dev/null 2>&1 && ok "'efferent code' resolves"   || bad "'efferent code' failed to parse"
efferent attach --help >/dev/null 2>&1 && ok "'efferent attach' resolves" || bad "'efferent attach' failed to parse"
DH=$(efferent daemon --help 2>&1)
for sub in start serve status stop; do
  echo "$DH" | grep -q "$sub" && ok "daemon '$sub' listed" || bad "daemon '$sub' missing"
done

hr "native renderer dependency resolved"
# @opentui/core + its platform-native subpackage (the dlopen'd Zig lib) must
# have installed under efferent's own node_modules — that's what the TUI needs.
NM="/usr/local/lib/node_modules/efferent/node_modules"
[ -d "$NM/@opentui/core" ] && ok "@opentui/core installed" || bad "@opentui/core missing"
SO=$(find "$NM"/@opentui/core-* -name 'libopentui.so' 2>/dev/null | head -1)
[ -n "$SO" ] && ok "native renderer present ($(basename "$(dirname "$SO")"))" || bad "libopentui.so (platform native lib) missing"
[ -d "$NM/web-tree-sitter" ] && ok "web-tree-sitter installed" || bad "web-tree-sitter missing"
[ -d "$NM/msgpackr-extract" ] && soft "msgpackr-extract present (expected absent — JS fallback)" || ok "msgpackr-extract absent (JS fallback, no baked path)"

HAS_KEY=0; [ -f /root/.efferent/auth.json ] && HAS_KEY=1

if [ "$HAS_KEY" -eq 0 ]; then
  hr "no-key graceful degradation"
  OUT=$(efferent --mode json "ping" 2>&1); RC=$?
  echo "$OUT" | grep -qi "no provider configured" && [ "$RC" -ne 0 ] \
    && ok "json mode exits $RC with the :login hint (no crash)" \
    || bad "expected non-zero exit + 'no provider configured' hint (rc=$RC)"
  echo
  echo "No auth.json mounted — skipped keyed turns. Re-run with:"
  echo "  docker run --rm -v \"\$HOME/.efferent/auth.json:/root/.efferent/auth.json:ro\" <image>"
  exit $FAIL
fi

hr "in-process keyed turn — a real tool-using session (write_file + Bash)"
rm -f /work/ip-proof.txt
OUT=$(efferent --cwd /work --allow-bash --mode json \
  "Create a file named ip-proof.txt containing exactly: efferent in-process ok. Then run 'cat ip-proof.txt'." 2>/tmp/ip.err); RC=$?
echo "$OUT" | grep -oE '"toolName":"[^"]+"' | sort -u | tr '\n' ' '; echo
# The proof is the side effect: the agent actually wrote the file.
if [ "$RC" -eq 0 ] && grep -q "efferent in-process ok" /work/ip-proof.txt 2>/dev/null; then
  ok "agent used tools and created /work/ip-proof.txt ($(cat /work/ip-proof.txt))"
else
  bad "in-process tool session failed (rc=$RC, file=$(cat /work/ip-proof.txt 2>/dev/null || echo missing))"; tail -3 /tmp/ip.err
fi

hr "split-daemon keyed turn (efferent daemon start + HTTP API)"
efferent daemon start --cwd /work --allow-bash >/tmp/daemon.log 2>&1 &
DPID=$!
PORT=""
for i in $(seq 1 30); do
  ST=$(efferent daemon status --cwd /work 2>/dev/null || true)
  if echo "$ST" | grep -q healthy; then
    PORT=$(echo "$ST" | grep -oE "127\.0\.0\.1:[0-9]+" | head -1 | cut -d: -f2)
    break
  fi
  sleep 1
done
if [ -n "$PORT" ]; then
  ok "daemon healthy on 127.0.0.1:$PORT"
  curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null 2>&1 && ok "GET /health 200" || bad "/health unreachable"
  # Spawn an agent session with a real task — a tool-using turn through the
  # daemon process; the proof is the file it writes into /work.
  rm -f /work/daemon-proof.txt
  SID=$(curl -fsS -X POST "http://127.0.0.1:$PORT/sessions" \
        -H 'content-type: application/json' \
        -d '{"folder":"/work","task":"Create a file named daemon-proof.txt containing exactly: efferent daemon ok"}' 2>/dev/null \
        | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{const v=JSON.parse(d);process.stdout.write(typeof v==="string"?v:(v.id??v.sessionId??""))}catch{process.stdout.write("")}})')
  if [ -n "$SID" ]; then
    ok "spawned daemon session $SID"
    DONE=0
    for i in $(seq 1 60); do
      STATE=$(curl -fsS "http://127.0.0.1:$PORT/sessions/$SID/state" 2>/dev/null || true)
      BUSY=$(echo "$STATE" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{const s=JSON.parse(d);process.stdout.write(String(s.busy))}catch{process.stdout.write("?")}})')
      if [ "$BUSY" = "false" ]; then DONE=1; break; fi
      sleep 2
    done
    if [ "$DONE" -eq 1 ] && grep -q "efferent daemon ok" /work/daemon-proof.txt 2>/dev/null; then
      ok "daemon turn used tools and wrote /work/daemon-proof.txt"
    elif [ "$DONE" -eq 1 ]; then
      soft "daemon turn settled but file not found (model may have answered differently); daemon lifecycle still verified"
    else
      soft "daemon turn did not settle within timeout; daemon lifecycle still verified"
    fi
  else
    soft "could not parse a session id from POST /sessions; daemon lifecycle still verified"
  fi
  efferent daemon stop --cwd /work >/dev/null 2>&1 && ok "daemon stop requested" || soft "daemon stop returned non-zero"
else
  bad "daemon did not become healthy within timeout — log:"; tail -5 /tmp/daemon.log
fi
kill "$DPID" >/dev/null 2>&1 || true

hr "result"
[ "$FAIL" -eq 0 ] && echo "ALL HARD CHECKS PASSED" || echo "SOME HARD CHECKS FAILED"
exit $FAIL
