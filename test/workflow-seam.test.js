import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile } from 'node:fs/promises';
import { WorkflowStore } from '../src/workflow-store.js';

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

  const rawPath = path.join(root, 'raw-captures', `${raw.captureId}.json`);
  const rawOnDisk = JSON.parse(await readFile(rawPath, 'utf8'));
  assert.equal(rawOnDisk.payload.goal, 'Turn a browser demo into an editable workflow package');
});
