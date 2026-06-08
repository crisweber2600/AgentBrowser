import http from 'node:http';
import { mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WorkflowStore } from './workflow-store.js';

class HttpError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.name = 'HttpError';
    this.statusCode = statusCode;
  }
}

function json(res, statusCode, payload) {
  res.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload, null, 2));
}

function html(res, statusCode, body) {
  res.writeHead(statusCode, { 'content-type': 'text/html; charset=utf-8' });
  res.end(body);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'Request body must be valid JSON');
  }
}

function assertObject(value, fieldName) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new HttpError(400, `${fieldName} must be an object`);
  }
}

function assertNonEmptyString(value, fieldName) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new HttpError(400, `${fieldName} must be a non-empty string`);
  }
}

function validateSteps(steps) {
  if (!Array.isArray(steps) || steps.length === 0) {
    throw new HttpError(400, 'steps must be a non-empty array');
  }
  for (const [index, step] of steps.entries()) {
    assertObject(step, `steps[${index}]`);
    assertNonEmptyString(step.action, `steps[${index}].action`);
    assertNonEmptyString(step.target, `steps[${index}].target`);
    assertNonEmptyString(step.expectedOutput, `steps[${index}].expectedOutput`);
  }
}

function validateCapturePayload(payload) {
  assertObject(payload, 'capture payload');
  assertNonEmptyString(payload.title, 'title');
  assertNonEmptyString(payload.goal, 'goal');
  validateSteps(payload.steps);
}

function validateWorkflowForSave(workflow) {
  assertObject(workflow, 'workflow');
  assertNonEmptyString(workflow.title, 'workflow.title');
  assertNonEmptyString(workflow.goal, 'workflow.goal');
  validateSteps(workflow.steps);
}

function validateSaveWorkflowPayload(payload) {
  assertObject(payload, 'workflow save payload');
  assertNonEmptyString(payload.draftId, 'draftId');
  assertNonEmptyString(payload.editor, 'editor');
  validateWorkflowForSave(payload.workflow);
}

function validateRecordingStartPayload(payload) {
  assertObject(payload, 'recording start payload');
  assertNonEmptyString(payload.title, 'title');
  assertNonEmptyString(payload.goal, 'goal');
}

function validateRecordingEventPayload(payload) {
  assertObject(payload, 'recording event payload');
  assertNonEmptyString(payload.type, 'type');
  assertNonEmptyString(payload.selector, 'selector');
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function renderHomePage() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>AgentBrowser Phase 1</title>
  <style>
    :root { color-scheme: light dark; font-family: sans-serif; }
    body { margin: 2rem; max-width: 1100px; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 1.5rem; }
    textarea, input { width: 100%; margin-bottom: 0.75rem; }
    textarea { min-height: 6rem; }
    pre { white-space: pre-wrap; padding: 1rem; border: 1px solid #9994; border-radius: 8px; }
    button { padding: 0.7rem 1rem; margin-right: 0.5rem; }
    .status { margin: 1rem 0; font-weight: 600; }
  </style>
</head>
<body>
  <h1>Record / Stop browser demonstration</h1>
  <p>Phase 1 record/stop surface for durable browser-session capture.</p>
  <div class="grid">
    <section>
      <label>Recording title <input id="title" value="Demo recording" /></label>
      <label>Recording goal <input id="goal" value="Capture a browser workflow demo" /></label>
      <button id="start-button">Start recording</button>
      <button id="add-event-button" disabled>Add sample event</button>
      <button id="stop-button" disabled>Stop recording</button>
      <div class="status" id="recording-status">No active recording.</div>
      <pre id="recording-json">No recording yet.</pre>
    </section>
    <section>
      <h2>Durable recording artifact</h2>
      <p>Start a recording, add at least one event, then stop to create a durable recording JSON artifact with checksum and timestamps.</p>
      <pre id="artifact-hint">Artifact path appears after stop.</pre>
    </section>
  </div>
  <script>
    let activeRecording = null;

    async function refreshRecordingView(recording, artifactPath) {
      document.getElementById('recording-json').textContent = JSON.stringify(recording, null, 2);
      document.getElementById('artifact-hint').textContent = artifactPath || 'Artifact path appears after stop.';
      document.getElementById('recording-status').textContent = recording.status === 'recording'
        ? 'Recording ' + recording.recordingId + ' is active.'
        : 'Recording ' + recording.recordingId + ' stopped with ' + (recording.eventCount || recording.events.length) + ' event(s).';
      document.getElementById('add-event-button').disabled = recording.status !== 'recording';
      document.getElementById('stop-button').disabled = recording.status !== 'recording';
    }

    document.getElementById('start-button').addEventListener('click', async () => {
      const response = await fetch('/recordings/start', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          title: document.getElementById('title').value,
          goal: document.getElementById('goal').value,
          startedBy: 'browser-demo-ui'
        })
      });
      const payload = await response.json();
      activeRecording = payload.recording;
      await refreshRecordingView(payload.recording, payload.recordingPath);
    });

    document.getElementById('add-event-button').addEventListener('click', async () => {
      if (!activeRecording) return;
      const response = await fetch('/recordings/' + activeRecording.recordingId + '/events', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'click',
          selector: '#demo-button',
          note: 'Sample browser event',
          expectedOutput: 'Demo button activated'
        })
      });
      const payload = await response.json();
      activeRecording = payload.recording;
      await refreshRecordingView(payload.recording, payload.recordingPath);
    });

    document.getElementById('stop-button').addEventListener('click', async () => {
      if (!activeRecording) return;
      const response = await fetch('/recordings/' + activeRecording.recordingId + '/stop', { method: 'POST' });
      const payload = await response.json();
      activeRecording = payload.recording;
      await refreshRecordingView(payload.recording, payload.recordingPath);
    });
  </script>
</body>
</html>`;
}

function renderReviewPage(draft) {
  const workflowJson = JSON.stringify(draft.workflow, null, 2);
  const provenanceJson = JSON.stringify(draft.fieldProvenance ?? {}, null, 2);

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(draft.workflow.title)} Review</title>
  <style>
    :root { color-scheme: light dark; font-family: sans-serif; }
    body { margin: 2rem; max-width: 1100px; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 1.5rem; }
    textarea { width: 100%; min-height: 24rem; font-family: monospace; }
    pre { white-space: pre-wrap; word-break: break-word; padding: 1rem; border: 1px solid #9994; border-radius: 8px; }
    button { padding: 0.7rem 1rem; }
    .meta { margin-bottom: 1rem; }
    .status { margin-top: 1rem; font-weight: 600; }
  </style>
</head>
<body>
  <h1>Workflow review and save</h1>
  <div class="meta">
    <div><strong>Draft ID:</strong> ${escapeHtml(draft.draftId)}</div>
    <div><strong>Raw capture ID:</strong> ${escapeHtml(draft.provenance.rawCaptureId)}</div>
    <div><strong>Generated at:</strong> ${escapeHtml(draft.generatedAt)}</div>
  </div>
  <div class="grid">
    <section>
      <h2>Editable workflow package</h2>
      <textarea id="workflow-editor">${escapeHtml(workflowJson)}</textarea>
      <p>Edit the generated workflow JSON, then save a durable version.</p>
      <button id="save-button">Save workflow version</button>
      <div class="status" id="save-status"></div>
    </section>
    <section>
      <h2>Field provenance</h2>
      <pre id="provenance-view">${escapeHtml(provenanceJson)}</pre>
    </section>
  </div>
  <script>
    const saveButton = document.getElementById('save-button');
    const saveStatus = document.getElementById('save-status');
    saveButton.addEventListener('click', async () => {
      saveStatus.textContent = 'Saving…';
      let workflow;
      try {
        workflow = JSON.parse(document.getElementById('workflow-editor').value);
      } catch (error) {
        saveStatus.textContent = 'Workflow JSON must be valid before saving.';
        return;
      }

      const response = await fetch('/workflows', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          draftId: ${JSON.stringify(draft.draftId)},
          editor: 'review-ui',
          workflow
        })
      });
      const payload = await response.json();
      if (!response.ok) {
        saveStatus.textContent = payload.error || 'Save failed';
        return;
      }
      saveStatus.textContent = 'Saved ' + payload.saved.workflowId + ' at ' + payload.saved.savedAt;
    });
  </script>
</body>
</html>`;
}

export async function createServer({ dataRoot = process.env.WORKFLOW_DATA_DIR || path.join(process.cwd(), '.runtime-artifacts') } = {}) {
  await mkdir(dataRoot, { recursive: true });
  const store = new WorkflowStore(dataRoot);
  await store.init();

  const server = http.createServer(async (req, res) => {
    try {
      if (req.method === 'GET' && req.url === '/health') {
        return json(res, 200, { ok: true, dataRoot, hostname: os.hostname() });
      }

      if (req.method === 'GET' && req.url === '/') {
        return html(res, 200, renderHomePage());
      }

      if (req.method === 'POST' && req.url === '/recordings/start') {
        const body = await readBody(req);
        validateRecordingStartPayload(body);
        const recording = await store.startRecordingSession(body);
        return json(res, 201, {
          recording,
          recordingPath: path.join(dataRoot, 'recordings', `${recording.recordingId}.json`)
        });
      }

      if (req.method === 'POST' && /^\/recordings\/[^/]+\/events$/.test(req.url || '')) {
        const recordingId = req.url.split('/')[2];
        const body = await readBody(req);
        validateRecordingEventPayload(body);
        const { recording } = await store.appendRecordingEvent(recordingId, body);
        return json(res, 200, {
          recording,
          recordingPath: path.join(dataRoot, 'recordings', `${recording.recordingId}.json`)
        });
      }

      if (req.method === 'POST' && /^\/recordings\/[^/]+\/stop$/.test(req.url || '')) {
        const recordingId = req.url.split('/')[2];
        const recording = await store.stopRecordingSession(recordingId);
        return json(res, 200, {
          recording,
          recordingPath: path.join(dataRoot, 'recordings', `${recording.recordingId}.json`)
        });
      }

      if (req.method === 'GET' && /^\/recordings\/[^/]+$/.test(req.url || '')) {
        const recordingId = req.url.split('/')[2];
        return json(res, 200, await store.getRecording(recordingId));
      }

      if (req.method === 'POST' && req.url === '/captures') {
        const body = await readBody(req);
        validateCapturePayload(body);
        const rawCapture = await store.recordCapture(body);
        const draft = await store.generateDraft(rawCapture);
        return json(res, 201, {
          rawCapture,
          draft,
          reviewSurface: {
            rawCapturePath: path.join(dataRoot, 'raw-captures', `${rawCapture.captureId}.json`),
            draftPath: path.join(dataRoot, 'generated-drafts', `${draft.draftId}.json`),
            reviewUrl: `/review/${draft.draftId}`
          }
        });
      }

      if (req.method === 'GET' && req.url?.startsWith('/drafts/')) {
        const draftId = req.url.split('/').at(-1);
        return json(res, 200, await store.getDraft(draftId));
      }

      if (req.method === 'GET' && req.url?.startsWith('/review/')) {
        const draftId = req.url.split('/').at(-1);
        const draft = await store.getDraft(draftId);
        return html(res, 200, renderReviewPage(draft));
      }

      if (req.method === 'POST' && req.url === '/workflows') {
        const body = await readBody(req);
        validateSaveWorkflowPayload(body);
        const saved = await store.saveWorkflow(body);
        return json(res, 201, {
          saved,
          savedPath: path.join(dataRoot, 'saved-workflows', `${saved.workflowId}.json`)
        });
      }

      if (req.method === 'GET' && req.url === '/workflows') {
        return json(res, 200, { items: await store.listSaved() });
      }

      json(res, 404, { error: 'Not found' });
    } catch (error) {
      const statusCode = error instanceof HttpError ? error.statusCode : 500;
      json(res, statusCode, { error: error instanceof Error ? error.message : String(error) });
    }
  });

  return { server, dataRoot };
}

async function startServer() {
  const { server } = await createServer();
  const port = Number(process.env.PORT || 3000);
  server.listen(port, '127.0.0.1', () => {
    console.log(`AgentBrowser workflow seam listening on http://127.0.0.1:${port}`);
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await startServer();
}
