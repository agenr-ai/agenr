# Agenr Strategic Pivot

**Version:** 1.0  
**Date:** February 14, 2026  
**Authors:** Jim Martin, EJA  
**Status:** Active

---

## Executive Summary

Agenr pivots from "the trust and commerce layer between AI agents and businesses" to an **open-source MCP gateway with progressive disclosure** — solving the #1 pain point in the AI agent ecosystem: context bloat.

Instead of competing with trillion-dollar incumbents on agent commerce (Stripe/OpenAI's ACP, Google/Shopify's UCP), Agenr addresses a problem nobody has solved at the right layer: MCP servers dumping 50K+ tokens of tool schemas into agent context before the agent says hello.

---

## Why We're Pivoting

### What Happened

Agenr launched February 13, 2026 as a protocol for agent-to-business interactions — adapters, confirmation flows, and credential management. One day later, we discovered:

- **ACP (Agentic Commerce Protocol)** — Stripe + OpenAI, launched September 2025. Agent checkout protocol, already live in ChatGPT with Shopify and Etsy merchants.
- **UCP (Universal Commerce Protocol)** — Google + Shopify + Walmart + Target + 20 partners, launched January 2026. Broader agent-to-merchant standard.

Both are open standards backed by trillion-dollar companies doing exactly what Agenr set out to do for commerce. Competing here is not viable.

### The Lesson

Our competitive research was flawed. We researched the technical landscape (APIs, MCP, protocols) but not the business landscape (who's already solving this, with what funding, for whom). See [Research Process Improvements](#research-process-improvements) below.

---

## The New Direction

### The Problem: MCP Context Bloat

MCP servers dump their entire tool schemas into agent context upfront. The math is brutal:

| Setup | Token Cost |
|-------|-----------|
| 1 MCP server | 5K–15K tokens |
| 4–5 MCP servers | 50K+ tokens |
| Before the agent says hello | Already over budget |

Everyone is hacking around this. Nobody has solved it at the right layer:

- **Claude Code** added experimental tool hiding (46.9% reduction, fragile)
- **MCP SEP-1576, SEP-1888** propose progressive disclosure in the spec (not shipped, filed since Sept 2025)
- **The New Stack** published "10 strategies" for context management (workarounds, not solutions)
- **Lazy Tool Protocol** claims 93% reduction (requires custom client support)

### The Solution: Agenr as MCP Gateway

Instead of agents connecting to 10 MCP servers directly (50K tokens), they connect to **Agenr**, which exposes 2–3 meta tools at ~500 tokens total:

1. **`discover`** — Lightweight search across all connected services
2. **`query`** — Read data from a specific service (safe, no side effects)
3. **`execute`** — Perform actions with confirmation flow (writes, purchases, mutations)

Agenr proxies calls to underlying MCP servers on demand. The agent never sees the full schema of any backend server.

**Result:** ~500 tokens instead of 50K+, regardless of how many services sit behind the gateway.

---

## Positioning

| | Before | After |
|--|--------|-------|
| **Tagline** | "Trust layer for agent commerce" | "Context-efficient gateway for agent-to-world interaction" |
| **Primary integration** | Custom SDK | MCP proxy |
| **Distribution** | npm packages | OpenClaw skill + MCP server |
| **Business model** | SaaS | Open source |
| **Target user** | Business owners | Agent developers |

---

## Architecture

### What We Keep (~60% Reuse)

The existing Agenr codebase maps directly to the new direction:

- **Adapter runtime** — Dynamically loads and executes adapters (unchanged)
- **Discovery pattern** — Lightweight manifest → detailed hints on demand (this *is* progressive disclosure)
- **Query/Execute split** — Read vs. write operations (unchanged)
- **Confirmation flow** — `pending_confirmation` pattern for dangerous actions (unchanged)
- **Adapter generation engine** — Point at API docs, generate an adapter (unchanged)
- **Console UI** — Adapted for the new use case
- **Domino's adapter** — Great demo of wrapping a raw API into a lean adapter

### What's New

- **MCP proxy layer** — Connect to existing MCP servers, proxy their tools through Agenr's meta-tool interface
- **MCP server interface** — Agenr itself appears as a standard MCP server to any client
- **Tool indexing** — Lightweight index of all available tools across all connected servers, enabling fast discovery without full schema loading

---

## The Key Refinement: Replace, Don't Proxy

Agenr doesn't just PROXY MCP servers — it **REPLACES** them.

### The Two Problems with MCP

**Problem 1 — Context bloat (tokens):** MCP tool schemas eat agent context windows. 50K+ tokens from a few servers. Progressive disclosure solves this.

**Problem 2 — Runtime overhead (CPU/memory):** MCP servers are heavy background processes. The Atlassian MCP (Jira/Confluence) runs a JVM or Node process that indexes data, keeps connections open, and burns CPU. Real-world example: Jim has to manually load/unload the Atlassian MCP because it makes his MacBook fans spin up. This is a widespread problem.

A proxy layer only solves Problem 1. The MCP server still needs to be running underneath.

### The Solution: Replace, Don't Proxy

Most MCP servers are just wrappers around REST APIs. The Atlassian MCP calls Jira's REST API. The GitHub MCP calls GitHub's REST API. The MCP server process is unnecessary overhead.

Agenr adapters call REST APIs directly via `fetch()`. No background daemon. No resident process. No fan noise. The Domino's adapter already proves this — a single `.ts` file making `fetch()` calls on demand.

### Three-Tier Approach

| Tier | Strategy | When | Example |
|------|----------|------|---------|
| **Tier 1 — Replace** | Write lean Agenr adapters that call REST APIs directly | Services with good REST APIs (most of them) | Atlassian, GitHub, Google Workspace |
| **Tier 2 — Lifecycle management** | Agenr manages MCP server lifecycle (start when needed, stop when done) | MCP servers that can't be replaced (complex local state, streaming) | Local database tools |
| **Tier 3 — Proxy** | Agenr proxies long-running MCP servers with progressive disclosure | MCP servers that need to stay running (real-time data, event subscriptions) | Real-time monitoring tools |

### Why This Matters

This turns Agenr from "a smarter way to connect to MCP servers" into "a **replacement** for MCP servers that's lighter, leaner, and more context-efficient."

| | Before Agenr | After Agenr |
|--|-------------|-------------|
| **Background processes** | 8 MCP server processes running | 0 |
| **System impact** | Fans spinning, CPU/memory burned | Silent, on-demand only |
| **Context cost** | 50K tokens | ~500 tokens |
| **API calls** | Routed through MCP daemon | Direct via `fetch()`, on demand |

### Dogfood Use Case

Jim's Atlassian MCP pain point is the first real-world test. If Agenr can replace the Atlassian MCP with a lean adapter that doesn't destroy his MacBook, that's a demo that sells itself to every developer struggling with the same problem.

---

## Dogfood / First Adapters

Planned adapters, in priority order:

1. **Atlassian (Jira + Confluence)** — Jim's daily pain point, first dogfood target
2. **Domino's Pizza** — Already built, proves the raw API adapter pattern
3. **GitHub** — Huge developer audience, great REST API
4. **Google Workspace (Calendar, Gmail, Drive)** — Universal productivity

---

## Differentiation from OpenClaw Skills

This is a critical distinction:

| | OpenClaw Skills | Agenr Gateway |
|--|----------------|---------------|
| **Mechanism** | Markdown instructions injected into prompt | Runtime proxy between agent and services |
| **Effect on context** | **Adds** ~500 tokens per skill | **Replaces** 50K+ tokens with ~500 total |
| **What it does** | Tells agents *how* to use tools | Replaces 50 tool definitions with 3, proxies the rest on demand |
| **Layer** | Prompt-level | Protocol-level |

Skills and Agenr are complementary, not competing. An OpenClaw skill can instruct agents on how to use the Agenr gateway effectively.

---

## Why Not Just Fix MCP?

1. **Architectural mismatch** — MCP's `tools/list` returns everything. Progressive disclosure requires spec changes to both servers *and* clients.
2. **Governance speed** — The spec is Anthropic-governed and moves deliberately. SEP proposals from September 2025 still aren't shipped.
3. **Migration burden** — Even if the spec adds progressive disclosure, every existing MCP server remains bloated. The entire ecosystem would need to migrate.
4. **Client-side hacks are fragile** — Claude Code's experimental tool search helps but isn't a protocol solution.
5. **Agenr works today** — No changes needed to existing MCP servers. No migration. Drop it in and context shrinks immediately.

---

## Competitive Landscape

| Player | What It Is | Relationship to Agenr |
|--------|-----------|----------------------|
| **ACP** (Stripe + OpenAI) | Agent checkout protocol | Different layer — Agenr doesn't do commerce |
| **UCP** (Google + Shopify) | Agent-to-merchant protocol | Different layer — Agenr doesn't do commerce |
| **Lazy Tool Protocol** | Open-source context reduction | Requires custom client support; Agenr works with any MCP client |
| **Claude Code tool search** | Client-side experimental flag | Single-client hack; Agenr is client-agnostic |
| **MCP SEP-1576/1888** | Spec proposals for progressive disclosure | Not shipped; Agenr solves it now without spec changes |

**Agenr's position:** Not competing with any of these. Works *with* MCP as a proxy. Doesn't compete with ACP/UCP (entirely different layer).

---

## Distribution Strategy

### 1. OpenClaw Skill (Primary)

Published on ClaHub for first-class OpenClaw integration. Rides OpenClaw's momentum.

> *"I had 8 MCP servers connected. 45K tokens gone before my agent said hello. Installed the Agenr skill, now it's 600 tokens and everything still works."*

### 2. Standard MCP Server

Works with Claude Code, Cursor, Windsurf, and any MCP client. No OpenClaw dependency required.

### 3. Standalone Proxy

Can run as a service for custom integrations and non-MCP environments.

---

## Open Source Strategy

Build in the open. No SaaS, no platform lock-in.

**The value proposition:**
- The progressive disclosure pattern and reference implementation
- The adapter generation engine (point at docs, get a lean adapter)
- A growing library of community-contributed adapters
- A runtime anyone can embed

**Revenue is not the goal.** The goal is building something genuinely useful that rides the AI agent wave and establishes Jim's reputation in the ecosystem.

---

## Research Process Improvements

The competitive research failure that triggered this pivot taught us a better process:

1. **Before writing code on a new idea**, spend a full day on competitive research. Not "does a library exist" but "is a well-funded company already doing this?"
2. **Follow the money, not the tech.** Read Stripe's blog, OpenAI's partnerships page, Google's developer blog.
3. **Set up monitoring.** Weekly scan of major AI announcements.
4. **The "why not" exercise:** Ask "Why hasn't Stripe/Google/Amazon already done this?" If the answer is "they have" — pivot immediately.

---

## Next Steps

1. Implement MCP proxy layer (connect to existing MCP servers)
2. Implement MCP server interface (Agenr as an MCP server)
3. Build tool indexing for fast discovery
4. Publish OpenClaw skill on ClaHub
5. Write getting-started guide with concrete before/after token measurements
6. Ship the Domino's adapter as the reference demo

---

*This document captures the strategic pivot discussed on February 14, 2026. It is a living document and will be updated as the implementation progresses.*
