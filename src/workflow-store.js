import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

function nowIso() {
  return new Date().toISOString();
}

export async function sha256(value) {
  return crypto.createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
}

export class WorkflowStore {
  constructor(rootDir) {
    this.rootDir = rootDir;
    this.rawDir = path.join(rootDir, 'raw-captures');
    this.draftDir = path.join(rootDir, 'generated-drafts');
    this.savedDir = path.join(rootDir, 'saved-workflows');
  }

  async init() {
    await Promise.all([
      mkdir(this.rawDir, { recursive: true }),
      mkdir(this.draftDir, { recursive: true }),
      mkdir(this.savedDir, { recursive: true })
    ]);
  }

  async recordCapture(payload) {
    const captureId = `capture_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;
    const recordedAt = nowIso();
    const rawCapture = {
      captureId,
      recordedAt,
      payload,
      payloadChecksum: await sha256(payload)
    };
    await writeJson(path.join(this.rawDir, `${captureId}.json`), rawCapture);
    return rawCapture;
  }

  async generateDraft(rawCapture, options = {}) {
    const draftId = `draft_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;
    const steps = Array.isArray(rawCapture.payload.steps) ? rawCapture.payload.steps : [];
    const fieldProvenance = buildFieldProvenance(rawCapture, steps);
    const draft = {
      draftId,
      generatedAt: nowIso(),
      provenance: {
        rawCaptureId: rawCapture.captureId,
        rawCaptureChecksum: rawCapture.payloadChecksum,
        generationMode: options.generationMode ?? 'structured-template-v1'
      },
      fieldProvenance,
      workflow: buildWorkflowPackage(rawCapture.payload, steps)
    };
    await writeJson(path.join(this.draftDir, `${draftId}.json`), draft);
    return draft;
  }

  async saveWorkflow({ draftId, editor, workflow }) {
    const sourceDraft = await this.getDraft(draftId);
    const version = {
      workflowId: `workflow_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`,
      savedAt: nowIso(),
      editor,
      provenance: {
        draftId: sourceDraft.draftId,
        rawCaptureId: sourceDraft.provenance.rawCaptureId,
        rawCaptureChecksum: sourceDraft.provenance.rawCaptureChecksum
      },
      fieldProvenance: sourceDraft.fieldProvenance,
      workflow
    };
    await writeJson(path.join(this.savedDir, `${version.workflowId}.json`), version);
    return version;
  }

  async getDraft(draftId) {
    return readJson(path.join(this.draftDir, `${draftId}.json`));
  }

  async listSaved() {
    const files = await readdir(this.savedDir);
    const items = await Promise.all(files.filter((file) => file.endsWith('.json')).map((file) => readJson(path.join(this.savedDir, file))));
    return items.sort((a, b) => a.savedAt.localeCompare(b.savedAt));
  }
}

export function buildWorkflowPackage(payload, steps) {
  const normalizedSteps = steps.map((step, index) => ({
    stepNumber: index + 1,
    action: step.action ?? `step-${index + 1}`,
    target: step.target ?? 'unspecified-target',
    expectedOutput: step.expectedOutput ?? 'unspecified-output',
    recoveryRule: step.recoveryRule ?? 'retry or request user intervention',
    validationCheck: step.validationCheck ?? 'confirm expected output is visible'
  }));

  return {
    title: payload.title ?? 'Untitled workflow',
    goal: payload.goal ?? 'Capture and replay a browser workflow',
    preconditions: payload.preconditions ?? ['Operator is authenticated', 'Required target page is reachable'],
    steps: normalizedSteps,
    expectedOutputs: payload.expectedOutputs ?? normalizedSteps.map((step) => step.expectedOutput),
    successCriteria: payload.successCriteria ?? ['All steps execute in order', 'Expected outputs are produced'],
    recoveryRules: payload.recoveryRules ?? normalizedSteps.map((step) => step.recoveryRule),
    constraints: payload.constraints ?? ['Keep raw capture immutable', 'Preserve provenance between raw, draft, and saved versions'],
    userInterventionNeeds: payload.userInterventionNeeds ?? ['Confirm unexpected captchas or MFA prompts'],
    validationChecks: payload.validationChecks ?? normalizedSteps.map((step) => step.validationCheck),
    browserUsePromptPlaceholder: payload.browserUsePromptPlaceholder ?? 'Describe how Browser Use should execute this saved workflow.'
  };
}

export function buildFieldProvenance(rawCapture, steps) {
  return {
    title: provenanceEntry(rawCapture.captureId, 'payload.title', rawCapture.payload.title, 'copied from capture title'),
    goal: provenanceEntry(rawCapture.captureId, 'payload.goal', rawCapture.payload.goal, 'copied from capture goal'),
    preconditions: provenanceEntry(rawCapture.captureId, 'payload.preconditions', rawCapture.payload.preconditions ?? ['Operator is authenticated', 'Required target page is reachable'], rawCapture.payload.preconditions ? 'copied from capture preconditions' : 'defaulted because capture omitted preconditions'),
    expectedOutputs: provenanceEntry(rawCapture.captureId, 'payload.expectedOutputs|payload.steps[*].expectedOutput', rawCapture.payload.expectedOutputs ?? steps.map((step) => step.expectedOutput), rawCapture.payload.expectedOutputs ? 'copied from capture expectedOutputs' : 'derived from each captured step expectedOutput'),
    successCriteria: provenanceEntry(rawCapture.captureId, 'payload.successCriteria', rawCapture.payload.successCriteria ?? ['All steps execute in order', 'Expected outputs are produced'], rawCapture.payload.successCriteria ? 'copied from capture successCriteria' : 'defaulted because capture omitted successCriteria'),
    recoveryRules: provenanceEntry(rawCapture.captureId, 'payload.recoveryRules|payload.steps[*].recoveryRule', rawCapture.payload.recoveryRules ?? steps.map((step) => step.recoveryRule ?? 'retry or request user intervention'), rawCapture.payload.recoveryRules ? 'copied from capture recoveryRules' : 'derived from step recoveryRule fields or fallback defaults'),
    constraints: provenanceEntry(rawCapture.captureId, 'payload.constraints', rawCapture.payload.constraints ?? ['Keep raw capture immutable', 'Preserve provenance between raw, draft, and saved versions'], rawCapture.payload.constraints ? 'copied from capture constraints' : 'defaulted to preserve Phase 1 artifact seam guarantees'),
    userInterventionNeeds: provenanceEntry(rawCapture.captureId, 'payload.userInterventionNeeds', rawCapture.payload.userInterventionNeeds ?? ['Confirm unexpected captchas or MFA prompts'], rawCapture.payload.userInterventionNeeds ? 'copied from capture userInterventionNeeds' : 'defaulted because capture omitted operator intervention guidance'),
    validationChecks: provenanceEntry(rawCapture.captureId, 'payload.validationChecks|payload.steps[*].validationCheck', rawCapture.payload.validationChecks ?? steps.map((step) => step.validationCheck ?? 'confirm expected output is visible'), rawCapture.payload.validationChecks ? 'copied from capture validationChecks' : 'derived from step validationCheck fields or fallback defaults'),
    browserUsePromptPlaceholder: provenanceEntry(rawCapture.captureId, 'payload.browserUsePromptPlaceholder', rawCapture.payload.browserUsePromptPlaceholder ?? 'Describe how Browser Use should execute this saved workflow.', rawCapture.payload.browserUsePromptPlaceholder ? 'copied from capture browserUsePromptPlaceholder' : 'defaulted placeholder for later Phase 2 Browser Use wiring'),
    steps: steps.map((step, index) => ({
      stepNumber: provenanceEntry(rawCapture.captureId, `payload.steps[${index}]`, index + 1, 'derived from captured step order'),
      action: provenanceEntry(rawCapture.captureId, `payload.steps[${index}].action`, step.action, 'copied from captured step action'),
      target: provenanceEntry(rawCapture.captureId, `payload.steps[${index}].target`, step.target, 'copied from captured step target'),
      expectedOutput: provenanceEntry(rawCapture.captureId, `payload.steps[${index}].expectedOutput`, step.expectedOutput, 'copied from captured step expectedOutput'),
      recoveryRule: provenanceEntry(rawCapture.captureId, `payload.steps[${index}].recoveryRule`, step.recoveryRule ?? 'retry or request user intervention', step.recoveryRule ? 'copied from captured step recoveryRule' : 'defaulted because capture omitted recoveryRule'),
      validationCheck: provenanceEntry(rawCapture.captureId, `payload.steps[${index}].validationCheck`, step.validationCheck ?? 'confirm expected output is visible', step.validationCheck ? 'copied from captured step validationCheck' : 'defaulted because capture omitted validationCheck')
    }))
  };
}

function provenanceEntry(rawCaptureId, sourcePath, value, derivationMethod) {
  return {
    rawCaptureId,
    sourcePath,
    value,
    derivationMethod
  };
}

async function writeJson(filePath, value) {
  await writeFile(filePath, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

async function readJson(filePath) {
  const content = await readFile(filePath, 'utf8');
  return JSON.parse(content);
}
