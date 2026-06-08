# AgentBrowser Phase 1 Workflow Artifact Seam

This repository contains a minimal workflow seam that covers the Phase 1 artifact path and a Phase 2/3-style execution seam.

It includes an integrated closure-proof path from browser recording through draft/save and into live execution with durable export readback.

## What it does

- accepts a raw browser demonstration payload;
- persists the raw capture separately from generated workflow drafts;
- generates a structured editable workflow package with provenance;
- supports review, edit, and save of workflow versions.
- executes a saved workflow into a durable validation artifact with provenance back to the raw capture.
- proves the integrated continuity path: recording -> raw capture -> draft -> saved workflow -> live execution -> exported artifact.

## Run

```bash
npm start
```

Server defaults to `http://127.0.0.1:3000`.

## Test

```bash
npm test
```
