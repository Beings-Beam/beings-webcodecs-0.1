# Project Blueprint: Beings Recorder v1.0 — Execution Ready

*   **Status**: `WIP`
*   **Owner**: `Duy Truong (Delivery Manager)`
*   **Last Updated**: `8 Aug 2025`
*   **Kickoff**: `Mon, 11 Aug 2025`
*   **TL;DR**: `11 weeks to GA + 1-week contingency; client-centric Dual-Track architecture; hard SLOs and CI budgets; stage-gated weekly cuts.`

---

## 1. Executive Summary

This document outlines the execution plan for Beings Recorder v1.0, the platform’s primary ingestion layer for qualitative research. We will ship a client-centric **Dual-Track architecture**:

*   **Fast Track (Live)**: A low-latency conversational experience using a P2P connection for 1:1 calls (via STUNner) and a mediasoup SFU for group calls (3+ participants).
*   **Slow Track (Archival)**: A local, high-fidelity, client-encrypted media pipeline that ensures frame-accurate source assets, with resumable uploads managed via a chunked manifest.

Our delivery is accelerated via parallel workstreams and focused execution, with a target GA date of **Early November 2025**.

### Out of Scope for v1.0

*   Native mobile applications (iOS/Android)
*   Live AI features (e.g., real-time transcription or analysis)
*   In-app post-production or editing tools

---

## 2. Architectural Principles (Non-Negotiable)

1.  **Client-centric**: Capture, encode, and encrypt on the user’s device. The cloud orchestrates and stores only ciphertext.
2.  **Two tracks, one experience**: The live experience remains responsive and low-latency, while the archival track remains perfect and complete.
3.  **P2P first, SFU for scale**: Use peer-to-peer for optimal 1:1 call quality; reliably scale to 3+ participants with a lightweight SFU.
4.  **Offline-first & resumable**: Buffer all captured data in IndexedDB and use `tus` for chunked, resumable uploads with integrity checks.
5.  **Progressive enhancement**: Default to modern APIs like WebCodecs and Document Picture-in-Picture where available, with graceful fallbacks to MediaRecorder and windowed mode.
6.  **Observable by default**: Implement comprehensive Real User Monitoring (RUM) and OpenTelemetry (OTel) events from day one.

---

## 3. Support Matrix & SLO Snapshot

| Category                 | Target                                                                                             |
| :----------------------- | :------------------------------------------------------------------------------------------------- |
| **Browsers**             | Chrome, Edge, Firefox (latest-2 on Win/macOS); Safari (latest-2 on macOS)                          |
| **Connectivity SLOs**    | 1:1 P2P success ≥ 98%; STUNner relay fallback ≤ 3s p95; SFU join ≥ 99%                               |
| **CI Performance Budgets** | Audio-only: CPU p95 < 15%, Mem p95 < 200MB. 1080p30 Video: CPU p95 < 35%, Mem p95 < 600MB.           |
| **Security Invariants**  | Client-side AES-GCM encryption; per-session keys wrapped by KMS; per-chunk IVs. Server stores ciphertext only. |

---

## 4. Delivery Plan (11 Weeks + 1 Week Buffer)

### **Phase 0 — Foundation & Consolidation (1 week: 11 Aug – 15 Aug)** 🏗️

*   **Mission**: De-risk dependencies, consolidate repositories, and stand up the core infrastructure to provide a clean and stable foundation for the team.

*   **Deliverables**:
    1.  **Repository Consolidation**:
        *   **`audio-record-repo-dev`**: Logic and WASM assets migrated into `beings-recorder` at `packages/recorder-core`. Original repo archived.
        *   **`beam`**: `server-api`, auth, and DB models isolated on a `v1.0` branch. Legacy `server-mixer` and old `mediasoup` signaling logic formally deprecated and removed from v1.0 deployment plans.
        *   **`beings-infra`**: Becomes the single source of truth for IaC. All critical Helm charts and configs from `beam_ops` and `beam_deployments` are merged. Original repos archived.
        *   **Mobile Repos**: `beam-android`, `mobile-android`, and `beam-ios` are formally archived.
    2.  **Infrastructure & Pipeline**:
        *   **STUNner** gateway deployed and health dashboards live.
        *   **`tus`** upload skeleton (`OPTIONS`/`HEAD`) implemented in the `beam` `server-api`.
        *   Database schema for sessions, recordings, and manifests is finalized.
        *   The **WAV→encrypt(AES-GCM)→chunk→manifest** pipeline is validated with a dry-run upload, including checksum verification.

*   **Stage Gate — SG-0 (Exit Criteria)**:
    *   STUNner allocation success rate ≥ 98%.
    *   `tus` skeleton endpoint is verified and reachable.
    *   The archival pipeline passes all CRC32C and SHA-256 integrity checks.

### **Phase 1 — Core Product (5 weeks: 18 Aug – 19 Sep)** 🚀

*   **Mission**: Ship a stable audio and video recorder for both free (P2P) and paid (SFU) tiers through iterative, shippable weekly cuts.

*   **Weekly Cuts**:
    *   **W1 (18–22 Aug) — Audio P2P + E2EE**:
        *   Deliverables: Fast Track audio (P2P via STUNner) and the Slow Track WAV PCM capture engine with a Relative Monotonic Timebase. Manifest v1.0 created.
        *   Acceptance: Audio success ≥ 98%; drift ≤ ±20 ms/h; server stores ciphertext only.
    *   **W2 (25–29 Aug) — Video Slow Track**:
        *   Deliverables: WebCodecs primary path and MediaRecorder fallback. Video quality panel added to dev-test-suite (fps, dropped frames, CPU/mem).
        *   Acceptance: 30-min 1080p30 recording completes with dropped frames < 2% and performance budgets green.
    *   **W3 (1–5 Sep) — SFU Bring-up + Handover**:
        *   Deliverables: `mediasoup` deployed to staging with signaling APIs. Automatic P2P → SFU handover logic implemented when participants ≥ 3.
        *   Acceptance: SFU join ≥ 99%; handover completes in < 5s p95.
    *   **W4 (8–12 Sep) — Widget & WYSIWYG**:
        *   Deliverables: Resizable/movable floating widget. IndexedDB quota management and background tab throttling mitigations (DPiP/windowed).
        *   Acceptance: All accessibility basics met; throttling tests pass.
    *   **W5 (15–19 Sep) — Soak & Perf**:
        *   Deliverables: 60-minute 1080p30 soak tests across the full support matrix. Bug burn-down week.

*   **Stage Gate — SG-1 (Exit Criteria)**:
    *   Audio success ≥ 98% p50 / 95% p95; drift ≤ ±20 ms/h.
    *   All performance budgets are green.
    *   P2P success ≥ 98% with relay fallback ≤ 3s p95.
    *   P2P→SFU handover is stable at < 5s p95 in staging.

### **Phase 2 — Premium Features (2 weeks: 22 Sep – 3 Oct)** 💎

*   **Mission**: Implement screen capture, Document Picture-in-Picture, and the FLAC audio enhancement.

*   **Stage Gate — SG-2 (Exit Criteria)**:
    *   60-minute mixed capture (camera + screen) is stable across the matrix.
    *   DPiP and its windowed fallback are verified across all supported browsers.
    *   The FLAC encoding path meets all performance budgets without frame loss.

### **Phase 3 — Hardening & Security (3 weeks: 6 Oct – 24 Oct)** 🛡️

*   **Mission**: Achieve two consecutive weeks of green SLOs across the entire platform and gain full security sign-off for GA.

*   **Stage Gate — SG-3 (Exit Criteria)**:
    *   All defined SLOs are green for two consecutive weeks in the staging environment.
    *   Third-party penetration test is complete with no Critical or High severity findings open.

### **Contingency Buffer (1 week: 27 Oct – 31 Oct)** ⏳

*   This week is reserved for addressing critical issues or delays from the pen-test.
*   The final Go/No-Go decision for the GA release is **Friday, 31 Oct 2025**.

---

## 5. Governance & Cadence

*   **Daily Standups**: 9:00 AM daily to sync progress and blockers.
*   **Weekly Demos**: Friday afternoons to showcase work from the current week's cut.
*   **Stage Gate Reviews**: Held at the end of each phase, requiring sign-off from all leads to proceed.

---

## 6. Owners

| Role      | Name           | Responsibilities                                                               |
| :-------- | :------------- | :----------------------------------------------------------------------------- |
| Delivery  | Duy Truong     | Stage gates, SLOs, demos, release cadence                                      |
| Backend   | Anh Tran       | `server-api`, DB, `tus`, storage, STUNner/`mediasoup` signaling                |
| Frontend  | Tien Tran      | Floating widget, XState, capability detection, `/dev-test-suite`, telemetry    |
| Media     | Trung Nguyen   | Slow-Track engine (WASM), WebCodecs/MediaRecorder, Timebase, manifest          |
| Support   | Security Lead  | DPIA, pen test coordination                                                    |
