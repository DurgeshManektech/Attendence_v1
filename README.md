# InOut Tracker — MTWorks

A Chrome extension that shows your today's in-time, worked hours so far, expected out-time, and month-to-date attendance stats — without opening the MTWorks portal.

## How it works

Instead of scraping the rendered `inout-summary.aspx` page, this calls the same `DataService.asmx` endpoints the page's own JavaScript uses:

- `MemberSelect` — shift duration, department, join date
- `SelectApproxInHoursForToday` — today's approx in-time + minutes worked so far
- `InOutSelectByMonth` — full month's records, used to compute present days, working days, attendance %, and late days

It relies on your existing logged-in session cookie in the browser (`credentials: 'include'`) — no separate login flow needed, as long as you're logged into `mtworks.manektech.com` in that browser profile.

## Install (unpacked, for internal/personal use)

1. Open `chrome://extensions`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked**
4. Select this `inout-tracker` folder
5. Pin the extension, log into MTWorks in the same browser, then click the icon

## Settings

Right-click the icon → **Options** to set a specific Member ID, if the auto-detected one (`6552`, taken from the sample page's hidden field) isn't yours. Ideally we should fetch this dynamically — see "Known limitation" below.

## Known limitations / things to verify with real usage

1. **Member ID auto-detection**: right now it falls back to a hardcoded `6552` unless you set it in Options. A cleaner fix is to call `DataService.asmx/GetMemberID` (used elsewhere in the page for session validation) to get the logged-in user's own ID automatically — I stubbed the session check with it but didn't wire it to pull the ID itself, since the sample response shape for that endpoint wasn't in the HTML you shared. Once you confirm what it returns, I can wire it in and drop the manual ID entirely.
2. **Shift duration parsing**: `ShiftTime` from `MemberSelect` is assumed to be a string like `"8:15"` (hours:minutes). If it comes back in a different format (e.g. total minutes, or `"08:15:00"`), the parser in `api.js` (`shiftTimeToMinutes`) will need a tweak — easy fix once you see a real response.
3. **Half-day threshold**: I approximated half-day as exactly half the shift minutes for the attendance % calculation. The real portal's logic (`CurrentHalfTime` / `PreviousHalfTime`) hardcodes 4:15 vs 4:45 depending on policy — if your attendance % looks off, this is the first place to check.
4. **CORS/network**: since this calls `http://` (not https) on your company's internal domain, it'll only work on networks where that host resolves (e.g. office network/VPN) — same as the portal itself.

## Files

- `manifest.json` — MV3 config
- `api.js` — all MTWorks API calls + data shaping logic
- `background.js` — badge refresh every 5 min via `chrome.alarms`
- `popup.html/css/js` — the dashboard UI
- `options.html/js` — member ID override
