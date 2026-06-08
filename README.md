# AgentBrowser Phase 1 Workflow Artifact Seam

This repository contains a minimal Phase 1 implementation for the workflow artifact seam.

It now also includes a minimal Phase 2-style execution seam that can execute a saved workflow into a durable validation artifact.

## What it does

- accepts a raw browser demonstration payload;
- persists the raw capture separately from generated workflow drafts;
- generates a structured editable workflow package with provenance;
- supports review, edit, and save of workflow versions.
- executes a saved workflow into a durable validation artifact with provenance back to the raw capture.

## Run

```bash
npm start
```

Server defaults to `http://127.0.0.1:3000`.

## Test

```bash
npm test
```
