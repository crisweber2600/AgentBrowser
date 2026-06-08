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

export async function createServer({ dataRoot = process.env.WORKFLOW_DATA_DIR || path.join(process.cwd(), '.runtime-artifacts') } = {}) {
  await mkdir(dataRoot, { recursive: true });
  const store = new WorkflowStore(dataRoot);
  await store.init();

  const server = http.createServer(async (req, res) => {
    try {
      if (req.method === 'GET' && req.url === '/health') {
        return json(res, 200, { ok: true, dataRoot, hostname: os.hostname() });
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
            draftPath: path.join(dataRoot, 'generated-drafts', `${draft.draftId}.json`)
          }
        });
      }

      if (req.method === 'GET' && req.url?.startsWith('/drafts/')) {
        const draftId = req.url.split('/').at(-1);
        return json(res, 200, await store.getDraft(draftId));
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
