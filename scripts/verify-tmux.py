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
    (workspace / 'calculation.ts').write_text('export const answer = 1\n')
    (workspace / '.gitignore').write_text('.efferent/\nreplacement-model.ts\n')
    subprocess.run(['git', 'init', '-q', str(workspace)], check=True, capture_output=True)
    subprocess.run(['git', '-C', str(workspace), 'add', 'README.md', 'calculation.ts', '.gitignore', 'efferent.config.json'], check=True, capture_output=True)

    def tmux(*args, **kwargs):
        result = subprocess.run(['tmux', '-S', socket, *args], capture_output=True, **kwargs)
        if result.returncode:
            raise RuntimeError(f'tmux {args[0]}: {result.stderr.decode().strip()}')
        return result.stdout
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
    def loop_options():
        overrides = json.loads((workspace / '.efferent/overrides.json').read_text())
        return next(plugin for plugin in overrides['plugins'] if plugin['id'] == 'loop')['options']

    try:
        tmux('new-session', '-d', '-s', 'cli', '-x', '110', '-y', '32', '-c', str(root), shlex.join(['bun', 'run', 'efferent', '--cwd', temporary]))
        wait_for('Welcome to Efferent · setup')
        capture('onboarding')
        keys('Enter')
        wait_for('Connect a provider')
        paste('vercel')
        wait_for('Vercel AI Gateway')
        capture('vercel-provider-picker')
        keys('Enter')
        wait_for('Connect vercel')
        keys('Enter')
        wait_for('API key · vercel')
        paste('fixture-gateway-not-saved')
        frame = wait_for('•' * len('fixture-gateway-not-saved'))
        assert 'fixture-gateway-not-saved' not in frame, frame
        capture('vercel-masked-key')
        keys('Escape')
        command('/login')
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

        # Natural greetings stay ordinary composer text and need no tool calls.
        tmux('resize-window', '-t', 'cli', '-x', '80', '-y', '24')
        command('/new')
        wait_for('What are we working on?')
        keys('h', 'e', 'l', 'l', 'o', 'Enter')
        frame = wait_for('Hi! What would you like to work on?')
        wait_for('Ready')
        assert frame.count('Hi! What would you like to work on?') == 1, frame
        assert 'read_file' not in frame and 'Editor preparing' not in frame, frame
        with sqlite3.connect(workspace / '.efferent/runtime/sessions.db') as database:
            records = list(database.execute('select kind, data from session_log_events order by rowid'))
        last_start = max(index for index, (kind, _) in enumerate(records) if kind == 'turn.started')
        assert not any(kind in ('tool.started', 'memory.tool-result') for kind, _ in records[last_start:]), records[last_start:]
        capture('hello-80x24')
        paste('hello draft')
        keys('Escape')
        wait_for('NORMAL')
        keys('0', 'l', 'x')
        wait_for('hllo draft')
        keys('i', 'e')
        wait_for('hello draft')
        assert 'NORMAL' not in pane(), pane()
        keys('C-u')
        tmux('resize-window', '-t', 'cli', '-x', '110', '-y', '32')

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
        assert 'draft while streaming' in pane(), 'Escape discarded the idle draft'
        keys('C-u')
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

        # A real filesystem failure repairs in the same run, with one row per call.
        tmux('resize-window', '-t', 'cli', '-x', '80', '-y', '24')
        command('/new')
        wait_for('What are we working on?')
        command('Read the missing file, recover by reading README.md, and report the result')
        frame = wait_for('Recovered by reading README.md successfully.')
        wait_for('Ready')
        assert frame.count('Recovered by reading README.md successfully.') == 1, frame
        assert frame.count('read_file') == 2, frame
        assert '__smith_missing_fixture__.md · failed' in frame, frame
        assert 'read_file · README.md' in frame and 'File not found' in frame, frame
        assert 'ENOENT' not in frame and 'Arguments' not in frame and '"message"' not in frame, frame
        capture('failure-recovery-80x24')
        paste('keep hello draft')
        keys('C-o')
        wait_for('tmux workspace marker')
        keys('j')
        frame = wait_for('ENOENT')
        assert 'Arguments' in frame and 'Result' in frame and '__smith_missing_fixture__.md' in frame, frame
        capture('failed-read-inspector-80x24')
        keys('l')
        wait_for('h/Enter back')
        keys('j', 'k', 'h')
        wait_for('j/k ↑↓ select')
        keys('k')
        wait_for('tmux workspace marker')
        keys('/', 'r', 'e', 'a', 'd', '_', 'f', 'i', 'l', 'e')
        wait_for('Filter: read_file')
        keys('C-j')
        wait_for('ENOENT')
        keys('C-k')
        wait_for('tmux workspace marker')
        assert 'Filter: read_file' in pane(), pane()
        keys('C-g', 'l')
        wait_for('h/Enter back')
        keys('h', 'h')
        wait_for('keep hello draft')
        keys('C-u')

        command('/context')
        wait_for('Context')
        capture('context-80x24')
        keys('j', 'k', 'l', 'h', 'h')
        wait_for('Recovered by reading README.md successfully.')
        command('/tasks')
        wait_for('No matching activity')
        capture('empty-tasks-80x24')
        keys('h')
        command('/search no-such-transcript-marker')
        frame = wait_for('No matching transcript')
        assert 'What are we working on?' not in frame, frame
        capture('search-empty-80x24')
        command('/search')
        wait_for('Recovered by reading README.md successfully.')
        paste('session menu draft')
        keys('C-p')
        paste('sessions')
        keys('l')
        # Filtering mode treats l as text; Ctrl+G deliberately returns to browse.
        wait_for('No matching actions')
        keys('BSpace', 'C-g', 'l')
        wait_for('Sessions')
        keys('j', 'k', 'h')
        wait_for('session menu draft')
        keys('C-u')
        dark_frame = tmux('capture-pane', '-p', '-e', '-t', 'cli')
        command('/theme')
        wait_for('Appearance')
        keys('j', 'l')
        wait_for('Recovered by reading README.md successfully.')
        assert tmux('capture-pane', '-p', '-e', '-t', 'cli') != dark_frame, 'Appearance did not change'
        capture('light-theme-80x24')
        command('/theme dark')
        command('/plan')
        wait_for('Saved.')
        assert loop_options()['readOnly'] is True, loop_options()
        assert ' · plan' in pane().splitlines()[0], pane()
        command('/code')
        wait_for('Saved.')
        assert loop_options()['readOnly'] is False, loop_options()
        assert ' · code' in pane().splitlines()[0], pane()
        command('/spec')
        wait_for('Use /spec followed by the idea to refine.')
        tmux('resize-window', '-t', 'cli', '-x', '110', '-y', '32')

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
        keys('Escape')

        # Exercise the coding controls at the 80x24 acceptance size.
        tmux('resize-window', '-t', 'cli', '-x', '80', '-y', '24')
        command('/models')
        wait_for('Model roles')
        keys('Enter')
        wait_for('Choose controller model')
        paste('fixture:model-4')
        keys('Enter')
        wait_for('Saved.')
        assert loop_options()['driverModel'] == 'fixture:model-4', loop_options()
        command('/models')
        wait_for('Model roles')
        keys('Down', 'Enter')
        wait_for('Choose editor model')
        paste('fixture:model-6')
        keys('Enter')
        wait_for('Saved.')
        assert loop_options()['editorModel'] == 'fixture:model-6', loop_options()
        command('/models')
        frame = wait_for('Model roles')
        assert 'fixture:model-4' in frame and 'fixture:model-6' in frame, frame
        capture('model-roles-80x24')
        keys('Escape')

        # Replacing the models adapter must retain the controller override.
        command('/plugins')
        wait_for('Plugins ·')
        keys('Down', 'Down', 'Enter')
        wait_for('models · configuration')
        keys('Down', 'Enter')
        wait_for('Replace models')
        paste('Use another')
        keys('Enter')
        wait_for('Replace models · package or path')
        paste('./replacement-model.ts')
        keys('C-s')
        frame = wait_for('Saved.')
        assert 'fixture:model-4' in frame.splitlines()[0], frame

        command('/models')
        wait_for('Model roles')
        keys('Down', 'Enter')
        frame = wait_for('Choose editor model')
        assert 'Selected' in next(line for line in frame.splitlines() if 'fixture:model-6' in line), frame
        assert 'Selected' not in next(line for line in frame.splitlines() if 'fixture:model-4' in line), frame
        paste('configured default')
        keys('Enter')
        wait_for('Saved.')
        assert loop_options()['editorModel'] == '', loop_options()
        command('/models')
        frame = wait_for('Model roles')
        assert 'fixture:model-4' in next(line for line in frame.splitlines() if 'Editor' in line), frame
        capture('default-editor-80x24')
        keys('Enter')
        wait_for('Choose controller model')
        paste('configured default')
        keys('Enter')
        wait_for('Saved.')
        assert loop_options()['driverModel'] == '', loop_options()

        command('/mods')
        wait_for('Effect modules')
        keys('Enter')
        frame = wait_for('● foundations')
        assert loop_options()['modules'] == ['foundations'], loop_options()
        assert 'Enabled' in frame, frame
        capture('effect-modules-80x24')
        keys('Enter')
        wait_for('○ foundations')
        assert loop_options()['modules'] == [], loop_options()
        keys('Escape')

        command('verify-check')
        wait_for('verify')
        wait_for('Ready')
        command('/checks')
        frame = wait_for('tmux-check-ok')
        assert 'Checks' in frame and 'Exit 0 · passed' in frame, frame
        keys('Enter')
        frame = wait_for('tmux-check-ok')
        assert 'Exit 0' in frame and '"stdout"' not in frame, frame
        keys('PageDown', 'PageUp')
        capture('checks-80x24')
        keys('Escape')

        (workspace / 'README.md').write_text('tmux workspace marker\n' + ''.join(f'review line {number:02d}\n' for number in range(35)))
        (workspace / 'calculation.ts').write_text('export const answer = 42\n')
        subprocess.run(['git', '-C', str(workspace), 'add', 'calculation.ts'], check=True, capture_output=True)
        (workspace / 'calculation.ts').write_text('export const answer = 42\nexport const checked = true\n')
        command('/changes')
        frame = wait_for('Workspace changes')
        assert 'calculation.ts' in frame and 'README.md' in frame, frame
        keys('Down', 'Down')
        frame = wait_for('+export const answer = 42')
        assert 'Staged · Working tree' in frame, frame
        keys('Enter', 'PageDown')
        wait_for('+export const checked = true')
        keys('PageUp', 'Enter')
        keys('Up')
        keys('Enter', 'PageDown')
        frame = wait_for('review line 00')
        assert 'README.md' in frame, frame
        keys('PageDown')
        wait_for('review line 10')
        keys('PageUp', 'PageUp')
        wait_for('Staged changes')
        capture('changes-80x24')
        keys('Enter')
        paste('calculation')
        frame = wait_for('Filter: calculation')
        assert '+export const answer = 42' in frame and 'README.md' not in frame, frame
        keys('Escape')
        tmux('resize-window', '-t', 'cli', '-x', '110', '-y', '32')
        command('hold')
        wait_for('Waiting for cancellation')
        command('/models')
        wait_for('Model roles · next turn', timeout=2)
        keys('Enter')
        wait_for('Choose controller model · next turn', timeout=2)
        paste('fixture:model-4')
        keys('Enter')
        wait_for('Saved.', timeout=2)
        assert loop_options()['driverModel'] == 'fixture:model-4', loop_options()
        command('/models')
        frame = wait_for('Model roles · next turn', timeout=2)
        assert 'fixture:model-4' in next(line for line in frame.splitlines() if 'Editor' in line), frame
        capture('roles-during-active-turn')
        keys('Enter')
        wait_for('Choose controller model · next turn', timeout=2)
        paste('configured default')
        keys('Enter')
        wait_for('Saved.', timeout=2)
        assert loop_options()['driverModel'] == '', loop_options()
        command('/mods')
        wait_for('Effect modules', timeout=2)
        keys('Enter')
        wait_for('● foundations', timeout=2)
        assert loop_options()['modules'] == ['foundations'], loop_options()
        keys('Enter')
        wait_for('○ foundations', timeout=2)
        assert loop_options()['modules'] == [], loop_options()
        keys('Escape')
        wait_for('Waiting for cancellation')
        command('/setup')
        wait_for('Welcome to Efferent · setup', timeout=2)
        keys('Escape')
        wait_for('Waiting for cancellation')
        keys('C-p')
        wait_for('Commands')
        keys('Escape')
        wait_for('Waiting for cancellation')
        keys('/')
        wait_for('Commands ·')
        keys('Escape')
        wait_for('Waiting for cancellation')
        keys('C-u')
        command('hello')
        wait_for('hello')
        assert 'Cancelled' not in pane(), pane()
        keys('Escape')
        wait_for('Cancelled')
        capture('cancelled')
        command('/continue')
        frame = wait_for('Hi! What would you like to work on?')
        wait_for('Ready')
        assert frame.count('Hi! What would you like to work on?') == 1, frame
        capture('continued-queued-greeting')
        database = sqlite3.connect(workspace / '.efferent/runtime/sessions.db')
        events = [json.loads(row[0])['event'] for row in database.execute("select data from session_log_events where kind = 'harness.event' order by rowid")]
        assert sum(e['name']=='run.cancelled' for e in events) == 1
        assert not any(e['name']=='run.failed' for e in events)
        assert any(e['name']=='input.queued' and e['data']['text']=='multiline\nmessage' for e in events)
        assert any(e['name']=='input.queued' and e['data']['text']=='hello' for e in events)
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
        command('/quit')
        print('Actual CLI in tmux with scripted provider: onboarding, Vercel Gateway provider selection/masked-key cancellation, login navigation, slash filtering/completion, natural greeting without tools, real missing-file recovery, vim composer/inspectors/filter modes, draft preservation, context/tasks/sessions/search/theme, plan/code/spec validation, narrow menus, 50 stable streaming deltas, plugin editing/replacement/invalid rollback, replacement query, tools, model roles/defaults/selected markers, override after replacement, responsive controls during active work, module toggles, check and staged/working change keyboard inspectors at 80x24, cancellation and queued continuation, startup prompt, Ctrl+C and /quit passed')
    except Exception:
        result = subprocess.run(['tmux', '-S', socket, 'capture-pane', '-p', '-t', 'cli'], capture_output=True)
        frame = result.stdout.decode() if result.returncode == 0 else result.stderr.decode()
        (artifacts / 'failure.txt').write_text(frame)
        print(frame)
        raise
    finally:
        subprocess.run(['tmux', '-S', socket, 'kill-server'], capture_output=True)
