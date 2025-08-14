# 🎨 Material 3 & UX Standards

### Material 3 Design System (Non-Negotiable)
- **Spacing**: Use the 4px/8px grid system consistently.
- **Colors**: Use semantic theme tokens from the MUI theme; do not use hardcoded color values. This is critical for light/dark theme support.
- **Border Radius**: Adhere to the defined scale (e.g., small: 4px, medium: 12px, large: 16px+).
- **Typography**: Use the defined Material 3 typography scale.
- **Component States**: All interactive components must have clear `hover`, `focus`, `disabled`, and `active` states.

### Component Usage Guidelines
- **Primary Actions**: Use a `FilledButton` for the single, most important action on a surface (e.g., 'Start Recording').
- **Secondary Actions**: Use an `OutlinedButton` or `TextButton` for less prominent actions.
- **Blocking Dialogs**: Use a `Dialog` for urgent, blocking actions that require a user decision (e.g., confirming deletion). Use a `Bottom Sheet` for supplemental content or a list of options.

### Adaptive Layouts (Responsive Design)
- **Compact Screens (<600dp):** The application should use a `BottomNavigationBar` for primary navigation to ensure easy reachability.
- **Medium & Expanded Screens (>600dp):** The layout should shift to use a `NavigationRail` (side navigation) to make better use of the horizontal space and present a more desktop-like experience.

### User Experience Standards
- **Auto-Save**: All settings must persist automatically. Do not create manual "Save" buttons.
- **Clear Status**: The UI must provide unambiguous feedback about recording status and data integrity.
- **Minimalism**: The UI should be non-intrusive to allow researchers to focus on participants.
- **Action Feedback**: Provide clear and immediate feedback for user actions. Use subtle, non-blocking notifications (e.g., a toast) for success states and clear, actionable messages for errors.
- **Meaningful Motion**: Use motion and transitions purposefully to guide the user's attention, adhering to Material 3 motion principles. Animations should be smooth and professional, **implemented using our standard library, Framer Motion.**
- **Accessibility**: Ensure WCAG compliance with proper ARIA labels and keyboard navigation. 