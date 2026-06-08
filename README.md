# AgentBrowser Phase 1 Workflow Artifact Seam

This repository contains a minimal Phase 1 implementation for the workflow artifact seam.

## What it does

- accepts a raw browser demonstration payload;
- persists the raw capture separately from generated workflow drafts;
- generates a structured editable workflow package with provenance;
- supports review, edit, and save of workflow versions.

## Run

```bash
npm start
```

Server defaults to `http://127.0.0.1:3000`.

## Test

```bash
npm test
```
