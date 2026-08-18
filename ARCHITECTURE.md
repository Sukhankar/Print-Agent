# Architecture Specification — Secure Print Agent

**Package Scope:** `@universal-print-agent/core`  
**Version:** `2.0.0-spec`  
**Status:** Architecture Draft (Phase 0 & 1 Complete)

---

## 1. Executive Summary & Phase 0 Scope Right-Sizing

This document outlines the target architecture for `@jp-pos/print-agent`, transforming the single-file prototype service into a modular, secure, production-grade print agent framework and client SDK.

### Phase 0 Scope Clarifications & Key Assumptions
1. **Deployment Scale:** Single-operator, multi-store retail model (one enterprise operating one or multiple physical store locations). The system is *not* architected as a public multi-tenant SaaS.
   - **Right-sized Decision:** Uses a lightweight signed device token (HMAC/JWT or asymmetric token paired during store onboarding) rather than an enterprise OAuth2 Authorization Server + mTLS PKI setup.
2. **Network Topology:** Primary printing occurs over **localhost / local LAN** from POS counter PCs (90%+ of traffic). Remote printing over WAN is supported via an optional Gateway / Cloudflare Tunnel layer.
   - **Right-sized Decision:** Localhost is treated as an **untrusted network boundary**. All local HTTP/WS print requests require a locally-issued loopback auth token (stored securely via OS credential storage).
3. **Device Enrollment:** Device identity and printer registrations are managed by a server-side registry. The print agent can operate standalone (local pairing token) or pair with a central backend.

---

## 2. Target System Architecture

```
┌─────────────────────────────────────────────────────────┐
│            POS / ERP Frontend Application               │
│             (React, Next.js, Electron, etc.)            │
└────────────────────────────┬────────────────────────────┘
                             │ imports
                             ▼
 ┌───────────────────────────────────────────────────────┐
 │               @jp-pos/print-agent-sdk                 │  ← Client SDK
 └───────────────────────────┬───────────────────────────┘
                             │ Authenticated HTTPS / WSS
                             │ (Bearer Token / HMAC)
                             ▼
┌─────────────────────────────────────────────────────────┐
│                  Print Agent Gateway                    │  ← Security Boundary
│ ┌─────────────────────────────────────────────────────┐ │
│ │ Auth & Token Verification (Local/Remote)            │ │
│ ├─────────────────────────────────────────────────────┤ │
│ │ Printer ID Resolution & Allowlist Enforcement       │ │
│ ├─────────────────────────────────────────────────────┤ │
│ │ Input Validation (Zod) & TSPL Command Sanitizer     │ │
│ ├─────────────────────────────────────────────────────┤ │
│ │ Rate Limiter, Payload Cap & Replay Protection       │ │
│ └──────────────────────────┬──────────────────────────┘ │
└────────────────────────────┼────────────────────────────┘
                             │ Authenticated Local Dispatch
                             ▼
┌─────────────────────────────────────────────────────────┐
│                    Core Job Queue                       │
│  (Per-Printer FIFO Lock, Idempotency, Retry, Persistence)│
└────────────────────────────┬────────────────────────────┘
                             │ Driver Dispatch
                             ▼
┌─────────────────────────────────────────────────────────┐
│                 Printer Driver Layer                    │
│ ┌──────────────────────┬──────────────────────────────┐ │
│ │  TsplPrinterDriver   │     EscPosPrinterDriver      │ │
│ ├──────────────────────┴──────────────────────────────┤ │
│ │  OS Raw Transport (WinSpool RAW / Linux /dev/usb)   │ │
│ └──────────────────────────┬──────────────────────────┘ │
└────────────────────────────┼────────────────────────────┘
                             │ Raw Bytes
                             ▼
                 [ USB Thermal Printer ]
```

---

## 3. Package & Monorepo Structure

```
print-agent/
├── packages/
│   ├── sdk/          # The only public npm package (@jp-pos/print-agent-sdk)
│   ├── core/         # Hardware drivers, job queue, security, validation
│   ├── protocol/     # API schemas, TSPL command allowlists, error codes
│   └── types/        # TypeScript interfaces for printers, jobs, tokens
├── apps/
│   ├── agent/        # Desktop / background daemon (Express / HTTP / WS)
│   ├── cli/          # CLI utility (`print-agent doctor`, `start`, `register`)
│   └── gateway/      # Optional remote proxy layer for multi-site WAN dispatch
├── ARCHITECTURE.md
├── THREAT-MODEL.md
├── MIGRATION.md
└── package.json
```

---

## 4. Security Architecture & Trust Boundaries

### 4.1 Non-Negotiable Principle: Localhost Is Untrusted
Browser processes and local apps running on the counter PC can issue cross-origin requests (`fetch("http://127.0.0.1:9200")`). Therefore:
- **No Unauthenticated Printing:** Every request (including local) must include a valid Authorization token (`Bearer <token>`).
- **Printer ID Resolution:** Clients submit a `printerId` (e.g. `counter_label_01`). The agent resolves `printerId` internally against an administrator-managed registry file/DB (`printers.json` or OS keyring). Raw device paths (`/dev/usb/lp0`) or printer queue names (`TSC TTP-244`) from request bodies are **strictly rejected**.
- **CORS Hardening:** Exact origin allowlisting only; wildcard origins (`*`) and unauthenticated no-Origin pass-throughs are removed.

### 4.2 TSPL Command Sanitization
- **Strict Mode (Default):** Accepts only known-safe formatting commands (`SIZE`, `GAP`, `CLS`, `TEXT`, `BARCODE`, `QRCODE`, `BOX`, `BITMAP`, `PRINT`, `DIRECTION`).
- **Raw Mode:** Requires explicit administrator configuration in `agent.config.json` to allow hardware management commands (`FLASH`, `DOWNLOAD`, `SET COUNTER`, etc.).

---

## 5. Unified Printer Abstraction

All hardware printing is governed by a unified `PrinterDriver` interface:

```typescript
export interface PrinterDriver {
  id: string;
  name: string;
  type: 'tspl' | 'escpos' | 'raw';
  
  discover(): Promise<PrinterInfo[]>;
  validate(payload: Buffer): Promise<boolean>;
  print(job: PrintJob): Promise<PrintResult>;
  getStatus(): Promise<PrinterStatus>;
  close(): Promise<void>;
}
```

### Implementations:
- `TsplPrinterDriver`: Handles TSPL parsing, sanitization, and byte compilation.
- `EscPosPrinterDriver`: Handles ESC/POS receipts and cash drawer triggers.
- `RawPrinterDriver`: Low-level OS transport binder (WinSpool RAW on Windows, `/dev/usb/lp*` / CUPS on POSIX).

---

## 6. Job Queue & Resilience Model

- **Locking:** Dedicated mutex per `printerId` preventing concurrent byte stream collisions.
- **Idempotency:** Accepts an `Idempotency-Key` header; duplicate requests return existing job status without re-printing.
- **Delivery Guarantee:** At-least-once delivery with exponential backoff retries for transient hardware disconnects.
- **Rate Limits:**
  - `MAX_PAYLOAD_SIZE`: 256 KB
  - `MAX_JOBS_PER_MINUTE`: 120 per client
  - `MAX_QUEUE_DEPTH`: 50 pending jobs per printer

---

## 7. Versioned API Surface (`/v1/*`)

| Method | Endpoint | Description | Auth Required |
|---|---|---|---|
| `GET` | `/v1/health` | Service readiness, platform, uptime | No (sanitized) |
| `GET` | `/v1/printers` | List registered printer aliases | Yes |
| `GET` | `/v1/printers/:id` | Get details for registered printer | Yes |
| `POST` | `/v1/printers/register` | Register hardware mapping (Admin) | Yes (Admin) |
| `POST` | `/v1/jobs` | Submit new print job (`printerId`, `data`) | Yes |
| `GET` | `/v1/jobs/:id` | Get status of job | Yes |
| `POST` | `/v1/jobs/:id/cancel` | Cancel pending job | Yes |

---

## 8. Legacy Deprecation & Backward Compatibility

Existing unauthenticated endpoints (`GET /health`, `GET /printers`, `POST /print`) will enter a deprecation cycle:
1. Legacy endpoints require a **loopback token** provisioned on first launch.
2. A `Deprecation: true` header and warning log are emitted on every legacy invocation.
3. Legacy endpoints return `410 Gone` in version 3.0.0.
