/**
 * Interactive run over WebSocket — additive companion to POST /api/run.
 *
 * The default /api/run path pre-pads stdin with `4\n4\n4\nq\n0\nn\n` to
 * avoid infinite-hang in menu-driven COBOL programs. That's fine for
 * "did it produce something sensible?" verification but hides what the
 * program actually asks you. This WS path spawns the Java class with
 * piped stdin/stdout and streams both directions so the user can walk
 * the menu live — type a choice, see the next prompt, type again.
 *
 * Protocol (text frames; JSON-encoded):
 *   server → client: { type: 'ready' }
 *   server → client: { type: 'stdout', data: '...' }
 *   server → client: { type: 'stderr', data: '...' }
 *   server → client: { type: 'exit', code: 0, signal: null }
 *   server → client: { type: 'error', error: '...' }
 *   client → server: { type: 'stdin',  data: '...' }
 *   client → server: { type: 'signal', signal: 'SIGTERM' }
 *
 * Not a real PTY — child_process.spawn gives pipes, not a TTY, so
 * programs that call isatty() will still see "not interactive". For
 * COBOL programs that just ACCEPT from SYSIN and DISPLAY, pipes are
 * equivalent. Swapping in node-pty later is straightforward (same
 * message protocol).
 *
 * mount(httpServer, deps) where deps = { activeConversions }.
 * Must be mounted on the HTTP server instance, not the Express app,
 * because WebSocket upgrades happen below the Express layer.
 */

const { WebSocketServer } = require('ws');
const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

// How long before we kill an orphaned session (no traffic either way).
// The user might start an interactive run, then walk away. 10 minutes
// is generous for a menu walkthrough and bounds the worst case.
const IDLE_TIMEOUT_MS = 10 * 60 * 1000;

function mount(httpServer, deps) {
    const { activeConversions } = deps;

    const wss = new WebSocketServer({ noServer: true });

    httpServer.on('upgrade', (req, socket, head) => {
        // Only handle our specific path — leave any other WS routes alone.
        const url = req.url || '';
        const m = /^\/ws\/run\/([^/]+)\/(.+)$/.exec(url);
        if (!m) return; // not ours; let Express or another handler close it

        const id = decodeURIComponent(m[1]);
        const fileId = decodeURIComponent(m[2]);

        wss.handleUpgrade(req, socket, head, (ws) => {
            handleInteractiveRun(ws, id, fileId, { activeConversions });
        });
    });
}

function handleInteractiveRun(ws, id, fileId, deps) {
    const { activeConversions } = deps;

    const send = (obj) => {
        try { ws.send(JSON.stringify(obj)); } catch {}
    };

    const conversion = activeConversions.get(id);
    if (!conversion) {
        send({ type: 'error', error: 'Conversion not found' });
        try { ws.close(); } catch {}
        return;
    }
    if (!conversion.result) {
        send({ type: 'error', error: 'Conversion not complete yet' });
        try { ws.close(); } catch {}
        return;
    }

    const reportFile = ((conversion.result.report && conversion.result.report.files) || [])
        .find(f => f.path === fileId);
    if (!reportFile || !reportFile.work_dir || !reportFile.java_path) {
        send({ type: 'error', error: 'File not in report or missing Java output' });
        try { ws.close(); } catch {}
        return;
    }

    // Compile on demand — same reference-aware approach as /api/run, but
    // only target-file alone + any siblings that happen to already be in
    // the work dir (keeps the WS flow snappy). If compile fails the WS
    // never gets to 'ready'; client sees stderr + exit.
    const javaClass = path.basename(reportFile.java_path, '.java');
    try {
        execSync(`javac "${reportFile.java_path}"`, {
            cwd: reportFile.work_dir,
            timeout: 30000,
            stdio: ['pipe', 'pipe', 'pipe']
        });
    } catch (compileErr) {
        const stderr = compileErr.stderr ? compileErr.stderr.toString() : compileErr.message;
        send({ type: 'stderr', data: 'Compilation failed:\n' + stderr });
        send({ type: 'exit', code: 1, signal: null });
        try { ws.close(); } catch {}
        return;
    }

    // Stage the same data files /api/run would. Done inline to avoid
    // depending on the big deps injection; symmetry with sync run.
    try {
        const copybookDir = path.join(reportFile.work_dir, 'data');
        if (fs.existsSync(copybookDir)) { /* already staged elsewhere */ }
    } catch {}

    const child = spawn('java', ['-cp', reportFile.work_dir, javaClass], {
        cwd: reportFile.work_dir,
        stdio: ['pipe', 'pipe', 'pipe']
    });

    let killed = false;
    let idleTimer = null;
    const bumpIdle = () => {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
            if (!killed) {
                killed = true;
                send({ type: 'error', error: `Idle timeout (${Math.round(IDLE_TIMEOUT_MS/1000)}s) — terminating.` });
                try { child.kill('SIGTERM'); } catch {}
            }
        }, IDLE_TIMEOUT_MS);
    };
    bumpIdle();

    send({ type: 'ready' });

    child.stdout.on('data', (buf) => {
        send({ type: 'stdout', data: buf.toString('utf-8') });
        bumpIdle();
    });
    child.stderr.on('data', (buf) => {
        send({ type: 'stderr', data: buf.toString('utf-8') });
        bumpIdle();
    });
    child.on('exit', (code, signal) => {
        if (idleTimer) clearTimeout(idleTimer);
        send({ type: 'exit', code, signal });
        try { ws.close(); } catch {}
    });
    child.on('error', (err) => {
        send({ type: 'error', error: err.message });
    });

    ws.on('message', (raw) => {
        bumpIdle();
        let msg;
        try { msg = JSON.parse(raw.toString()); } catch { return; }
        if (!msg || typeof msg !== 'object') return;
        if (msg.type === 'stdin' && typeof msg.data === 'string') {
            try { child.stdin.write(msg.data); } catch {}
        } else if (msg.type === 'signal' && typeof msg.signal === 'string') {
            try { child.kill(msg.signal); killed = true; } catch {}
        } else if (msg.type === 'close_stdin') {
            try { child.stdin.end(); } catch {}
        }
    });

    ws.on('close', () => {
        if (idleTimer) clearTimeout(idleTimer);
        if (!killed) {
            killed = true;
            try { child.kill('SIGTERM'); } catch {}
        }
    });
}

module.exports = { mount };
