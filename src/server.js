import http from 'node:http';
import { mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WorkflowStore } from './workflow-store.js';

const dataRoot = process.env.WORKFLOW_DATA_DIR || path.join(process.cwd(), '.runtime-artifacts');
await mkdir(dataRoot, { recursive: true });
const store = new WorkflowStore(dataRoot);
await store.init();

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
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/health') {
      return json(res, 200, { ok: true, dataRoot, hostname: os.hostname() });
    }

    if (req.method === 'POST' && req.url === '/captures') {
      const body = await readBody(req);
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
    json(res, 500, { error: error instanceof Error ? error.message : String(error) });
  }
});

const port = Number(process.env.PORT || 3000);
server.listen(port, '127.0.0.1', () => {
  console.log(`AgentBrowser workflow seam listening on http://127.0.0.1:${port}`);
});
