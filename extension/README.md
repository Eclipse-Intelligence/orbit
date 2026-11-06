# Orbit LinkedIn capture

A Chrome extension that opens Orbit in Chrome's side panel next to LinkedIn and Sales Navigator. It looks up the person or company you're viewing in every workspace you connected, saves new people and companies, adds tasks and notes, logs LinkedIn messages, and updates a record from the page. Nothing is added to LinkedIn's pages.

## What it reads, and when

- **The page address**, on every LinkedIn page you open, to check whether the person or company is in Orbit. The toolbar icon shows a green dot when it is, and an amber dot for a possible match.
- **The top of a profile and the current role in Experience** (name, headline, company, location), or a company page's name, tagline and About details, only while the side panel is open, once per page.
- **Messages**, only when you press Log this conversation, and only the ones already on screen.

It never opens, scrolls or clicks anything, never calls LinkedIn's own APIs, and saves nothing until you press Save, Add or Log. Sales Navigator lead pages are read only; lead lists and Sales Navigator notes are never touched.

## Permissions

| Permission | Why |
| --- | --- |
| `sidePanel` | Shows Orbit in Chrome's side panel. |
| `storage` | Keeps this browser's Orbit credential and the last workspace you chose, on this computer only. |
| Host `https://www.linkedin.com/*` | Reads the page address for the lookup and runs the reader that answers the panel. |
| Host for Orbit (`https://orbit.geteclipse.co/*` by default) | Talks to Orbit's `/api/extension` endpoints. |

There is no `tabs`, `scripting`, `cookies` or `<all_urls>` permission.

## Build

```sh
npm run extension:build
```

This writes the unpacked extension to `extension/dist`. Two settings are read at build time:

- `ORBIT_URL`: the Orbit origin, default `https://orbit.geteclipse.co`.
- `LINKEDIN_URL`: the LinkedIn origin, default `https://www.linkedin.com`. Only change it for testing against a local copy of the fixture pages, for example `LINKEDIN_URL=http://127.0.0.1:4410`. Addresses sent to Orbit always use `https://www.linkedin.com` with the same path.

For a local Orbit:

```sh
ORBIT_URL=http://localhost:3000 npm run extension:build
```

## Load it unpacked

1. Open `chrome://extensions` and turn on Developer mode.
2. Press Load unpacked and choose `extension/dist`.
3. Pin Orbit LinkedIn capture to the toolbar. Clicking it opens the side panel.

The unpacked build includes a public key, so its ID is always `fdlhldfkiompmkjhobgnddjdaocjnfkd` on every computer.

## Allow the extension in Orbit

Orbit only answers the extension's requests from extension IDs it knows. Set `LINKEDIN_EXTENSION_ID` on the Orbit server to a comma-separated list, for example:

```sh
LINKEDIN_EXTENSION_ID=fdlhldfkiompmkjhobgnddjdaocjnfkd
```

Add the Chrome Web Store ID to the list once the listing exists.

## Connect

1. Open the side panel and press Connect.
2. Orbit opens in a new tab showing the same code as the panel. Check the code, name the browser, choose its workspaces and press Approve.
3. The panel connects by itself. The code works for 10 minutes.

The browser can look up and save people and companies, and add tasks, notes and LinkedIn activity in the chosen workspaces. It can't read mail, calendars, docs or assistant chats. Revoke it, or change its workspaces, in Orbit under Settings › Integrations › LinkedIn capture. Disconnect in the panel's menu revokes it too.

## Publish privately on the Chrome Web Store

1. Build the store package: `npm run extension:zip`. It writes `extension/dist/orbit-linkedin-capture.zip` with the manifest at the root and without the public key, because the store assigns the ID.
2. Sign in to the Chrome Web Store developer dashboard with the company Google Workspace account and pay the one-off registration fee if this account hasn't published before.
3. Add a new item and upload the zip.
4. Store listing: name, a short description, the 128px icon (`extension/icons/icon-128.png`) and at least one screenshot of the side panel.
5. Privacy practices:
   - Single purpose: "Look up, save and update LinkedIn people and companies in the company's Orbit CRM, and log LinkedIn conversations when the user asks."
   - Permission justifications: use the table above.
   - Data use: it handles personally identifiable information and website content (names, job titles, companies, locations and, when asked, message text) and sends them only to the company's Orbit. Nothing is sold or used for anything else.
   - Remote code: none.
6. Distribution: set Visibility to Private and choose the company's Google Workspace domain (or a list of trusted testers).
7. Submit for review.
8. When it's approved, add the store's extension ID to `LINKEDIN_EXTENSION_ID` and set `LINKEDIN_EXTENSION_URL` to the listing's address, so Settings › Integrations shows Get the extension.

Bump `version` in `extension/version.json` before each new upload.

## Code

- `src/background.ts`: the service worker. It opens the side panel from the toolbar button and colours the toolbar badge from a lookup of the page address.
- `src/content.ts`: the reader. It only answers the panel's `orbit:read` messages, using `src/parsers`.
- `src/parsers`: pure functions that read a profile, company page, Sales Navigator lead or message thread from the page and return empty fields when LinkedIn's markup changes.
- `src/panel`: the side panel.
- `../lib/extension/protocol.ts`: the request and response types shared with Orbit.

Parser tests run against invented fixture pages in `tests/fixtures/linkedin`: `npx tsx --test tests/extension-parsers.test.ts`.
