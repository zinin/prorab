# prorab

Autonomous software development — from idea to working code.

> **Early Development (v0.1.0)** — API and behavior may change.

## What is prorab

prorab is a tool for autonomous software development. You describe an idea, discuss it with AI, and the system handles the rest — from requirements to working code.

The full pipeline runs through brainstorming, PRD generation, task decomposition, autonomous code execution, and cross-model code review. Every stage goes through validation and refinement. It's slow and expensive, but thorough.

- **Web UI** (`prorab serve`) — manage the entire pipeline from a browser
- **Multi-agent** — Claude, OpenCode, CCS, Codex — different models for different stages
- **Cross-model code review** — multiple AI models review the same changes independently

## How it works

```
Idea → Brainstorm → PRD → Refine PRD → Parse tasks → Refine tasks →
→ Complexity analysis → Expand subtasks → Execute → Code review → Done
```

| Stage | What happens |
|-------|-------------|
| **Brainstorm** | Discuss the idea with AI — clarifying questions, approach selection |
| **PRD** | Generate a Product Requirements Document |
| **Refine PRD** | Iterative improvement through a chain of agents/models |
| **Parse tasks** | Break PRD into structured tasks ([Task Master](https://github.com/eyaltoledano/claude-task-master) format) |
| **Refine tasks** | Validate tasks against PRD, fix gaps and contradictions |
| **Complexity + Expand** | Assess complexity, decompose into subtasks (up to 10 parallel agents) |
| **Execute** | Autonomous execution of each task via agent session with auto-commit |
| **Code review** | Cross-model review, rework on findings |

Everything is managed from the web UI (`prorab serve`).

## Inspiration

prorab combines ideas from several open-source projects into a unified autonomous development workflow.

### [Task Master](https://github.com/eyaltoledano/claude-task-master)

AI-driven task management: PRD parsing, task decomposition, complexity analysis, `tasks.json` format.

prorab adopted the `tasks.json` format and the concepts of expand and complexity analysis. Extended with in-process I/O (no CLI dependency), autonomous execution, parallel batch expand (up to 10 concurrent agents), and web UI.

### [prd-taskmaster](https://github.com/anombyte93/prd-taskmaster)

Claude Code skill for generating PRDs through a guided interview and creating tasks via Task Master.

prorab borrowed the "idea → questions → PRD → tasks" pipeline. Extended with multi-agent refine chains (PRD and tasks refined through sequential agent sessions), all in-process.

### [ralph-tui](https://github.com/subsy/ralph-tui)

CLI/TUI orchestrator for autonomous task execution by AI agents with multi-agent plugin support.

prorab borrowed the autonomous execution loop (pick task → agent → detect completion → next task) and the Strategy pattern for agents. Extended with a review pipeline (review → rework → closed), auto-commits, markdown reports, and web UI.

### [superpowers](https://github.com/obra/superpowers)

Composable skills for code agents: brainstorming, design specs, implementation plans, TDD workflow.

prorab integrated superpowers skills for the design-first workflow (brainstorming ideas into PRDs). Extended by automating the full cycle without manual intervention and adding multi-agent refine chains.

### Cross-model code review

An original addition: multiple AI models review the same code changes independently, catching issues that a single model might miss. Configurable with different agent/model combinations per review round.

## Features

- Full pipeline: idea → working code
- Web UI for managing the entire process
- Multi-agent support: Claude, OpenCode, CCS, Codex
- Cross-model code review with multiple agents
- Parallel batch expand (up to 10 concurrent agents)
- Auto-commit + markdown reports per task
- Task Master format compatibility (`.taskmaster/tasks/tasks.json`)

## Prerequisites

- **Node.js** 24+
- At least one agent backend configured:
  - **Claude**: Claude Code subscription or `ANTHROPIC_API_KEY`
  - **OpenCode**: any provider supported by OpenCode
  - **CCS** ([Claude Code Switch](https://github.com/kaitranntt/ccs)): any provider supported by CCS (GLM, Ollama, LiteLLM, etc.)
  - **Codex**: `OPENAI_API_KEY`

## Installation

```bash
git clone https://github.com/zinin/prorab.git
cd prorab
npm install
npm run build
npm link   # makes `prorab` available globally
```

## Usage

### `prorab serve`

```bash
prorab serve [--port <number>] [--open]
```

Starts the web UI where you manage the full pipeline — from idea brainstorming to task execution and code review. Open your browser at the displayed URL.

### `prorab run` (CLI mode)

CLI mode was the original interface during early development. It executes tasks autonomously from the command line without the web UI. This mode may be deprecated in future versions.

```bash
prorab run [options]
```

Key options:

| Option | Description |
|--------|-------------|
| `--agent <type>` | Agent backend: `claude`, `opencode`, `ccs`, `codex` |
| `--model <model>` | Model for the agent |
| `--no-review` | Disable code review |
| `--reviewer <spec...>` | Additional reviewers as `agent:model[:variant]` |

Run `prorab run --help` for the full list of options.

## Development

```bash
npm run build        # compile TypeScript + build Vue frontend
npm run build:server # compile TypeScript only
npm run build:ui     # build Vue frontend only
npm run dev          # watch mode (server)
npm run dev:ui       # Vite dev server for frontend
npm test             # run all tests (vitest)
```

## License

[AGPL-3.0-or-later](LICENSE)
