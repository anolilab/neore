# Agent host architecture: how the parts connect

Status: diagram, 2026-10-26. Derived from the plans in this folder; it adds no
decisions. Index: [agent-host-roadmap.md](agent-host-roadmap.md).

## 1. Diagram

```mermaid
flowchart LR
    subgraph Users
        U["Person at the desktop"]
        P["Person on the phone"]
        B["Person in a browser"]
        OA["Outside agent<br/>(MCP client, scoped key)"]
    end

    subgraph Desktop ["Desktop app (Electron)"]
        LW["Local window<br/>consent, local approvals"]
        PAGE["Web app in the shell<br/>relay only"]
        MAIN["Main process<br/>ACP host, HostTransport"]
        CORE["device-core-node<br/>Rust verifier, sandbox"]
        AGT["ACP agent processes<br/>(own login, own tools)"]
    end

    subgraph Remote ["SSH host (optional)"]
        NH["neore-host<br/>stdio only, no secret"]
        RAG["Agents on the host"]
    end

    subgraph Cloud ["Backend: Cloudflare Worker, per-user shards"]
        API["cRPC queries, mutations, live"]
        DEV["devices<br/>signed calls, pending queue"]
        ING["acp ingest (HTTP action)<br/>device-signed, claim-once"]
        SR["shardRoutes<br/>device:id to owner shard"]
        TURN["Host turns<br/>persistent streams"]
        SUB["sub-agents<br/>workers, runs"]
        TW["agent/table-writes<br/>messages, activeAgent"]
        MCP["public-api and /mcp<br/>scoped keys"]
        Q["Jobs queue"]
        STORE["R2 storage<br/>uploads, signed URLs"]
        PROJ["projects, tasks"]
    end

    GW["LLM gateway<br/>cloud models, utility summary"]
    GH["GitHub<br/>PRs, merge (new scope)"]
    REG["ACP registry<br/>queried by desktop"]

    %% Desktop side
    U --> LW
    LW --> MAIN
    MAIN -->|"stdio JSON-RPC"| AGT
    MAIN -->|"approved actions only"| CORE
    MAIN -->|"SSH stdio pipe"| NH
    NH --> RAG
    MAIN -->|"registry lookup"| REG

    %% Page relay
    B --> API
    PAGE <-->|"claim and complete device calls"| DEV
    DEV -->|"pending call"| PAGE
    PAGE -->|"device IPC"| MAIN
    MAIN -->|"file bytes, device-signed create, TUS"| STORE

    %% Device-signed output path (separate from the page)
    MAIN ==>|"turn output, capability report<br/>device-signed, direct"| ING
    ING --> SR --> TURN --> TW

    %% Phone
    P -->|"queries, mutations, live"| API
    P -->|"send, approve, cancel"| DEV
    P -->|"merge after confirm"| API
    API --> PROJ

    %% Cloud agents and workers
    API --> SUB
    SUB -->|"cloud run"| Q
    Q --> GW
    SUB -->|"host worker dispatch"| DEV
    SUB --> TW

    %% Outside agents
    OA -->|"reads; writes to cloud threads only"| MCP
    MCP --> TW

    %% External writes
    TW -->|"merge, PR"| GH
    STORE -->|"signed URL"| P
    STORE -->|"signed URL"| B

    classDef trust fill:#fff4e5,stroke:#b26a00
    class ING,DEV trust
```

Orange nodes are the trust boundary: device-signed traffic from the desktop, and
the pending-call queue that the page relays.

## 2. What each connection carries

| From | To | Carries | Plan |
| --- | --- | --- | --- |
| Local window | Main process | consent, local permission answers | [acp-agent-host.md](acp-agent-host.md) §3 |
| Web page (shell) | Backend | pending device calls claimed, results completed | [acp-agent-host.md](acp-agent-host.md) §4 |
| Main process | ACP agent | JSON-RPC over stdio; the agent runs its own tools | [acp-agent-host.md](acp-agent-host.md) §3 |
| Main process | Backend ingest | turn chunks, turn end, capability report; device-signed | [acp-agent-host.md](acp-agent-host.md) §4 |
| Ingest | Thread owner's shard | routed by the `device:<id>` row in `shardRoutes` | [acp-agent-host.md](acp-agent-host.md) §4 |
| Main process | SSH host | approved actions only, over stdio; no secret on the host | [ssh-environments.md](ssh-environments.md) §1 |
| Phone | Backend | queries, live status, send, cancel, approve, merge, create project | [mobile-acp-and-remote-control.md](mobile-acp-and-remote-control.md) §3 |
| Outside agent | MCP endpoint | reads; writes only to cloud threads | [outside-agent-mcp.md](outside-agent-mcp.md) §3 |
| Lead thread | Worker | dispatch with a receipt; cloud run or device call | [agent-orchestrator.md](agent-orchestrator.md) §4 |
| Backend | LLM gateway | cloud model turns, utility summaries for handoffs | [harness-switch.md](harness-switch.md) §3 |
| Backend | GitHub | PR creation today, merge after the new scope | [mobile-acp-and-remote-control.md](mobile-acp-and-remote-control.md) §3.7 |
| Main process | R2 storage | file bytes, device-signed create, then TUS | [mobile-acp-and-remote-control.md](mobile-acp-and-remote-control.md) §3.8 |

## 3. Three rules the diagram depends on

- **Commands and output take different paths.** A command goes through the
  backend and the page relay to the desktop. Output goes straight from the main
  process to the backend. A running turn therefore does not depend on the page
  being alive.
- **Authority stays on the desktop.** Remote clients and outside agents can ask. Only
  the desktop's verifier and local approval decide, and an SSH host only receives
  what the desktop already approved.
- **Nothing runs on the backend except cloud agents.** Host turns, host workers and
  all agent processes run on the desktop or on an SSH host. The backend stores,
  routes and relays them.
