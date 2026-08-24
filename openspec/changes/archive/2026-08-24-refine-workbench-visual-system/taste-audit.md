# Taste audit: workbench visual directions

## Audit frame

**Design read:** local OpenSpec desktop workbench for developers and technical leads, with a quiet operational language, using native HTML/CSS, restrained motion, and explicit semantic status.

This audit uses `design-taste-frontend` from `Leonxlnx/taste-skill` at revision `843c8dd4d18ccff0d5a9cd4b0b71d7dbf7278293`. The installed skill explicitly excludes dashboards and dense product UI, so it is a secondary redesign guardrail rather than the product design system. OpenSpec requirements, existing security boundaries, the deterministic fixture, and direct screenshot review remain authoritative.

The explorations use the same three proposals, six-task active change, documents, controls, themes, and responsive rules. The screenshot matrix contains 36 captures: two directions, three pages, three viewports, and two themes.

## Direction settings

| Direction | Variance | Motion | Density | Intended use |
| --- | ---: | ---: | ---: | --- |
| Balanced | 3 | 2 | 7 | Clear first understanding with efficient daily use |
| Dense | 3 | 2 | 9 | Maximum repeated scanning and more rows above the fold |

Both directions deliberately reject the Taste default `8 / 6 / 4` because this is a predictable execution tool, not a marketing or portfolio surface.

## Findings

### Balanced density

- **Hierarchy:** Strongest first-read order. Project, page purpose, current task, and precise progress remain distinct without competing cards.
- **Typography:** 14px interface copy and larger supporting line height preserve Chinese readability. Machine IDs and exact numbers remain secondary.
- **Spacing:** 72px proposal rows and 44px task rows make state comparison easy, but the four-part summary consumes more vertical space than necessary at 1440px.
- **Density:** All three proposals fit in the wide first viewport. At 820px the layout converges to the same compact single-column behavior as the dense direction.
- **Template risk:** The equal four-part metric strip is familiar dashboard grammar. It is acceptable because every segment is actionable, but should remain unboxed and subordinate to the proposal list.

### High density

- **Hierarchy:** The page title and proposal list remain understandable, but condensed summary labels and inline metadata compete more strongly.
- **Typography:** 54px proposal rows are still readable at the tested content length. Long project names truncate earlier because the sidebar is only 190px.
- **Spacing:** More content is visible above the fold and repeated scanning is faster. The tighter detail rows reduce separation between completed and current work.
- **Density:** Best for experienced users with many proposals. It gives little benefit at 820px because both directions must use the same minimum-window hierarchy.
- **Template risk:** Fewer boxes and tighter dividers avoid generic card grids, but the resulting surface can resemble an undifferentiated admin table if status and current-task emphasis are weakened.

## Accepted guidance

- Keep a targeted-evolution redesign: preserve information architecture, route labels, keyboard paths, CSP, preload API, and read-only behavior.
- Use one interaction accent for focus and selection. Reserve additional colors exclusively for real semantic states.
- Use borders and negative space for structural grouping; use raised surfaces only for dialogs or a genuine focus layer.
- Keep one small-radius rule for application controls and rows. Do not mix pill-heavy controls with square operational surfaces.
- Remove repeated uppercase eyebrows and decorative micro-labels. Use direct Chinese page and section titles.
- Keep motion at level 2: hover, focus, refresh feedback, and state transitions only. No GSAP or perpetual animation.
- Preserve explicit light/dark theme parity and use off-black rather than pure black.
- Use monospace only for machine IDs, task numbers, timestamps, and exact numeric progress.
- Keep 820px collapse explicit: icon navigation rail, single-column main path, and locally scrolling tables/code.
- Remove filled backgrounds behind machine IDs in repeated list rows unless the fill communicates selection.

## Rejected guidance

- **React, Tailwind, or a new component system:** rejected because the existing native renderer is small, secure, and already has local tokens and accessible controls. Migration would expand runtime and CSP risk without solving the identified hierarchy problem.
- **Replacing Lucide:** rejected because Lucide is already vendored, consistent, and covered by the current CSP. A second icon family would create churn.
- **Fluent, Carbon, Atlassian, or Primer:** rejected for this change. Their density patterns are useful references, but adopting a full external system would conflict with the no-framework migration boundary.
- **Single semantic color for the whole interface:** rejected for operational state. Focus remains blue, while warning, progress, and ready states retain distinct accessible colors plus text/icon labels.
- **GSAP, Motion, magnetic controls, or scroll effects:** rejected because they do not communicate meaningful state in a local execution workbench.
- **Hero, marketing imagery, logo-wall, and landing-page composition rules:** not applicable to a desktop operational tool.
- **Replacing long task lists with marketing cards or carousels:** rejected because the ordered task list is the product data and must remain directly scannable.

## Selection recommendation

Choose **Balanced density** as the product baseline, then borrow only the dense direction's compact proposal-row metadata alignment. It wins initial comprehension, document reading, accessibility margin, and task-state separation; the dense direction wins only repeated wide-screen scanning and creates earlier truncation risk.

## Implementation re-review

The implemented Electron renderer was re-reviewed against the same pinned Taste revision after the final responsive and accessibility pass.

- The product still reads as a quiet operational tool at `3 / 2 / 7`; no marketing hero, decorative imagery, glass, gradient, marquee, scroll effect, or oversized display type was introduced.
- The confirmed hierarchy is preserved in light and dark themes: project and page purpose, semantic state, exact progress, current task, ordered tasks, then secondary context.
- The renderer uses one interaction accent plus explicit success, warning, and danger semantics. Every state also has text or an icon.
- The app uses a single small-radius rule, border and whitespace grouping, raised surfaces only for the dialog and current-task focus, and no nested decorative cards.
- Platform fonts and existing vendored Lucide icons remain in place. No remote asset, framework, component system, or animation dependency was added.
- Motion remains limited to `120ms` and `180ms` state feedback; reduced motion disables animation and transition. GSAP remains out of scope.
- Mechanical checks found no visible em dash, en dash separator, pure black/white token, unrestricted `transition: all`, gradient, or scroll listener in application renderer sources.

### Ponytail review/lite

Ponytail was evaluated from the official repository at revision `2ed6c52c9d7e5e56942508591085fd45dea277d3`. It was not installed globally because the Codex plugin requires a restart and trusted lifecycle hooks. The official `ponytail-review` skill and lite rule were read from a temporary checkout and applied as a scoped complexity review.

- `styles.css: legacy overview rules`: `delete:` removed unused lane, card, status-dot, kicker, and hidden metric-icon rules. Nothing replaces them.
- `styles.css: legacy breakpoints`: `delete:` removed the superseded `1180`, `900`, `680`, and `390` media blocks. The confirmed `960` and `1280` layout states replace them.
- `app.js: metricButton`: `shrink:` removed six hidden or constant arguments and the unused icon markup. The three visible metric values remain.
- `tests: proposal selectors`: `shrink:` use the actual `.control-table-row` contract instead of retaining a legacy `.change-card` alias.

`net: -165 CSS lines plus legacy renderer markup applied.`

Rejected Ponytail cuts: visual regression, deterministic fixtures, accessibility assertions, trust-boundary sanitization, path validation, keyboard coverage, and read-only IPC checks are explicit delivery and safety requirements, so they are not complexity candidates.
