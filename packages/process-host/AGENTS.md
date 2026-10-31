# Process host

Generic Node 24/Bun stdio binding for a host-supplied TurnRunner, Sessions and optional Tasks. The host supplies model/services and creates sessions. No provider configuration or automatic takeover lives here.

Protocol version 1 is schema-defined in process-protocol.entity.ts. Keep fixtures/protocol-1.ndjson decoding forever; a wire incompatibility needs a new protocol version. Projection is the default; full event export is explicit and validates JSON after snapshotting values without prototype hooks. Durable lifecycle frames come from acknowledged logical SessionLog commit rows, never prepared bus events or an Agent return. Observation failure preserves the original successful storage receipt and stops the host.

ProcessPeer lives in src/ports/process-peer.port.ts. Its kit and careless stub checks precede adapters. Input is pull-based with bounded partial/native buffers. Output reserves finite pending writers before encoding and serializes one complete line at a time. Flush covers accepted writes. Never destroy injected native streams on scope disposal.

serveProcess is reusable and scoped; runProcessHost alone owns native signals, hard deadlines and process exit. Default Effect logging goes to stderr, reserving stdout for NDJSON. Hosts keep startup reconciliation and drainer authority explicit and use the same Sessions/Tasks across direct, queued and helper turns.

Entity/functions pairs hold schemas and transitions; adapters hold IO and layers. Follow the root AGENTS.md and relevant skills. This package adds no model-facing text or stored journal fields.
