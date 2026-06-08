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
  assert.deepEqual(Object.keys(draft.workflow).sort(), [
    'browserUsePromptPlaceholder',
    'constraints',
    'expectedOutputs',
    'goal',
    'preconditions',
    'recoveryRules',
    'steps',
    'successCriteria',
    'title',
    'userInterventionNeeds',
    'validationChecks'
  ]);

  draft.workflow.goal = 'Edited workflow goal';
  const saved = await store.saveWorkflow({
    draftId: draft.draftId,
    editor: 'runtime-integration-specialist',
    workflow: draft.workflow
  });

  assert.equal(saved.provenance.draftId, draft.draftId);
  assert.equal(saved.provenance.rawCaptureId, raw.captureId);
  assert.equal(saved.workflow.goal, 'Edited workflow goal');
  assert.equal(saved.fieldProvenance.goal.value, raw.payload.goal);

  const rawPath = path.join(root, 'raw-captures', `${raw.captureId}.json`);
  const rawOnDisk = JSON.parse(await readFile(rawPath, 'utf8'));
  assert.equal(rawOnDisk.payload.goal, 'Turn a browser demo into an editable workflow package');
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
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: 'Missing steps capture',
        goal: 'Reject malformed capture payload',
        steps: []
      })
    });

    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: 'steps must be a non-empty array' });
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
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: 'Valid capture',
        goal: 'Create a draft first',
        steps: [
          {
            action: 'Open page',
            target: '/workflows',
            expectedOutput: 'Workflow page renders'
          }
        ]
      })
    });
    assert.equal(captureResponse.status, 201);
    const created = await captureResponse.json();

    const response = await fetch(`http://127.0.0.1:${address.port}/workflows`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        draftId: created.draft.draftId,
        editor: 'runtime-integration-specialist',
        workflow: {
          title: 'Broken workflow',
          goal: 'Reject malformed saved workflow payload',
          steps: [
            {
              action: '',
              target: '/workflows',
              expectedOutput: 'Should fail validation'
            }
          ]
        }
      })
    });

    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: 'steps[0].action must be a non-empty string' });
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
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: 'Reviewable capture',
        goal: 'Render review surface',
        steps: [
          {
            action: 'Click record',
            target: '#record',
            expectedOutput: 'Recording starts',
            validationCheck: 'Timer increments'
          }
        ]
      })
    });
    assert.equal(captureResponse.status, 201);
    const created = await captureResponse.json();

    const reviewResponse = await fetch(`http://127.0.0.1:${address.port}${created.reviewSurface.reviewUrl}`);
    assert.equal(reviewResponse.status, 200);
    const reviewHtml = await reviewResponse.text();

    assert.match(reviewHtml, /Workflow review and save/);
    assert.match(reviewHtml, /Editable workflow package/);
    assert.match(reviewHtml, /Field provenance/);
    assert.match(reviewHtml, /&quot;sourcePath&quot;: &quot;payload\.goal&quot;/);
    assert.match(reviewHtml, /&quot;value&quot;: &quot;Render review surface&quot;/);
  } finally {
    server.close();
    await once(server, 'close');
  }
});
