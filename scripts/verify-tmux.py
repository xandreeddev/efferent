"""Exercise the actual CLI in tmux. Uses a deterministic model; never needs credentials."""
import json, pathlib, shlex, shutil, sqlite3, subprocess, tempfile, time

root = pathlib.Path(__file__).resolve().parent.parent
if not shutil.which("tmux"):
    raise SystemExit("tmux is required: install it, then rerun this check")
artifacts = root / '.artifacts' / 'tmux'
artifacts.mkdir(parents=True, exist_ok=True)

with tempfile.TemporaryDirectory(prefix='efferent-tmux-') as temporary:
    workspace = pathlib.Path(temporary)
    socket = str(workspace / 'tmux.sock')
    (workspace / 'README.md').write_text('tmux workspace marker\n')
    fixture = str(root / 'packages/plugin-models/fixtures/tmux-model.ts')
    replacement = workspace / 'replacement-model.ts'
    replacement.write_text(f'import model from {json.dumps(fixture)}; export default {{ ...model, defaults: {{ model: "fixture:replacement" }} }}\n')
    (workspace / 'efferent.config.json').write_text(json.dumps({'version': 1, 'plugins': [{'id': 'models', 'use': fixture}]}))

    def tmux(*args, **kwargs):
        return subprocess.run(['tmux', '-S', socket, *args], check=True, capture_output=True, **kwargs).stdout
    def pane():
        return tmux('capture-pane', '-p', '-t', 'cli').decode()
    def wait_for(needle, timeout=15):
        deadline = time.monotonic() + timeout
        previous = ''
        while time.monotonic() < deadline:
            frame = pane()
            assert 'TMUX_LOG_MUST_NOT_REACH_SCREEN' not in frame, frame
            if needle in frame and frame == previous:
                return frame
            previous = frame
            time.sleep(.05)
        raise AssertionError(f'Missing {needle!r}:\n{pane()}')
    def keys(*args):
        tmux('send-keys', '-t', 'cli', *args)
        time.sleep(.1)
    def paste(text):
        tmux('load-buffer', '-b', 'input', '-', input=text.encode())
        tmux('paste-buffer', '-p', '-b', 'input', '-t', 'cli')
        time.sleep(.1)
    def command(text):
        paste(text)
        keys('Enter')
    def capture(name):
        (artifacts / f'{name}.txt').write_text(pane())

    try:
        tmux('new-session', '-d', '-s', 'cli', '-x', '110', '-y', '32', '-c', str(root), shlex.join(['bun', 'run', 'efferent', '--cwd', temporary]))
        wait_for('Welcome to Efferent · setup')
        capture('onboarding')
        keys('Enter')
        wait_for('Connect a provider')
        keys('Enter')
        wait_for('Subscription login')
        capture('onboarding-login-methods')
        keys('Escape')
        wait_for('What are we working on?')
        keys('/')
        wait_for('Commands ·')
        keys('s', 'e', 't')
        wait_for('/setup')
        assert '/sessions' not in pane(), pane()
        keys('Enter')
        wait_for('Welcome to Efferent · setup')
        keys('Escape')
        wait_for('What are we working on?')
        command('multiline\nmessage')
        wait_for('Choose a model')
        assert 'multiline' in pane(), 'Setup discarded the unsent prompt'
        tmux('resize-window', '-t', 'cli', '-x', '60', '-y', '20')
        keys('-N', '20', 'Down')
        frame = wait_for('model-20')
        lines = frame.splitlines()
        assert next(i for i,l in enumerate(lines) if 'model-20' in l) < next(i for i,l in enumerate(lines) if '└' in l), frame
        capture('small-model-picker')
        keys('Enter')
        wait_for('Saved.')
        tmux('resize-window', '-t', 'cli', '-x', '110', '-y', '32')
        keys('Enter')
        wait_for('tmux answer received')
        capture('streamed-response')

        keys('/')
        wait_for('Commands ·')
        capture('slash-commands')
        keys('m', 'o')
        wait_for('/model')
        assert '/plugins' not in pane(), pane()
        keys('Tab')
        paste('fixture:model-3')
        keys('Enter')
        wait_for('Saved.')

        command('/new')
        wait_for('What are we working on?')
        command('stream-check')
        wait_for('Stable streaming prefix')
        frames = []
        deadline = time.monotonic() + 12
        while time.monotonic() < deadline:
            frame = pane()
            frames.append(frame)
            if len(frames) == 10:
                paste('draft while streaming')
            assert 'Stable streaming prefix' in frame, frame
            assert 'TMUX_LOG_MUST_NOT_REACH_SCREEN' not in frame, frame
            if 'Streaming complete' in frame and 'Ready' in frame:
                break
            time.sleep(.015)
        else:
            raise AssertionError('Stream did not complete')
        assert len(frames) > 40, len(frames)
        assert 'draft while streaming' in pane(), pane()
        keys('Escape')
        # Every word already visible must remain visible in subsequent frames.
        import re
        seen = set()
        for frame in frames:
            words = set(re.findall(r'word\d+(?=\s)', frame))
            assert seen <= words, f'Streamed text disappeared: {seen - words}\n{frame}'
            seen |= words
        assert len(seen) == 50, len(seen)
        (artifacts / 'streaming-frames.json').write_text(json.dumps(frames))
        capture('incremental-markdown')

        command('/plugins')
        wait_for('Plugins ·')
        keys('Down', 'Down', 'Enter')
        wait_for('models · configuration')
        keys('Enter')
        wait_for('models.model')
        keys('C-a')
        paste('fixture:model-2')
        keys('C-s')
        wait_for('Saved.')
        overrides = json.loads((workspace / '.efferent/overrides.json').read_text())
        assert next(p for p in overrides['plugins'] if p['id']=='models')['options']['model'] == 'fixture:model-2'

        command('/plugins')
        wait_for('Plugins ·')
        keys('Down', 'Down', 'Enter')
        wait_for('models · configuration')
        keys('Down', 'Enter')
        wait_for('Replace models')
        keys('Down', 'Enter')
        wait_for('Replace models · package or path')
        paste('./missing-plugin.ts')
        keys('C-s')
        wait_for('Cannot load installed plugin')
        assert next(p for p in json.loads((workspace / '.efferent/overrides.json').read_text())['plugins'] if p['id']=='models')['use'] == fixture
        keys('C-a')
        paste('./replacement-model.ts')
        keys('C-s')
        wait_for('Saved.')
        overrides = json.loads((workspace / '.efferent/overrides.json').read_text())
        replaced = next(p for p in overrides['plugins'] if p['id']=='models')
        assert replaced['use'] == './replacement-model.ts', replaced
        assert 'options' not in replaced, replaced
        command('verify replacement')
        wait_for('replacement model answered')
        capture('plugin-replacement')

        command('tool-check')
        wait_for('read_file · README.md')
        time.sleep(.5)
        keys('C-o')
        wait_for('tmux workspace marker')
        capture('expanded-tool')
        command('hold')
        wait_for('Waiting for cancellation')
        keys('C-p')
        wait_for('Commands')
        keys('Escape')
        wait_for('Waiting for cancellation')
        keys('/')
        wait_for('Commands ·')
        keys('Escape')
        wait_for('Waiting for cancellation')
        assert 'Cancelled' not in pane(), pane()
        keys('Escape')
        wait_for('Cancelled')
        capture('cancelled')
        database = sqlite3.connect(workspace / '.efferent/runtime/sessions.db')
        events = [json.loads(row[0]) for row in database.execute('select body from harness_events order by rowid')]
        assert sum(e['name']=='run.cancelled' for e in events) == 1
        assert not any(e['name']=='run.failed' for e in events)
        assert any(e['name']=='input.queued' and e['data']['text']=='multiline\nmessage' for e in events)
        database.close()
        keys('C-c', 'C-c')
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            if subprocess.run(['tmux', '-S', socket, 'has-session', '-t', 'cli'], capture_output=True).returncode:
                break
            time.sleep(.1)
        else:
            raise AssertionError('CLI did not exit after Ctrl+C twice')
        tmux('new-session', '-d', '-s', 'cli', '-x', '110', '-y', '32', '-c', str(root), shlex.join(['bun', 'run', 'efferent', '--cwd', temporary, 'hold startup prompt']))
        wait_for('Waiting for cancellation')
        keys('Escape')
        wait_for('Cancelled')
        capture('startup-prompt')
        keys('C-c', 'C-c')
        print('Actual CLI in tmux: onboarding, login navigation, live slash filtering/completion, draft preservation, narrow menus, 50 streaming deltas sampled without missing text, plugin editing/replacement/invalid rollback, replacement query, tools, cancellation, startup prompt, and exit passed')
    except Exception:
        frame = pane()
        (artifacts / 'failure.txt').write_text(frame)
        print(frame)
        raise
    finally:
        subprocess.run(['tmux', '-S', socket, 'kill-server'], capture_output=True)
