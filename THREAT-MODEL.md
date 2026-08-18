# Threat Model — Secure Print Agent

**Document Version:** 1.0.0  
**Scope:** `universal-print-agent` core service, CLI, SDK, and printer drivers.

---

## 1. Trust Boundaries & Assets

### Trust Boundaries
1. **Client / Browser Boundary:** Untrusted web applications, browser extensions, local processes, and external network callers.
2. **Agent Gateway Boundary:** Security enforcement layer handling authentication, CORS, rate limiting, and request validation.
3. **OS / Hardware Boundary:** Underlying operating system APIs (WinSpool, `/dev/usb/lp*`), filesystem, and physical USB printers.

### Protected Assets
- Physical printer hardware and print consumables (labels, thermal paper).
- Printed sensitive data (customer PII, receipts, invoice data, access tokens).
- Store counter PC system integrity (filesystem, process execution).
- Local authentication credentials and encryption keys.

---

## 2. Threat Analysis (OWASP API Top 10 & CWE Mapping)

| Threat ID | Threat Category | Relevant CWE / OWASP | Description | Mitigation Strategy |
|---|---|---|---|---|
| **THREAT-01** | Arbitrary Device Path Access | CWE-22 (Path Traversal)<br>CWE-73 (External Control of File Name) | Malicious caller supplies arbitrary `devicePath` (`/dev/sda` or `/etc/shadow`) or Windows printer queue to alter system state or corrupt hardware. | Server-side printer registry (`printerId` mapping only). Clients never submit device paths or printer names. |
| **THREAT-02** | Localhost Unauthenticated Print (CSRF / Rebinding) | OWASP API1:2023 (Broken Object Level Authorization)<br>CWE-306 (Missing Authentication) | Web pages loaded in store counter PC browser issue cross-origin requests to `http://127.0.0.1:9200/print`. | Require local loopback bearer token / signed HMAC token on all endpoints. Enforce exact origin CORS allowlists. |
| **THREAT-03** | Command & Script Injection | CWE-78 (OS Command Injection) | Payload or printer name string crafted to inject shell commands into PowerShell or subshell invocation. | Use `execFile` with argument arrays instead of shell strings, strict parameter escaping, and server-side allowlists. |
| **THREAT-04** | Malicious TSPL Payload / Printer Destruction | CWE-20 (Improper Input Validation) | Malicious TSPL payload containing firmware flashing or network configuration commands (e.g. `FLASH`, `SET IP`). | Implement strict TSPL command parser/validator allowlisting formatting commands only in standard mode. |
| **THREAT-05** | Sensitive Data Leakage in Logs | OWASP API3:2023 (Broken Object Property Level Authorization) | Logging full print payloads containing customer names, payment details, or invoice data to disk. | Payload redaction in logs (hash-only or length-only logging). Tokens and auth headers stripped from logger. |
| **THREAT-06** | Denial of Service (Queue Flood / Payload Bomb) | OWASP API4:2023 (Unrestricted Resource Consumption) | Malicious/buggy client sends gigabyte payload or thousands of rapid print jobs, locking up counter PC. | Enforce strict payload caps (256 KB), job depth limits (50 max queue), and rate limits (120 req/min). |
| **THREAT-07** | Replay & Duplicate Print Attacks | OWASP API8:2023 (Security Misconfiguration) | Network packet capture or duplicate HTTP POST re-printing invoices multiple times. | Mandatory `Idempotency-Key` header with deduplication cache and short token validity windows. |

---

## 3. Residual Risks & Non-Goals

1. **Physical Security:** If an attacker has physical access to the counter PC or USB cable, hardware-level physical attacks cannot be mitigated by software alone.
2. **Compromised OS Kernel / Root Access:** If malware has root/administrator privileges on the counter PC, it can intercept raw USB writes at the kernel level.
3. **Exact-Once Printing Guarantee:** Physical printers do not support transactional acknowledgements; hardware paper jams or power loss during physical printing can result in partial prints. System guarantees **at-least-once** job submission to the print queue.
