# Engineering Hub - The "How"

This document outlines the technical philosophy, principles, and guidelines for the Beings Recorder v1.0 project.

## 🏗️ Technical Philosophy

### Core Principles

1. **Reliability First**: Every component must gracefully handle failure scenarios
2. **Privacy by Design**: User data protection is built into the architecture, not added later
3. **Progressive Enhancement**: Core functionality works offline, enhanced features work online
4. **Developer Experience**: Clear APIs, comprehensive documentation, and intuitive tooling
5. **Maintainability**: Code should be readable, testable, and modifiable by the entire team

### Architecture Philosophy

**"Simple by default, powerful when needed"**

We prioritize straightforward implementations that can be enhanced incrementally rather than complex solutions that try to solve all problems upfront.

## 🏛️ System Architecture

### Client-Centric Architecture Philosophy

The Beings Recorder implements a **client-centric architecture** that rejects traditional server-side processing bottlenecks. This design philosophy is built on the principle: **"Buy the Commodity, Build the Moat"**.

**We Buy**: Best-in-class managed services for standard components (WebRTC STUN/TURN, cloud storage, signaling)
**We Build**: Proprietary IP that creates competitive advantage (dual-track capture, frame-accurate sync, client-side media engine)

### Dual-Track Capture Model

```
┌─────────────────────────────────────────────────────────────────┐
│                    Beings Recorder Client                      │
├─────────────────────────────────────────────────────────────────┤
│  🚀 Fast Track (Live Communication)                            │
│  ├── Low-latency WebRTC streams                               │
│  ├── P2P (1:1) via STUNner                                    │
│  ├── SFU (3+) via mediasoup                                   │
│  └── Real-time collaboration & observation                    │
├─────────────────────────────────────────────────────────────────┤
│  💎 Slow Track (Archival Recording)                           │
│  ├── High-fidelity local recording                            │
│  ├── Client-side encryption (AES-GCM)                         │
│  ├── Frame-accurate time synchronization                      │
│  └── Resumable uploads (TUS protocol)                         │
└─────────────────────────────────────────────────────────────────┘
```

### High-Level System Design

```
┌─────────────────────────────────────────────────────────────────┐
│                 Browser-Based Client                           │
├─────────────────────────────────────────────────────────────────┤
│  🎯 UI Layer: Floating Widget + Document PiP                   │
│  🎙️ Audio: WAV (always) + FLAC (CPU-gated)                    │
│  📹 Video: WebCodecs (primary) + MediaRecorder (fallback)      │
│  🖥️ Screen: getDisplayMedia + system audio                     │
│  🔐 Security: Client-side AES-GCM encryption                   │
│  📊 Telemetry: Comprehensive performance monitoring            │
└─────────────────────────────────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│                   Cloud Infrastructure                         │
├─────────────────────────────────────────────────────────────────┤
│  🌐 STUNner: STUN/TURN for P2P NAT traversal                   │
│  🎛️ mediasoup: SFU for multi-participant sessions              │
│  📤 TUS Endpoints: Resumable upload protocol                   │
│  💾 Cloud Storage: Encrypted asset storage                     │
│  🔑 KMS: Key wrapping and management                           │
└─────────────────────────────────────────────────────────────────┘
```

### Technology Stack

**Client-Side (Browser)**
- **Framework**: React 18 with TypeScript for UI components (framework-agnostic core engine)
- **Build Tool**: Vite for fast development and optimized builds
- **Package Manager**: pnpm for efficient dependency management
- **Media APIs**: WebRTC, WebCodecs, getUserMedia, getDisplayMedia
- **Storage**: IndexedDB for local buffering and offline capability
- **Encryption**: Web Crypto API for AES-GCM encryption (planned)
- **Upload**: TUS protocol for resumable uploads (planned)
- **Video Processing**: Multi-codec support (AV1, HEVC, H.264, VP9) with intelligent fallback
- **Audio Processing**: Multi-format encoding (Opus, AAC, MP3, FLAC) with channel upmixing

**Cloud Infrastructure**
- **Connectivity**: STUNner (STUN/TURN), mediasoup (SFU)
- **Storage**: Google Cloud Storage for encrypted assets
- **Upload Endpoints**: TUS-compliant resumable upload service
- **Key Management**: Cloud KMS for session key wrapping
- **Monitoring**: Comprehensive telemetry and observability stack

**Integration Layer**
- **Platform API**: GraphQL integration with Beings workspace
- **Authentication**: JWT-based with secure session management
- **Metadata**: Asset registration and workspace integration
- **AI Services**: Aida assistant and transcription pipeline

## 🛠️ Development Setup

### Prerequisites
- Node.js 18+ 
- pnpm 8+
- Docker & Docker Compose
- Git

### Quick Start
```bash
# Clone the repository
git clone <repository-url>
cd beings-recorder

# Install dependencies
pnpm install

# Start development environment
pnpm dev

# Run tests
pnpm test

# Build for production
pnpm build
```

### Repository Structure
```
beings-webcodecs-0.1/
├── packages/
│   └── @beings/
│       └── core/     # Framework-agnostic recording engine
│           ├── src/
│           │   ├── SlowTrackRecorder.ts    # Main recorder class
│           │   ├── recorder.worker.ts     # WebCodecs worker
│           │   ├── types.ts               # TypeScript interfaces
│           │   └── index.ts               # Public API exports
│           ├── manual-test.html           # Comprehensive test harness
│           └── package.json               # Dependencies: mp4-muxer, webm-muxer
├── docs/             # Project documentation
└── test-deploy/      # Deployment testing assets
```

### Core Package Dependencies
The `@beings/core` package maintains minimal runtime dependencies:
- **`mp4-muxer` (^4.0.0)**: Professional MP4 container creation for H.264/HEVC codecs
- **`webm-muxer` (^2.0.0)**: WebM container creation for AV1/VP9 codecs

## 🔐 Security & Privacy

### Security by Design Philosophy

The Beings Recorder implements **"Security by Design"** principles, ensuring privacy and data protection are built into the architecture from the ground up, not added as an afterthought.

### Client-Side Encryption (FR-008)

**AES-GCM 256-bit Encryption**
- Per-session key generation using Web Crypto API
- Unique initialization vectors (IV) for each chunk
- Client-side encryption before any data leaves the device
- Server stores only encrypted ciphertext

**Key Management**
- Session keys wrapped by Cloud KMS for recovery scenarios
- Keys never transmitted in plaintext
- Local key storage with secure session management
- Deterministic key derivation for chunk verification

### Data Protection Pipeline

```
Raw Media → AES-GCM Encryption → Chunking → CRC32C/SHA-256 → TUS Upload → Cloud Storage
    ↑              ↑                ↑            ↑              ↑
Local Key    Unique IV per    5-10MB chunks   Integrity    Encrypted
Generation      chunk                         Verification  Storage
```

### Privacy Framework (FR-009)

**Explicit Consent**
- Clear consent gates before any recording begins
- Granular permissions for audio, video, and screen capture
- Participant consent tracking and audit trails
- Revocable consent with immediate effect

**Data Custody & Retention**
- Workspace-level retention policies (default 180 days)
- Legal hold capabilities for compliance requirements
- GDPR/CCPA compliance with data subject access requests (DSAR)
- Secure deletion with cryptographic verification

### Security Implementation Requirements

**Network Security**
- TLS 1.3 for all communication channels
- Certificate pinning for critical endpoints
- CORS policies with explicit origin allowlisting
- Rate limiting and DDoS protection

**Application Security**
- Content Security Policy (CSP) headers
- Subresource Integrity (SRI) for external resources
- Input validation and sanitization
- Dependency vulnerability scanning (automated)

**Operational Security**
- Regular penetration testing (pre-GA requirement)
- Security audit trail for all administrative actions
- Incident response procedures and escalation
- Compliance monitoring and reporting

## 📊 Performance Standards & SLOs

### Service Level Objectives (SLOs)

**Reliability Targets**
- **Recording Success Rate**: ≥98% (p50), ≥95% (p95) across support matrix
- **Upload Completion**: >99% success rate for interrupted uploads
- **Data Integrity**: 100% checksum validation (CRC32C + SHA-256)

**Performance Budgets**
- **Audio Recording**: CPU <15% p95, Memory <200MB p95
- **Video Recording (1080p30)**: CPU <35% p95, Memory <600MB p95, Dropped frames <2% p95
- **Time Synchronization**: Drift ≤±20ms/hour across all tracks
- **Startup Performance**: Pre-flight ready ≤2s, Guest join ≤30s

**Connectivity Standards**
- **P2P Success Rate**: ≥98% connection establishment
- **TURN Relay Fallback**: ≤3s p95 fallback time
- **SFU Join Success**: ≥99% for multi-participant sessions
- **TLS-only Stability**: 720p30 stable for 60min continuous recording

### Browser & Hardware Support Matrix

**Supported Platforms (Latest-2 versions)**
- **Windows**: Chrome, Edge, Firefox
- **macOS**: Chrome, Edge, Firefox, Safari
- **Linux**: Chrome, Firefox (best-effort)

**Hardware Baseline**
- **CPU**: 2020+ 4-core x86_64 or Apple M1+
- **Memory**: 8GB RAM minimum
- **Storage**: 1GB available for local buffering
- **Network**: Broadband with 1Mbps upload minimum

### Quality Assurance Standards

**Audio Quality**
- **Format**: WAV (PCM 48kHz mono) always available
- **Enhancement**: FLAC compression (CPU-gated, paid tier)
- **Latency**: <100ms from capture to local storage
- **Quality**: Lossless capture with no audio dropouts

**Video Quality**
- **Resolution**: Up to 4K with intelligent downscaling (adaptive based on hardware)
- **Codec**: Intelligent 4-tier fallback (AV1 → HEVC → H.264 → VP9) via WebCodecs with hardware acceleration preference
- **Frame Rate**: Stable 30fps with <2% dropped frames (p95), dynamic frame rate support
- **Synchronization**: Frame-accurate alignment with audio tracks
- **Container**: Dynamic MP4/WebM selection based on codec compatibility

## 🧪 Testing Strategy

### Testing Pyramid

**Unit Tests (70%)**
- Pure function testing
- Component isolation testing
- Mock external dependencies
- Target: >90% code coverage

**Integration Tests (20%)**
- API endpoint testing
- Database interaction testing
- Upload pipeline testing
- Cross-package functionality

**End-to-End Tests (10%)**
- Full user workflow testing
- Browser compatibility testing
- Performance regression testing
- Real-world scenario validation

### Testing Tools
- **Unit**: Vitest for fast, modern testing
- **Component**: React Testing Library
- **E2E**: Playwright for cross-browser testing
- **Performance**: Lighthouse CI for automated audits

## 🚀 Deployment & Operations

### Environment Strategy
- **Development**: Local development with hot reloading
- **Staging**: Production-like environment for integration testing
- **Production**: Highly available, monitored deployment

### Deployment Pipeline
1. **Code Review**: All changes require peer review
2. **Automated Testing**: Full test suite must pass
3. **Security Scanning**: Dependency and code security checks
4. **Performance Testing**: Benchmark validation
5. **Gradual Rollout**: Feature flags for controlled releases

### Monitoring & Observability

**Application Metrics**
- Recording success/failure rates
- Upload completion rates
- Performance benchmarks
- Error rates and types

**Infrastructure Metrics**
- Service availability
- Response times
- Resource utilization
- Network performance

**Alerting Strategy**
- Critical: Immediate notification for service outages
- Warning: Daily digest for performance degradation
- Info: Weekly reports for trends and capacity planning

## 📚 Technical Design Documents

For detailed technical specifications, see the [TDD directory](./tdd/):

### Core Architecture
- **[System Architecture Overview](./tdd/system-architecture.md)** - Complete system design and component relationships
- **[Requirements Traceability](./tdd/requirements-traceability.md)** - Mapping between PRD requirements and technical implementation

### Media Processing
- **[Audio Capture & Processing](./tdd/audio-capture.md)** - Multi-codec audio (Opus, AAC, MP3, FLAC) with channel upmixing and sample rate preservation
- **[Video Capture & Processing](./tdd/video-capture.md)** - 4-tier codec fallback (AV1 → HEVC → H.264 → VP9) with intelligent downscaling
- **[Screen Capture Specification](./tdd/screen-capture.md)** - getDisplayMedia and system audio handling

### Connectivity & Networking
- **[WebRTC Implementation](./tdd/webrtc-implementation.md)** - P2P connectivity, STUN/TURN, and SFU integration
- **[Upload Protocol Specification](./tdd/upload-protocol.md)** - TUS resumable uploads and chunk management
- **[Time Synchronization](./tdd/time-synchronization.md)** - Frame-accurate alignment and drift correction

### Security & Privacy
- **[Encryption Specification](./tdd/encryption-spec.md)** - Client-side AES-GCM implementation
- **[Privacy & Consent Framework](./tdd/privacy-consent.md)** - Consent flow and data custody

### User Experience
- **[Widget & UI Specification](./tdd/widget-ui-spec.md)** - Floating widget and Document PiP implementation
- **[Aida Integration](./tdd/aida-integration.md)** - AI assistant features and guidance

### Platform Integration
- **[Workspace Integration](./tdd/workspace-integration.md)** - Beings platform connectivity
- **[Telemetry & Observability](./tdd/telemetry-observability.md)** - Comprehensive monitoring and metrics

## 🤝 Contributing Guidelines

### Code Standards
- **TypeScript**: Strict mode enabled, no `any` types
- **Formatting**: Prettier with team-agreed configuration
- **Linting**: ESLint with custom rules for consistency
- **Documentation**: JSDoc for all public APIs

### Git Workflow
- **Branching**: Feature branches from `main`
- **Commits**: Conventional commit format
- **Pull Requests**: Required for all changes
- **Reviews**: At least one approval required

### Development Practices
- **TDD**: Write tests before implementation when possible
- **Pair Programming**: Encouraged for complex features
- **Code Reviews**: Focus on design, security, and maintainability
- **Documentation**: Update docs with every feature change

## 🎯 Success Metrics & KPIs

### Technical Metrics (Must Meet for GA)
- All NFRs green for 2 consecutive weeks in staging
- Stage-gates SG-1 to SG-3 passed
- Penetration test: No Critical/High severity issues open
- Browser compatibility matrix: 100% core functionality

### Adoption Metrics
- Weekly active recorders
- Session starts and completion rates
- Median session length and quality metrics
- Feature adoption rates (SFU, FLAC, screen capture)

### Satisfaction Metrics
- Capture UX CSAT ≥4.5/5
- Percentage of users reporting "tech anxiety" decreased vs baseline
- Support ticket volume and resolution time
- Developer experience satisfaction (internal teams)

### Business Metrics
- Free-tier usage and engagement
- Conversion to paid tier (SFU/FLAC usage)
- Workspace retention settings adoption
- Platform integration success rate

## 🔄 Release Strategy

### Phase-Based Delivery
1. **Phase 1 (Core MVP)**: Audio WAV + P2P + E2EE + Manifest + Telemetry
2. **Phase 2 (Video & Pro)**: WebCodecs video + SFU + Floating widget
3. **Phase 3 (Premium)**: Screen share + Document PiP + FLAC enhancement
4. **Phase 4 (Hardening)**: Accessibility, security audit, documentation

### Quality Gates
- **SG-1**: Core recording pipeline validated
- **SG-2**: Multi-participant and video features stable
- **SG-3**: Premium features and security hardening complete
- **GA**: Production readiness and business metrics achieved

---

*This engineering hub serves as the technical foundation for all development decisions. It should be referenced for architectural questions and updated as our understanding evolves.*
