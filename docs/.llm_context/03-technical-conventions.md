# 💻 Development Standards & Guidelines

### Code Quality Requirements
- **TypeScript**: Use strict mode, no `any`, and write comprehensive interfaces. All component props must have explicit TypeScript interfaces with TSDoc comments.
- **Performance**: Implement resource cleanup patterns for long research sessions to prevent memory leaks. Particular attention to MediaStream cleanup and recording blob disposal.
- **Error Handling**: Use enterprise-grade patterns with comprehensive `try/catch` and user-friendly error messages appropriate for research professionals.
- **Testing**: Follow our testing strategy (Unit for core, RTL for hooks/components, E2E for app flows, Storybook for component documentation).
- **Code Documentation**: Use TSDoc comments (`/** ... */`) for all exported functions, types, and interfaces, especially in the `@beings/core` and `@beings/react` packages. Descriptions should be clear and explain the "why," not just the "what."
- **Animation Library**: We use **Framer Motion** as the standard library for all complex component animations, transitions, and gesture-based interactions.

### UI & Component Standards
- **Design System**: Use Material 3 design system via MUI v6. Follow semantic theming with proper color tokens (`primary.main`, `background.paper`, etc.).
- **Component Architecture**: All UI components must be purely presentational, receiving state via props and communicating changes via callbacks.
- **Accessibility**: Implement ARIA labels, semantic HTML, keyboard navigation, and proper focus management for professional accessibility standards.
- **Responsive Design**: Components should work across different screen sizes while maintaining the professional recording interface integrity.
- **Theme Support**: All components must support both light and dark themes via the `theme` prop.

### Documentation & Storybook Standards
- **Storybook Coverage**: Every UI component must have comprehensive Storybook stories showing all states, variants, and interactions.
- **Story Documentation**: Include detailed descriptions explaining component usage, integration patterns, and developer handoff information.
- **Interactive Examples**: Provide interactive demos that demonstrate the complete component behavior for developer understanding.
- **Props Documentation**: Use Storybook controls to document all component props with proper descriptions and examples.

### Recording & Media Standards (v1.0 Architecture)
- **Encryption**: All "Slow Track" data must be encrypted client-side using **AES-GCM** before upload.
- **Uploads**: Use the **`tus`** protocol for resumable, chunked uploads.
- **Manifest**: A per-recording manifest must be generated, containing per-chunk metadata (`seq`, `t_session_ms`, `dur_ms`, `size`, `sha256`, `crc32c`, `iv`).
- **Audio Quality**: Maintain broadcast-grade audio quality at all costs. Default to **WAV** PCM capture, with **FLAC (WASM)** as a CPU-gated enhancement.
- **MediaStream Management**: Implement proper stream lifecycle management with cleanup on component unmount and error states.
- **Recording State Management**: Implement comprehensive state machines for recording flows: `idle → initializing → recording → saving → success/error`.
- **Permission Handling**: Graceful handling of media device permissions with clear user feedback and fallback states.

### Critical DOs and DON'Ts
- ✅ **DO** follow the "Dual-Track" architecture (Fast Track for live, Slow Track for archival).
- ✅ **DO** encrypt all user media client-side before it leaves the device.
- ✅ **DO** implement comprehensive resource cleanup and error handling.
- ✅ **DO** provide comprehensive Storybook documentation for all UI components.
- ✅ **DO** implement proper accessibility standards (ARIA, keyboard nav, semantic HTML).
- ✅ **DO** use Material 3 design tokens and semantic theming.
- ❌ **DON'T** add framework dependencies to the `@beings/core` package.
- ❌ **DON'T** compromise data integrity for convenience.
- ❌ **DON'T** store any unencrypted user media on the server.
- ❌ **DON'T** skip writing tests for new logic.
- ❌ **DON'T** implement recording functionality without proper MediaStream cleanup and error handling.
