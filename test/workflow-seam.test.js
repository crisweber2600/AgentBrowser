import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile } from 'node:fs/promises';
import { once } from 'node:events';
import { WorkflowStore } from '../src/workflow-store.js';
import { createServer } from '../src/server.js';

test('raw capture, generated draft, and saved workflow preserve provenance', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agentbrowser-'));
  const store = new WorkflowStore(root);
  await store.init();

  const raw = await store.recordCapture({
    title: 'Upload product screenshots',
    goal: 'Turn a browser demo into an editable workflow package',
    steps: [
      {
        action: 'Open uploads page',
        target: '/uploads',
        expectedOutput: 'Upload form is visible',
        recoveryRule: 'Refresh once then retry',
        validationCheck: 'Form fields and upload button render'
      },
      {
        action: 'Choose zip file',
        target: 'file input',
        expectedOutput: 'Selected file name is visible',
        recoveryRule: 'Re-open file picker and reselect',
        validationCheck: 'Filename matches chosen artifact'
      }
    ]
  });

  const draft = await store.generateDraft(raw);
  assert.equal(draft.provenance.rawCaptureId, raw.captureId);
  assert.equal(draft.workflow.steps.length, 2);
  assert.ok(draft.workflow.browserUsePromptPlaceholder);
  assert.equal(draft.fieldProvenance.goal.sourcePath, 'payload.goal');
  assert.equal(draft.fieldProvenance.steps[0].action.value, 'Open uploads page');

  draft.workflow.goal = 'Edited workflow goal';
  const saved = await store.saveWorkflow({ draftId: draft.draftId, editor: 'runtime-integration-specialist', workflow: draft.workflow });
  assert.equal(saved.fieldProvenance.goal.value, raw.payload.goal);

  const rawPath = path.join(root, 'raw-captures', `${raw.captureId}.json`);
  const rawOnDisk = JSON.parse(await readFile(rawPath, 'utf8'));
  assert.equal(rawOnDisk.payload.goal, 'Turn a browser demo into an editable workflow package');
});

test('recording start, event append, and stop create durable recording artifact', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agentbrowser-'));
  const { server } = await createServer({ dataRoot: root });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const address = server.address();
    assert.ok(address && typeof address === 'object');

    const startResponse = await fetch(`http://127.0.0.1:${address.port}/recordings/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Browser login demo', goal: 'Record a login flow', startedBy: 'test-suite' })
    });
    assert.equal(startResponse.status, 201);
    const started = await startResponse.json();
    assert.equal(started.recording.status, 'recording');

    const eventResponse = await fetch(`http://127.0.0.1:${address.port}/recordings/${started.recording.recordingId}/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'click', selector: '#login', expectedOutput: 'Login modal opens' })
    });
    assert.equal(eventResponse.status, 200);
    const appended = await eventResponse.json();
    assert.equal(appended.recording.events.length, 1);

    const stopResponse = await fetch(`http://127.0.0.1:${address.port}/recordings/${started.recording.recordingId}/stop`, { method: 'POST' });
    assert.equal(stopResponse.status, 200);
    const stopped = await stopResponse.json();
    assert.equal(stopped.recording.status, 'stopped');
    assert.equal(stopped.recording.eventCount, 1);
    assert.ok(stopped.recording.recordingChecksum);

    const persisted = JSON.parse(await readFile(stopped.recordingPath, 'utf8'));
    assert.equal(persisted.status, 'stopped');
    assert.equal(persisted.events[0].selector, '#login');
  } finally {
    server.close();
    await once(server, 'close');
  }
});

test('POST /captures rejects malformed workflow capture payloads', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agentbrowser-'));
  const { server } = await createServer({ dataRoot: root });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const response = await fetch(`http://127.0.0.1:${address.port}/captures`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'Missing steps capture', goal: 'Reject malformed capture payload', steps: [] })
    });
    assert.equal(response.status, 400);
  } finally {
    server.close();
    await once(server, 'close');
  }
});

test('POST /workflows rejects malformed save payloads', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agentbrowser-'));
  const { server } = await createServer({ dataRoot: root });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const captureResponse = await fetch(`http://127.0.0.1:${address.port}/captures`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'Valid capture', goal: 'Create a draft first', steps: [{ action: 'Open page', target: '/workflows', expectedOutput: 'Workflow page renders' }] })
    });
    const created = await captureResponse.json();
    const response = await fetch(`http://127.0.0.1:${address.port}/workflows`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ draftId: created.draft.draftId, editor: 'runtime-integration-specialist', workflow: { title: 'Broken workflow', goal: 'Reject malformed saved workflow payload', steps: [{ action: '', target: '/workflows', expectedOutput: 'Should fail validation' }] } })
    });
    assert.equal(response.status, 400);
  } finally {
    server.close();
    await once(server, 'close');
  }
});

test('review page exposes editable workflow JSON and provenance for a generated draft', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agentbrowser-'));
  const { server } = await createServer({ dataRoot: root });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const captureResponse = await fetch(`http://127.0.0.1:${address.port}/captures`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'Reviewable capture', goal: 'Render review surface', steps: [{ action: 'Click record', target: '#record', expectedOutput: 'Recording starts', validationCheck: 'Timer increments' }] })
    });
    const created = await captureResponse.json();
    const reviewResponse = await fetch(`http://127.0.0.1:${address.port}${created.reviewSurface.reviewUrl}`);
    const reviewHtml = await reviewResponse.text();
    assert.match(reviewHtml, /Workflow review and save/);
    assert.match(reviewHtml, /&quot;sourcePath&quot;: &quot;payload\.goal&quot;/);
  } finally {
    server.close();
    await once(server, 'close');
  }
});

test('home page exposes record and stop browser session controls', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agentbrowser-'));
  const { server } = await createServer({ dataRoot: root });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const response = await fetch(`http://127.0.0.1:${address.port}/`);
    const page = await response.text();
    assert.match(page, /Record \/ Stop browser demonstration/);
    assert.match(page, /Start recording/);
    assert.match(page, /Stop recording/);
    assert.match(page, /Durable recording artifact/);
  } finally {
    server.close();
    await once(server, 'close');
  }
});

test('server startup emits a bootstrap browser extension package scaffold', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agentbrowser-'));
  const { server } = await createServer({ dataRoot: root });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const manifest = JSON.parse(await readFile(path.join(root, 'browser-extensions', 'bootstrap-extension', 'manifest.json'), 'utf8'));
    const workflowPackage = JSON.parse(await readFile(path.join(root, 'browser-extensions', 'bootstrap-extension', 'workflow.json'), 'utf8'));

    assert.equal(manifest.manifest_version, 3);
    assert.equal(manifest.action.default_popup, 'popup.html');
    assert.equal(workflowPackage.workflowId, 'bootstrap-extension');
    assert.equal(workflowPackage.provenance.rawCaptureId, 'bootstrap-template');
  } finally {
    server.close();
    await once(server, 'close');
  }
});

test('saved workflow can execute into a durable validation artifact', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agentbrowser-'));
  const { server } = await createServer({ dataRoot: root });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const address = server.address();
    assert.ok(address && typeof address === 'object');

    const captureResponse = await fetch(`http://127.0.0.1:${address.port}/captures`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: 'Execution-ready capture',
        goal: 'Execute the saved workflow and persist validation output',
        steps: [
          { action: 'Open dashboard', target: '/dashboard', expectedOutput: 'Dashboard renders', validationCheck: 'Main heading is visible' },
          { action: 'Click export', target: '#export', expectedOutput: 'Export starts', validationCheck: 'Export toast appears' }
        ]
      })
    });
    assert.equal(captureResponse.status, 201);
    const created = await captureResponse.json();

    const saveResponse = await fetch(`http://127.0.0.1:${address.port}/workflows`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        draftId: created.draft.draftId,
        editor: 'runtime-integration-specialist',
        workflow: created.draft.workflow
      })
    });
    assert.equal(saveResponse.status, 201);
    const saved = await saveResponse.json();

    const executionResponse = await fetch(`http://127.0.0.1:${address.port}/executions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        workflowId: saved.saved.workflowId,
        executor: 'browser-use',
        mode: 'browser-use-live',
        input: {
          source: 'saved-workflow-review',
          baseUrl: `http://127.0.0.1:${address.port}`
        }
      })
    });
    assert.equal(executionResponse.status, 201);
    const executed = await executionResponse.json();
    assert.equal(executed.execution.workflowId, saved.saved.workflowId);
    assert.equal(executed.execution.validation.status, 'passed');
    assert.equal(executed.execution.stepResults.length, 2);
    assert.ok(executed.execution.executionChecksum);
    assert.equal(executed.execution.mode, 'browser-use-live');
    assert.equal(executed.execution.stepResults[0].runtimeRequest.method, 'BROWSER_GOTO');
    assert.equal(executed.execution.stepResults[0].runtimeRequest.statusCode, 200);
    assert.equal(executed.execution.stepResults[0].browserEvidence.mode, 'playwright-chromium-headless');
    assert.match(executed.execution.stepResults[0].browserEvidence.currentUrl, /\/dashboard$/);
    assert.equal(executed.execution.stepResults[1].runtimeRequest.method, 'BROWSER_CLICK');
    assert.equal(executed.execution.stepResults[1].runtimeRequest.statusCode, 201);
    assert.equal(executed.execution.stepResults[1].browserEvidence.selector, '#export');
    assert.equal(executed.execution.stepResults[1].outputArtifact.status, 'validated');
    assert.match(executed.execution.stepResults[1].outputArtifact.readbackPath, /^\/exports\//);
    assert.equal(executed.execution.finalOutput.exportedArtifacts.length, 1);

    const persisted = JSON.parse(await readFile(executed.executionPath, 'utf8'));
    assert.equal(persisted.executor, 'browser-use');
    assert.equal(persisted.finalOutput.status, 'validated');
    assert.equal(persisted.provenance.rawCaptureId, created.rawCapture.captureId);
    assert.equal(persisted.stepResults[0].browserEvidence.mode, 'playwright-chromium-headless');
    assert.equal(persisted.stepResults[1].outputArtifact.status, 'validated');
  } finally {
    server.close();
    await once(server, 'close');
  }
});

test('POST /executions rejects malformed execution payloads', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agentbrowser-'));
  const { server } = await createServer({ dataRoot: root });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const response = await fetch(`http://127.0.0.1:${address.port}/executions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workflowId: '', executor: '' })
    });
    assert.equal(response.status, 400);
  } finally {
    server.close();
    await once(server, 'close');
  }
});

test('POST /executions rejects non-local baseUrl values before live fetch', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agentbrowser-'));
  const { server } = await createServer({ dataRoot: root });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const address = server.address();
    assert.ok(address && typeof address === 'object');

    const captureResponse = await fetch(`http://127.0.0.1:${address.port}/captures`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: 'Blocked external base URL',
        goal: 'Reject non-local live execution targets',
        steps: [
          { action: 'Open dashboard', target: '/dashboard', expectedOutput: 'Dashboard renders', validationCheck: 'Main heading is visible' }
        ]
      })
    });
    const created = await captureResponse.json();

    const saveResponse = await fetch(`http://127.0.0.1:${address.port}/workflows`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ draftId: created.draft.draftId, editor: 'runtime-integration-specialist', workflow: created.draft.workflow })
    });
    const saved = await saveResponse.json();

    const response = await fetch(`http://127.0.0.1:${address.port}/executions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        workflowId: saved.saved.workflowId,
        executor: 'browser-use',
        mode: 'browser-use-live',
        input: { baseUrl: 'https://example.com' }
      })
    });

    assert.equal(response.status, 500);
    const body = await response.json();
    assert.match(body.error, /host is not allowed/i);
  } finally {
    server.close();
    await once(server, 'close');
  }
});

test('POST /executions rejects unexpected schemes for live execution baseUrl', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agentbrowser-'));
  const { server } = await createServer({ dataRoot: root });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const address = server.address();
    assert.ok(address && typeof address === 'object');

    const captureResponse = await fetch(`http://127.0.0.1:${address.port}/captures`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: 'Blocked scheme base URL',
        goal: 'Reject unexpected schemes',
        steps: [
          { action: 'Open dashboard', target: '/dashboard', expectedOutput: 'Dashboard renders', validationCheck: 'Main heading is visible' }
        ]
      })
    });
    const created = await captureResponse.json();

    const saveResponse = await fetch(`http://127.0.0.1:${address.port}/workflows`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ draftId: created.draft.draftId, editor: 'runtime-integration-specialist', workflow: created.draft.workflow })
    });
    const saved = await saveResponse.json();

    const response = await fetch(`http://127.0.0.1:${address.port}/executions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        workflowId: saved.saved.workflowId,
        executor: 'browser-use',
        mode: 'browser-use-live',
        input: { baseUrl: 'file:///tmp/agentbrowser' }
      })
    });

    assert.equal(response.status, 500);
    const body = await response.json();
    assert.match(body.error, /must use http or https/i);
  } finally {
    server.close();
    await once(server, 'close');
  }
});

test('POST /executions accepts IPv6 loopback baseUrl values for live execution', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agentbrowser-'));
  const { server } = await createServer({ dataRoot: root });
  server.listen(0, '::1');
  await once(server, 'listening');
  try {
    const address = server.address();
    assert.ok(address && typeof address === 'object');

    const captureResponse = await fetch(`http://[::1]:${address.port}/captures`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: 'IPv6 loopback execution',
        goal: 'Allow approved IPv6 loopback live execution targets',
        steps: [
          { action: 'Open dashboard', target: '/dashboard', expectedOutput: 'Dashboard renders', validationCheck: 'Main heading is visible' },
          { action: 'Click export', target: '#export', expectedOutput: 'Export starts', validationCheck: 'Export toast appears' }
        ]
      })
    });
    assert.equal(captureResponse.status, 201);
    const created = await captureResponse.json();

    const saveResponse = await fetch(`http://[::1]:${address.port}/workflows`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        draftId: created.draft.draftId,
        editor: 'runtime-integration-specialist',
        workflow: created.draft.workflow
      })
    });
    assert.equal(saveResponse.status, 201);
    const saved = await saveResponse.json();

    const executionResponse = await fetch(`http://[::1]:${address.port}/executions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        workflowId: saved.saved.workflowId,
        executor: 'browser-use',
        mode: 'browser-use-live',
        input: {
          source: 'saved-workflow-review',
          baseUrl: `http://[::1]:${address.port}`
        }
      })
    });
    assert.equal(executionResponse.status, 201);
    const executed = await executionResponse.json();
    assert.equal(executed.execution.validation.status, 'passed');
    assert.equal(executed.execution.stepResults[0].runtimeRequest.method, 'BROWSER_GOTO');
    assert.equal(executed.execution.stepResults[0].runtimeRequest.statusCode, 200);
    assert.equal(executed.execution.stepResults[1].runtimeRequest.method, 'BROWSER_CLICK');
    assert.equal(executed.execution.stepResults[1].runtimeRequest.statusCode, 201);
  } finally {
    server.close();
    await once(server, 'close');
  }
});

test('integrated closure proof preserves record to draft to saved workflow to live execution to export readback', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agentbrowser-'));
  const { server } = await createServer({ dataRoot: root });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const startResponse = await fetch(`${baseUrl}/recordings/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: 'Integrated closure proof recording',
        goal: 'Prove record, save, execute, and export continuity'
      })
    });
    assert.equal(startResponse.status, 201);
    const started = await startResponse.json();

    const eventOneResponse = await fetch(`${baseUrl}/recordings/${started.recording.recordingId}/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'goto',
        selector: '/dashboard',
        detail: 'Open the dashboard view'
      })
    });
    assert.equal(eventOneResponse.status, 200);

    const eventTwoResponse = await fetch(`${baseUrl}/recordings/${started.recording.recordingId}/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'click',
        selector: '#export',
        detail: 'Trigger workflow export'
      })
    });
    assert.equal(eventTwoResponse.status, 200);

    const stopResponse = await fetch(`${baseUrl}/recordings/${started.recording.recordingId}/stop`, {
      method: 'POST'
    });
    assert.equal(stopResponse.status, 200);
    const stopped = await stopResponse.json();
    assert.equal(stopped.recording.eventCount, 2);

    const captureResponse = await fetch(`${baseUrl}/captures`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: 'Integrated closure proof capture',
        goal: 'Generate an editable workflow from a durable recording and prove live execution output',
        steps: [
          { action: 'Open dashboard', target: '/dashboard', expectedOutput: 'Dashboard renders', validationCheck: 'Main heading is visible' },
          { action: 'Click export', target: '#export', expectedOutput: 'Export starts', validationCheck: 'Export toast appears' }
        ]
      })
    });
    assert.equal(captureResponse.status, 201);
    const created = await captureResponse.json();

    const saveResponse = await fetch(`${baseUrl}/workflows`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        draftId: created.draft.draftId,
        editor: 'ceo-phase-3-proof',
        workflow: created.draft.workflow
      })
    });
    assert.equal(saveResponse.status, 201);
    const saved = await saveResponse.json();

    const executionResponse = await fetch(`${baseUrl}/executions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        workflowId: saved.saved.workflowId,
        executor: 'browser-use',
        mode: 'browser-use-live',
        input: {
          source: stopped.recording.recordingId,
          recordingId: stopped.recording.recordingId,
          baseUrl
        }
      })
    });
    assert.equal(executionResponse.status, 201);
    const executed = await executionResponse.json();

    assert.equal(executed.execution.validation.status, 'passed');
    assert.equal(executed.execution.provenance.rawCaptureId, created.rawCapture.captureId);
    assert.equal(executed.execution.stepResults.length, 2);
    assert.equal(executed.execution.stepResults[0].runtimeRequest.method, 'BROWSER_GOTO');
    assert.equal(executed.execution.stepResults[1].runtimeRequest.method, 'BROWSER_CLICK');
    assert.equal(executed.execution.finalOutput.exportedArtifacts.length, 1);
    assert.match(executed.execution.finalOutput.exportedArtifacts[0].readbackPath, /^\/exports\//);

    const persistedExecution = JSON.parse(await readFile(executed.executionPath, 'utf8'));
    const persistedRecording = JSON.parse(await readFile(stopped.recordingPath, 'utf8'));
    const persistedSavedWorkflow = JSON.parse(await readFile(saved.savedPath, 'utf8'));

    assert.equal(persistedRecording.recordingId, stopped.recording.recordingId);
    assert.equal(persistedRecording.eventCount, 2);
    assert.equal(persistedSavedWorkflow.provenance.rawCaptureId, created.rawCapture.captureId);
    assert.equal(persistedExecution.workflowId, saved.saved.workflowId);
    assert.equal(persistedExecution.input.recordingId, stopped.recording.recordingId);
    assert.equal(persistedExecution.finalOutput.status, 'validated');
    assert.equal(persistedExecution.finalOutput.exportedArtifacts[0].status, 'validated');
  } finally {
    server.close();
    await once(server, 'close');
  }
});

test('saved workflow emits a browser extension package artifact with workflow provenance', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agentbrowser-'));
  const { server } = await createServer({ dataRoot: root });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const captureResponse = await fetch(`${baseUrl}/captures`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: 'Extension-ready capture',
        goal: 'Generate an editable workflow and extension artifact',
        steps: [
          { action: 'Open dashboard', target: '/dashboard', expectedOutput: 'Dashboard renders', validationCheck: 'Main heading is visible' },
          { action: 'Click export', target: '#export', expectedOutput: 'Export starts', validationCheck: 'Export toast appears' }
        ]
      })
    });
    assert.equal(captureResponse.status, 201);
    const created = await captureResponse.json();

    const saveResponse = await fetch(`${baseUrl}/workflows`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        draftId: created.draft.draftId,
        editor: 'runtime-integration-specialist',
        workflow: created.draft.workflow
      })
    });
    assert.equal(saveResponse.status, 201);
    const saved = await saveResponse.json();

    assert.equal(saved.saved.extensionPackage.manifest.manifest_version, 3);
    assert.equal(saved.saved.extensionPackage.entrypoints.popup, 'popup.html');
    assert.equal(saved.saved.extensionPackage.entrypoints.workflow, 'workflow.json');
    assert.ok(saved.saved.extensionPackage.files['manifest.json']);
    assert.ok(saved.saved.extensionPackage.files['popup.html']);
    assert.ok(saved.saved.extensionPackage.files['popup.js']);
    assert.ok(saved.saved.extensionPackage.files['workflow.json']);

    const persistedSavedWorkflow = JSON.parse(await readFile(saved.savedPath, 'utf8'));
    assert.equal(persistedSavedWorkflow.extensionPackage.manifest.action.default_popup, 'popup.html');
    assert.equal(persistedSavedWorkflow.extensionPackage.files['workflow.json'].includes(created.rawCapture.captureId), true);

    const extensionManifest = JSON.parse(await readFile(path.join(root, 'browser-extensions', saved.saved.workflowId, 'manifest.json'), 'utf8'));
    const extensionWorkflow = JSON.parse(await readFile(path.join(root, 'browser-extensions', saved.saved.workflowId, 'workflow.json'), 'utf8'));
    assert.equal(extensionManifest.manifest_version, 3);
    assert.equal(extensionWorkflow.provenance.rawCaptureId, created.rawCapture.captureId);
    assert.equal(extensionWorkflow.workflowId, saved.saved.workflowId);
  } finally {
    server.close();
    await once(server, 'close');
  }
});
