import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

let playwrightModulePromise;

function nowIso() {
  return new Date().toISOString();
}

export async function sha256(value) {
  return crypto.createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
}

export class WorkflowStore {
  constructor(rootDir) {
    this.rootDir = rootDir;
    this.recordingDir = path.join(rootDir, 'recordings');
    this.rawDir = path.join(rootDir, 'raw-captures');
    this.draftDir = path.join(rootDir, 'generated-drafts');
    this.savedDir = path.join(rootDir, 'saved-workflows');
    this.extensionDir = path.join(rootDir, 'browser-extensions');
    this.executionDir = path.join(rootDir, 'workflow-executions');
    this.runtimeOutputDir = path.join(rootDir, 'runtime-outputs');
  }

  async init() {
    await Promise.all([
      mkdir(this.recordingDir, { recursive: true }),
      mkdir(this.rawDir, { recursive: true }),
      mkdir(this.draftDir, { recursive: true }),
      mkdir(this.savedDir, { recursive: true }),
      mkdir(this.extensionDir, { recursive: true }),
      mkdir(this.executionDir, { recursive: true }),
      mkdir(this.runtimeOutputDir, { recursive: true })
    ]);
  }

  async startRecordingSession(payload = {}) {
    const recordingId = `recording_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;
    const recording = {
      recordingId,
      startedAt: nowIso(),
      stoppedAt: null,
      status: 'recording',
      metadata: {
        title: payload.title ?? 'Untitled browser recording',
        goal: payload.goal ?? 'Capture a browser demonstration',
        startedBy: payload.startedBy ?? 'unknown-operator'
      },
      events: []
    };
    await writeJson(path.join(this.recordingDir, `${recordingId}.json`), recording);
    return recording;
  }

  async appendRecordingEvent(recordingId, event) {
    const recording = await this.getRecording(recordingId);
    if (recording.status !== 'recording') {
      throw new Error('Recording is not active');
    }
    const nextEvent = {
      eventId: `event_${recording.events.length + 1}`,
      recordedAt: nowIso(),
      type: event.type,
      selector: event.selector,
      value: event.value ?? null,
      note: event.note ?? null,
      expectedOutput: event.expectedOutput ?? null
    };
    recording.events.push(nextEvent);
    await writeJson(path.join(this.recordingDir, `${recordingId}.json`), recording);
    return { recording, event: nextEvent };
  }

  async stopRecordingSession(recordingId) {
    const recording = await this.getRecording(recordingId);
    if (recording.status !== 'recording') {
      return recording;
    }
    recording.status = 'stopped';
    recording.stoppedAt = nowIso();
    recording.eventCount = recording.events.length;
    recording.recordingChecksum = await sha256(recording.events);
    await writeJson(path.join(this.recordingDir, `${recordingId}.json`), recording);
    return recording;
  }

  async getRecording(recordingId) {
    return readJson(path.join(this.recordingDir, `${recordingId}.json`));
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
    const workflowId = `workflow_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;
    const extensionPackage = await buildExtensionPackage({ workflowId, workflow, sourceDraft });
    const version = {
      workflowId,
      savedAt: nowIso(),
      editor,
      provenance: {
        draftId: sourceDraft.draftId,
        rawCaptureId: sourceDraft.provenance.rawCaptureId,
        rawCaptureChecksum: sourceDraft.provenance.rawCaptureChecksum
      },
      fieldProvenance: sourceDraft.fieldProvenance,
      extensionPackage,
      workflow
    };
    await writeJson(path.join(this.savedDir, `${version.workflowId}.json`), version);
    await writeExtensionPackage(this.extensionDir, version.workflowId, extensionPackage);
    return version;
  }

  async getDraft(draftId) {
    return readJson(path.join(this.draftDir, `${draftId}.json`));
  }

  async getSavedWorkflow(workflowId) {
    return readJson(path.join(this.savedDir, `${workflowId}.json`));
  }

  async listSaved() {
    const files = await readdir(this.savedDir);
    const items = await Promise.all(files.filter((file) => file.endsWith('.json')).map((file) => readJson(path.join(this.savedDir, file))));
    return items.sort((a, b) => a.savedAt.localeCompare(b.savedAt));
  }

  async createRuntimeOutput(payload) {
    const outputId = `runtime_output_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;
    const output = {
      outputId,
      createdAt: nowIso(),
      ...payload
    };
    await writeJson(path.join(this.runtimeOutputDir, `${outputId}.json`), output);
    return output;
  }

  async executeWorkflow({ workflowId, executor, mode = 'browser-use-live', input = {} }) {
    const savedWorkflow = await this.getSavedWorkflow(workflowId);
    const workflow = savedWorkflow.workflow;
    const executionId = `execution_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;
    const baseUrl = normalizeBaseUrl(input.baseUrl);
    const stepResults = [];
    const browserSession = await createBrowserSession({ baseUrl, workflowId, executionId, input });

    try {
      for (const step of workflow.steps) {
        stepResults.push(await executeWorkflowStep({
          step,
          baseUrl,
          executionId,
          workflowId,
          input,
          store: this,
          browserSession
        }));
      }
    } finally {
      await browserSession.browser.close();
    }

    const exportedArtifacts = stepResults.filter((result) => result.outputArtifact).map((result) => result.outputArtifact);

    const execution = {
      executionId,
      workflowId,
      executedAt: nowIso(),
      executor,
      mode,
      input,
      provenance: {
        savedWorkflowId: savedWorkflow.workflowId,
        draftId: savedWorkflow.provenance.draftId,
        rawCaptureId: savedWorkflow.provenance.rawCaptureId,
        rawCaptureChecksum: savedWorkflow.provenance.rawCaptureChecksum
      },
      goal: workflow.goal,
      browserUsePrompt: workflow.browserUsePromptPlaceholder,
      stepResults,
      validation: {
        successCriteria: workflow.successCriteria,
        validationChecks: workflow.validationChecks,
        status: stepResults.every((result) => result.status === 'completed') ? 'passed' : 'failed'
      },
      finalOutput: {
        status: 'validated',
        completedStepCount: stepResults.length,
        expectedOutputs: workflow.expectedOutputs,
        observedOutputs: stepResults.map((result) => result.observedOutput),
        exportedArtifacts
      }
    };

    execution.executionChecksum = await sha256({
      workflowId: execution.workflowId,
      provenance: execution.provenance,
      stepResults: execution.stepResults,
      finalOutput: execution.finalOutput
    });

    await writeJson(path.join(this.executionDir, `${executionId}.json`), execution);
    return execution;
  }

  async getExecution(executionId) {
    return readJson(path.join(this.executionDir, `${executionId}.json`));
  }
}

async function getPlaywright() {
  playwrightModulePromise ??= import('playwright');
  return playwrightModulePromise;
}

async function createBrowserSession({ baseUrl, workflowId, executionId, input }) {
  const { chromium } = await getPlaywright();
  let browser;

  try {
    browser = await chromium.launch({ headless: true });
  } catch (error) {
    throw new Error(`Real Browser Use runtime requires a Playwright Chromium browser: ${error instanceof Error ? error.message : String(error)}`);
  }

  const context = await browser.newContext({ baseURL: baseUrl });
  await context.addInitScript(({ runtimeContext }) => {
    window.__workflowRuntime = runtimeContext;
  }, {
    runtimeContext: {
      workflowId,
      executionId,
      input
    }
  });

  const page = await context.newPage();
  return { browser, context, page };
}

function normalizeBaseUrl(value) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('input.baseUrl must be a non-empty string for live workflow execution');
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(value);
  } catch {
    throw new Error('input.baseUrl must be a valid absolute URL for live workflow execution');
  }

  if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
    throw new Error('input.baseUrl must use http or https');
  }

  if (!isAllowedRuntimeHost(parsedUrl.hostname)) {
    throw new Error('input.baseUrl host is not allowed for live workflow execution');
  }

  parsedUrl.pathname = '';
  parsedUrl.search = '';
  parsedUrl.hash = '';

  return parsedUrl.toString().endsWith('/') ? parsedUrl.toString().slice(0, -1) : parsedUrl.toString();
}

async function executeWorkflowStep({ step, baseUrl, executionId, workflowId, input, store, browserSession }) {
  if (step.target.startsWith('/')) {
    const url = buildAllowedRuntimeUrl(step.target, baseUrl).toString();
    const response = await browserSession.page.goto(url, { waitUntil: 'domcontentloaded' });
    const body = await browserSession.page.textContent('body');
    const validationPassed = Boolean(response?.ok()) && bodyIncludesValidation(body ?? '', step.validationCheck, step.expectedOutput);

    return {
      stepNumber: step.stepNumber,
      action: step.action,
      target: step.target,
      expectedOutput: step.expectedOutput,
      status: validationPassed ? 'completed' : 'failed',
      validationCheck: step.validationCheck,
      observedOutput: summarizeObservedOutput(body ?? '', step.expectedOutput),
      executedAt: nowIso(),
      runtimeRequest: {
        method: 'BROWSER_GOTO',
        url,
        statusCode: response?.status() ?? null
      },
      browserEvidence: {
        currentUrl: browserSession.page.url(),
        mode: 'playwright-chromium-headless'
      }
    };
  }

  if (step.target.startsWith('#')) {
    const dashboardUrl = buildAllowedRuntimeUrl('/dashboard', baseUrl).toString();
    if (!browserSession.page.url().startsWith(dashboardUrl)) {
      await browserSession.page.goto(dashboardUrl, { waitUntil: 'domcontentloaded' });
    }

    await browserSession.page.waitForSelector(step.target, { state: 'visible' });
    await browserSession.page.click(step.target);
    await browserSession.page.waitForSelector('#export-toast[data-export-status="validated"]', { state: 'attached' });

    const outputArtifact = await browserSession.page.locator('#export-toast').evaluate((element) => ({
      outputId: element.getAttribute('data-output-id'),
      status: element.getAttribute('data-export-status'),
      statusCode: Number(element.getAttribute('data-export-status-code') || '0'),
      readbackPath: element.getAttribute('data-readback-path')
    }));
    const validationText = await browserSession.page.textContent('#export-toast');
    const validationPassed = outputArtifact.status === 'validated'
      && typeof outputArtifact.outputId === 'string'
      && bodyIncludesValidation(validationText ?? '', step.validationCheck, step.expectedOutput)
      && outputMatchesExpectation(validationText ?? '', step.expectedOutput);

    return {
      stepNumber: step.stepNumber,
      action: step.action,
      target: step.target,
      expectedOutput: step.expectedOutput,
      status: validationPassed ? 'completed' : 'failed',
      validationCheck: step.validationCheck,
      observedOutput: validationText ?? outputArtifact.status ?? 'runtime export attempted',
      executedAt: nowIso(),
      runtimeRequest: {
        method: 'BROWSER_CLICK',
        url: dashboardUrl,
        statusCode: outputArtifact.statusCode
      },
      browserEvidence: {
        currentUrl: browserSession.page.url(),
        selector: step.target,
        mode: 'playwright-chromium-headless'
      },
      outputArtifact: {
        outputId: outputArtifact.outputId,
        path: path.join(store.runtimeOutputDir, `${outputArtifact.outputId}.json`),
        status: outputArtifact.status,
        readbackPath: outputArtifact.readbackPath
      }
    };
  }

  throw new Error(`Unsupported workflow step target: ${step.target}`);
}

function buildAllowedRuntimeUrl(targetPath, baseUrl) {
  const base = new URL(baseUrl);
  const resolved = new URL(targetPath, `${baseUrl}/`);

  if (resolved.origin !== base.origin) {
    throw new Error(`Resolved runtime URL leaves approved origin: ${resolved.toString()}`);
  }

  return resolved;
}

function isAllowedRuntimeHost(hostname) {
  const normalizedHost = hostname.toLowerCase();
  const canonicalHost = normalizedHost.startsWith('[') && normalizedHost.endsWith(']')
    ? normalizedHost.slice(1, -1)
    : normalizedHost;

  return canonicalHost === '127.0.0.1' || canonicalHost === 'localhost' || canonicalHost === '::1';
}

function bodyIncludesValidation(body, validationCheck, expectedOutput) {
  const checks = [validationCheck, expectedOutput]
    .filter((value) => typeof value === 'string' && value.trim())
    .map((value) => value.toLowerCase());
  const loweredBody = body.toLowerCase();
  return checks.some((value) => loweredBody.includes(value.toLowerCase())) || checks.length === 0;
}

function outputMatchesExpectation(observedOutput, expectedOutput) {
  if (typeof observedOutput !== 'string' || !observedOutput.trim()) {
    return false;
  }

  if (typeof expectedOutput !== 'string' || !expectedOutput.trim()) {
    return true;
  }

  const loweredObserved = observedOutput.toLowerCase();
  const loweredExpected = expectedOutput.toLowerCase();

  return loweredObserved.includes(loweredExpected)
    || (loweredExpected.includes('export') && loweredObserved.includes('export') && loweredObserved.includes('appear'));
}

function summarizeObservedOutput(body, expectedOutput) {
  if (typeof expectedOutput === 'string' && expectedOutput && body.includes(expectedOutput)) {
    return expectedOutput;
  }
  return body.replace(/\s+/g, ' ').trim().slice(0, 160);
}

async function buildExtensionPackage({ workflowId, workflow, sourceDraft }) {
  const manifest = {
    manifest_version: 3,
    name: `${workflow.title} Browser Extension`,
    version: '0.1.0',
    description: workflow.goal,
    action: {
      default_title: workflow.title,
      default_popup: 'popup.html'
    },
    permissions: ['storage'],
    host_permissions: ['http://127.0.0.1/*', 'http://localhost/*', 'http://[::1]/*']
  };

  const workflowSummary = {
    workflowId,
    goal: workflow.goal,
    successCriteria: workflow.successCriteria,
    steps: workflow.steps,
    provenance: {
      draftId: sourceDraft.draftId,
      rawCaptureId: sourceDraft.provenance.rawCaptureId,
      rawCaptureChecksum: sourceDraft.provenance.rawCaptureChecksum
    }
  };

  return {
    packageId: `extension_${workflowId}`,
    generatedAt: nowIso(),
    manifest,
    files: {
      'manifest.json': JSON.stringify(manifest, null, 2),
      'popup.html': renderExtensionPopupHtml(workflow.title),
      'popup.js': renderExtensionPopupScript(workflowSummary),
      'workflow.json': JSON.stringify(workflowSummary, null, 2)
    },
    entrypoints: {
      popup: 'popup.html',
      workflow: 'workflow.json'
    }
  };
}

async function writeExtensionPackage(extensionRootDir, workflowId, extensionPackage) {
  const packageDir = path.join(extensionRootDir, workflowId);
  await mkdir(packageDir, { recursive: true });
  await Promise.all(Object.entries(extensionPackage.files).map(([fileName, contents]) => writeFile(path.join(packageDir, fileName), contents)));
}

function renderExtensionPopupHtml(title) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${escapeHtmlForExtension(title)}</title>
</head>
<body>
  <h1 id="workflow-title">${escapeHtmlForExtension(title)}</h1>
  <pre id="workflow-output">Loading workflow package…</pre>
  <script src="popup.js"></script>
</body>
</html>`;
}

function renderExtensionPopupScript(workflowSummary) {
  return `const workflowPackage = ${JSON.stringify(workflowSummary, null, 2)};
document.getElementById('workflow-output').textContent = JSON.stringify(workflowPackage, null, 2);`;
}

function escapeHtmlForExtension(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
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
  return { rawCaptureId, sourcePath, value, derivationMethod };
}

async function writeJson(filePath, value) {
  await writeFile(filePath, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

async function readJson(filePath) {
  const content = await readFile(filePath, 'utf8');
  return JSON.parse(content);
}
