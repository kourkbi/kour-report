<p align="center">
  <img src="./assets/kourkbi-api-documentation.jpg" alt="KourKBI API documentation banner" width="100%">
</p>

<h1 align="center">Kour Report API</h1>

<p align="center">
  <strong>Integration guide for submitting player reports to KBI.</strong>
</p>

> [!IMPORTANT]
> This API is intended for use in the Kour.io context. It is an independent community service and is not affiliated with or endorsed by Kour.io or Legion Platforms.

## Overview

The API accepts JSON report submissions and returns a JSON response with:

- `success` — a compatibility boolean indicating the result.
- `code` — a stable application result code.
- `message` — a readable result message.

The application `code` is separate from the HTTP status. Check `response.status` for the HTTP result and `body.code` for the specific API outcome. CORS `OPTIONS` preflight responses have no body.

## Endpoints

| Method | URL | Description |
| --- | --- | --- |
| `POST` | `https://kour-report-api.kourkbi.workers.dev/api/report` | Submit a report to the KBI staff channel. |
| `POST` | `https://kour-report-api.kourkbi.workers.dev/api/report/test` | Submit a test report to the configured test channel. |

Both endpoints accept the same request body and apply the same validation, Turnstile verification, rate limit, cooldown, and development-mode checks. The test endpoint does not ping staff. Other paths or methods return `404`.

The Worker supports CORS preflight requests with `OPTIONS`. It allows the `GET`, `POST`, and `OPTIONS` methods and the `Content-Type` and `Authorization` request headers. `GET` does not retrieve reports.

## Turnstile verification

Every report submission requires a valid Cloudflare Turnstile token. Load the Turnstile script and render its widget with the public sitekey below:

| Configuration | Value |
| --- | --- |
| Script URL | `https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit` |
| Sitekey | `0x4AAAAAAFh9F7Gz7tkh9rAD` |

The sitekey is used to display the widget; it is **not** the verification token. Obtain the token from the widget callback and send it as `turnstileToken` in the API request. The API verifies that token server-side.

```html
<div id="turnstile-widget"></div>
<script>
  function renderTurnstile() {
    turnstile.render("#turnstile-widget", {
      sitekey: "0x4AAAAAAFh9F7Gz7tkh9rAD",
      callback: (token) => {
        // Send this token as turnstileToken when submitting the report.
      },
    });
  }
</script>
<script
  src="https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit"
  async
  defer
  onload="renderTurnstile()"
></script>
```

## Submit a report

Send a JSON object with the `Content-Type: application/json` header:

```json
{
  "turnstileToken": "TURNSTILE_TOKEN",
  "target": "ReportedPlayer",
  "roomId": "AB12CD",
  "sessionLink": "https://kour.io#AB12CD",
  "reporter": "ReportingPlayer",
  "reason": "Brief description of the reason"
}
```

### Required fields

| Field | Type | Requirements |
| --- | --- | --- |
| `turnstileToken` | `string` | Required, non-empty, no more than 2048 characters, and must pass Turnstile verification. |
| `target` | `string` | Reported player's name; must not be empty after trimming and cannot exceed 1000 characters. |
| `roomId` | `string` | Room ID up to 1000 characters. Must match the serialized URL fragment after `#` in `sessionLink`. |
| `sessionLink` | `string` | URL up to 1000 characters on `kour.io`, `www.kour.io`, or a `kour.io` subdomain. Its fragment must match `roomId`, including percent-encoding. |

The room ID may contain any characters. For example, `https://kour.io#MUSIC3` requires `"roomId": "MUSIC3"`. The URL must be parseable; no particular URL scheme is required.

### Optional fields

| Field | Type | Requirements | Default |
| --- | --- | --- | --- |
| `reporter` | `string` | Maximum 1000 characters. Leading and trailing whitespace is trimmed. | `Anonymous` |
| `reason` | `string` | Maximum 300 characters. Leading and trailing whitespace is trimmed. The current Kour Report client limits the combined reason to 250 characters. | `No reason provided` |

Field names are case-sensitive. If no optional fields are needed, they may be omitted:

```json
{
  "turnstileToken": "TURNSTILE_TOKEN",
  "target": "ReportedPlayer",
  "roomId": "AB12CD",
  "sessionLink": "https://www.kour.io#AB12CD"
}
```

## Responses

### Successful response

Successful submissions return HTTP `201`. A production report includes a seven-digit numeric `reportId`:

```json
{
  "success": true,
  "code": "KOUR_REPORT_API_REPORT_SUBMITTED",
  "message": "Report submitted successfully.",
  "reportId": "1234567"
}
```

The production `reportId` is unique and is stored with the accepted report. The test endpoint also returns a generated seven-digit `reportId`, but it is cosmetic, is not guaranteed to be unique, and is not stored with a report. A simulated success response for a blocked user does not include `reportId`, because no report is created.

A `201` is the API's successful submission response. Discord notification delivery happens asynchronously, so delivery issues do not change this response.

### Error response

Errors use the same JSON envelope. For example:

```json
{
  "success": false,
  "code": "KOUR_REPORT_API_INVALID_JSON",
  "message": "Request body must be valid JSON."
}
```

### Result codes

| Code | HTTP status | Message or meaning |
| --- | ---: | --- |
| `KOUR_REPORT_API_UNDER_DEVELOPMENT` | `503` | The report API is temporarily unavailable while under development. The response includes an invitation to join [the KBI Discord](https://discord.gg/Ke3a7ZZWMd). |
| `KOUR_REPORT_API_RATE_LIMITED` | `429` | `Rate limit exceeded.` |
| `KOUR_REPORT_API_REPORT_COOLDOWN` | `429` | `Please wait before submitting another report.` Includes the `Retry-After` header. |
| `KOUR_REPORT_API_INVALID_JSON` | `400` | `Request body must be valid JSON.` |
| `KOUR_REPORT_API_INVALID_PAYLOAD` | `400` | `Request body must be a JSON object.` |
| `KOUR_REPORT_API_TURNSTILE_TOKEN_MISSING` | `400` | `A Turnstile token is required.` |
| `KOUR_REPORT_API_INVALID_TURNSTILE_TOKEN` | `400` | `Invalid Turnstile token.` |
| `KOUR_REPORT_API_REQUIRED_FIELDS_MISSING` | `400` | `Missing required report fields.` |
| `KOUR_REPORT_API_INVALID_ROOM_ID` | `400` | `Room ID cannot exceed 1000 characters.` |
| `KOUR_REPORT_API_ROOM_ID_MISMATCH` | `400` | `Room ID does not match the session link.` |
| `KOUR_REPORT_API_INVALID_TARGET_NAME` | `400` | `Target name must be between 1 and 1000 characters.` |
| `KOUR_REPORT_API_INVALID_REPORTER_NAME` | `400` | `Reporter name must be a string.` |
| `KOUR_REPORT_API_REPORTER_NAME_TOO_LONG` | `400` | `Reporter name cannot exceed 1000 characters.` |
| `KOUR_REPORT_API_INVALID_REASON` | `400` | `Reason must be a string.` |
| `KOUR_REPORT_API_REASON_TOO_LONG` | `400` | `Reason cannot exceed 300 characters.` |
| `KOUR_REPORT_API_INVALID_SESSION_LINK_DOMAIN` | `400` | `Invalid session link. Only kour.io domains are allowed.` |
| `KOUR_REPORT_API_INVALID_SESSION_LINK_URL` | `400` | The URL is invalid or exceeds 1000 characters. |
| Turnstile provider error code | `403` | `Captcha verification failed.` The code contains the provider error when available. |
| `KOUR_REPORT_API_CAPTCHA_VERIFICATION_UNAVAILABLE` | `503` | `Captcha verification is temporarily unavailable.` |
| `KOUR_REPORT_API_REPORT_SUBMITTED` | `201` | `Report submitted successfully.` |
| `KOUR_REPORT_API_INTERNAL_ERROR` | `500` | `Internal server error.` |
| `KOUR_REPORT_API_ROUTE_NOT_FOUND` | `404` | `Route not found.` |

When report development mode is enabled, both report endpoints return `503` with `KOUR_REPORT_API_UNDER_DEVELOPMENT`. The request is not processed as a report. `OPTIONS` preflight requests are unaffected.

## Limits

- The API allows up to **50 requests per one-second window**. Additional requests receive `429` with `KOUR_REPORT_API_RATE_LIMITED`.
- A **10-second cooldown** applies after an accepted report. During the cooldown, the API returns `429` with `KOUR_REPORT_API_REPORT_COOLDOWN` and a `Retry-After` header indicating the approximate remaining time.
- Requests rejected before acceptance do not start the cooldown.

## Example with `fetch`

```js
const response = await fetch(
  "https://kour-report-api.kourkbi.workers.dev/api/report",
  {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      turnstileToken: "TURNSTILE_TOKEN",
      target: "ReportedPlayer",
      roomId: "AB12CD",
      sessionLink: "https://kour.io#AB12CD",
      reason: "Brief description of the reason",
    }),
  },
);

const result = await response.json();

if (!response.ok) {
  console.error(result.code, result.message);
} else {
  console.log(result.message);
}
```

---

<p align="center">
  <a href="./README.md">Back to the project README</a>
</p>
