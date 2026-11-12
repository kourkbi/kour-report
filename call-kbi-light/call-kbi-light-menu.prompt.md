---
name: "Create a Call KBI Light-style userscript"
description: "Create or adapt a lightweight Tampermonkey userscript with the Call KBI Light glass-red launcher, modal, room-link detection, Turnstile verification, and KBI API submission."
argument-hint: "Describe the target site, menu text, and any behavior or visual changes."
agent: "agent"
---

# Task

Create or adapt a small, auditable browser userscript for a Kour.io room-level KBI call. Use [the current Call KBI Light script](./call-kbi-light.js) as the visual and behavioral reference. Keep the requested result self-contained in one `.user.js` file unless the user specifically asks for another structure.

The user may provide additional requirements after invoking this prompt. Apply them without silently removing the behavior below. If a requested change conflicts with the API contract, validation, verification, privacy, or reliable state handling, explain the conflict and ask before weakening those protections.

# Deliverable and implementation style

- Produce a working Tampermonkey-compatible userscript, not just a design mockup.
- Keep it lightweight and readable: avoid frameworks, dependencies, excessive animation, unnecessary abstractions, and minification. Prefer compact markup/CSS while preserving clearly named functions for meaningful logic.
- Add concise section comments that explain installation, UI isolation, room validation, Turnstile, API submission, and event handling.
- Preserve error visibility. Log unexpected operational failures with a useful prefix and show an appropriate status in the menu; do not silently pretend a request succeeded.
- Do not add credentials, private tokens, or secrets. The Cloudflare Turnstile sitekey below is a public client-side sitekey, not a secret.
- Do not invent API fields or claim that a real request was tested unless it was actually tested. Validate the output with a JavaScript syntax check and any applicable focused tests.

# Tampermonkey userscript structure

Include a standard metadata block at the top, adapting the script name/version/description as appropriate:

```js
// ==UserScript==
// @name         Call KBI Light
// @namespace    https://kour.io/
// @version      1.0.2
// @description  Lightweight KBI call requests for Kour.io.
// @author       kourkbi
// @license      MIT
// @match        *://kour.io/*
// @match        *://*.kour.io/*
// @run-at       document-idle
// @grant        unsafeWindow
// ==/UserScript==
```

- Wrap implementation in an immediately invoked function and use strict mode.
- Prevent duplicate installation by assigning a stable ID to the host element and returning if it already exists.
- Run at `document-idle`; still handle the unlikely case where `document.body` is not available yet by mounting on `DOMContentLoaded`.
- Use `unsafeWindow` when available to access the page's Turnstile global, with `window` as fallback. Do not assume every userscript manager exposes `unsafeWindow` identically.
- Prefer standard browser APIs. The design uses Shadow DOM and modern JavaScript syntax (optional chaining, async/await, template literals); do not claim support for outdated browsers that lack these features. Test in the intended userscript manager/browser when possible.
- Cross-origin API requests may depend on the API's CORS and credential policies. Keep the documented `credentials: "include"` request behavior, and surface network/CORS errors instead of masking them.

# Visual design and menu behavior

Build a simple, low-motion menu visually close to Call KBI Light:

- Add a fixed launcher at the right edge, vertically centered, approximately `64 × 64 px`, with rounded left corners, a red background (`#b92b32`), subtle shadow, white telephone line icon, and the label `Call KBI`. Keep the launcher compact; do not add distracting animation.
- The launcher opens a centered modal overlay. Also support the `Alt` key as a toggle only when the room input is not focused, ignoring key repeats; prevent the browser default only for this shortcut. `Escape`, the close button, and clicking the backdrop close the modal.
- Use a dark translucent overlay and a red-tinted glass card (roughly `475 px` maximum width), rounded corners, subtle border/shadow, and `backdrop-filter` with the `-webkit-backdrop-filter` fallback. Keep a readable fallback background if blur is unsupported.
- The heading is `Call KBI`; do not add a subtitle above it. Include a short explanation, a labeled room URL input, a reserved Turnstile container, a glass-like `Continue` submit button with a small telephone icon, a glass-like close button, and an accessible live status message.
- Use restrained typography similar to Verdana/Arial, readable contrast, responsive width, and a height that can scroll on small screens. Preserve visible keyboard focus and disabled-button state.
- Put the host in a **closed Shadow DOM** so Kour.io page styles are less likely to affect the menu. Query UI elements from the shadow root, not from the page document.
- Reuse the text-field keyboard shield pattern from `../kour-report.js` (`reportTextFieldFocused` / `shieldReportTextFieldKeys`): track the room input's `focus` and `blur`, then register `keydown`, `keyup`, and `keypress` capture listeners on `window` that call `stopImmediatePropagation()` while that field is focused, except for `Escape`. Do not call `preventDefault()` for text-entry keys; native typing and editing must continue to work. Let `Escape` reach the menu's keyboard handler so it can close the dialog.
- When the room input receives `pointerdown`, blur `document.activeElement` if it is an `HTMLCanvasElement`, then focus the input, following the same reference pattern. This prevents the game canvas from retaining keyboard focus.
- Stop pointer/mouse, touch, wheel, click, and other relevant menu events from bubbling out to page-level gameplay handlers without blocking the menu's own handlers or native control behavior. Use the event's `composedPath()` to identify the closed-shadow host; do not rely only on `event.target`. Do not suppress events originating outside the menu.
- Ensure clicking, focusing, typing in, or editing the room URL input never triggers the game's controls or gameplay actions. A bubble-phase host guard alone is insufficient for keyboard isolation because page capture handlers may run before it.
- Use inline SVG for the telephone icon; do not fetch icon fonts or add external UI libraries.
- Use semantic buttons, a form, a label associated with the input, dialog labeling, and `role="status"`/`aria-live="polite"` for status.

# Room-link detection and form state

- When the current page URL has a non-empty fragment/hash, treat the current page URL as the automatically detected room link. This is the room ID source used by the reference script.
- Automatically fill the room-link input when opening the menu and when the page emits `hashchange`. If the page leaves a room and the input still contains the previous automatic value, clear it.
- Track whether the user edited the room link manually so ordinary synchronization does not overwrite that manual value. When opening the menu while a room hash exists, refresh from the current room URL.
- On closing/reopening, clear stale visible verification/status state and invalidate outstanding verification callbacks so an old callback cannot update a newly opened menu. Do not clear an in-flight network request's pending lock simply because the modal closed.
- When the room hash changes while verification is in progress, cancel/invalidate that verification, refresh the automatic room link, and ask the user to verify again.
- Do not leave a stale CAPTCHA widget, old status, or disabled submit button after a failed/expired verification or modal reset.
- Keep separate state for the automatic link, whether the current value is manually edited, current verification flow ID, Turnstile loading promise/widget, verification-in-progress state, and request-pending state as needed for reliable behavior.

# Input validation and identity

- Use `new URL(...)` inside a `try/catch` to parse the input.
- Accept only `http:` or `https:` URLs whose hostname is exactly `kour.io` or ends with `.kour.io`.
- Reject username/password URL credentials and links without a non-empty room ID in the hash.
- Trim whitespace before parsing and use the normalized URL when sending the request.
- Read the reporter nickname from `localStorage.getItem("playerNickname")` if available; remove markup-like tags and trim it. If absent or unavailable, use `"Not detected"`. Catch storage access errors, log a warning, and continue with the fallback.
- Do not add player detection or select a specific player. This is a room-level call only.

# Turnstile verification

Load Cloudflare Turnstile only when the user submits a valid room link. Do not load it during initial page setup.

```text
Script URL: https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit
Public sitekey: 0x4AAAAAAFh9F7Gz7tkh9rAD
```

- Reuse a single promise while the external script is loading; reset the cached promise after load failure so a later attempt can retry.
- Prefer `page.turnstile` (where `page` is `unsafeWindow` with a `window` fallback) and verify that `render` exists before using it.
- Render explicitly into the menu's CAPTCHA container with the public sitekey and dark theme.
- Provide success, error, and expiry callbacks. On success, remove the widget, stop verification state, and submit exactly once with the returned token. On error/expiry, remove the widget, restore the submit button when no request is pending, and show a useful retry message.
- Remove existing widgets safely when resetting or retrying. If widget removal itself fails, log a warning rather than silently swallowing it.
- Use a monotonically increasing flow ID (or equivalent cancellation guard) so callbacks from previous attempts cannot alter current UI state.

# KBI API contract

Submit to the existing endpoint:

```text
POST https://kour-report-api.kourkbi.workers.dev/api/report
Content-Type: application/json
credentials: include
```

Send a JSON body with the Turnstile token and the room-level payload:

```json
{
  "turnstileToken": "<Turnstile callback token>",
  "reporter": "<saved playerNickname, or Not detected>",
  "target": "No player selected",
  "reason": "This user is calling KBI",
  "roomId": "<room ID from URL hash>",
  "sessionLink": "<normalized validated Kour room URL>"
}
```

- Do not send until Turnstile supplies a token.
- Disable duplicate submissions while verifying or sending.
- Read the response body as text, then attempt JSON parsing so non-JSON API errors remain diagnosable.
- Consider the request successful only when all documented success conditions match:
  - HTTP status `201`
  - `result.code === "KOUR_REPORT_API_REPORT_SUBMITTED"`
  - `result.success !== false`
  - `result.message === "Report submitted successfully."`
- On confirmed success, show `KBI request sent successfully.`, reset the form, and refresh the automatically detected room link.
- On an API rejection, show a bounded response message (do not inject response text as HTML). On fetch/network errors, log the error and show an error status.
- Always restore pending/disabled state in a `finally` block without overriding a newer verification flow's state.

# Accessibility, privacy, and compatibility requirements

- Never put user-provided text or API response text into `innerHTML`; use input values and `textContent`.
- Keep validation and user-visible errors explicit. Do not bypass CAPTCHA, forge tokens, or treat a failed/unavailable verification as success.
- Avoid collecting or sending data beyond the fields in the documented payload.
- Preserve keyboard usability, semantic labels, focus visibility, and readable status updates.
- Use CSS fallbacks for unsupported blur effects. Do not promise identical appearance across browsers/userscript managers.
- Do not claim that cross-origin submission will work in every manager: it depends on the manager's execution context and the API's CORS/cookie configuration. Report actual limitations found during testing.

# Completion checklist

Before finishing, confirm:

1. The userscript metadata has the intended name, Kour.io match patterns, run-at mode, and only the grants it needs.
2. The launcher, modal, glass-red styling, telephone icons, and requested controls are present.
3. Focus tracking and the `window` capture-phase keyboard shield prevent game controls from receiving room-input keys without preventing native text entry; `Escape` still closes the menu.
4. Pointer/mouse, touch, and wheel interactions do not reach the game, while menu controls and form behavior remain intact.
5. Automatic/manual room-link behavior, validation, reset, and hash-change handling match the requirements.
6. Turnstile is lazy-loaded with the exact public sitekey and errors/expiry are handled.
7. The payload and strict API-success checks match the contract above.
8. No stale async callback can update a different menu/verification flow.
9. JavaScript syntax validation passes. State clearly if real Tampermonkey/browser/API testing was not performed.
