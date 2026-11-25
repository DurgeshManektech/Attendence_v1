// background.js — keeps the toolbar badge showing time REMAINING in the shift,
// so you get a glance without opening the popup.
//
// Two alarms:
//   - FETCH (every 5 min): pulls fresh data from MTWorks and saves a snapshot.
//   - TICK  (every 1 min): re-renders the badge from the saved snapshot, so it
//     counts down minute by minute without hitting the server.
// The popup writes the same snapshot whenever it fetches, so the badge and
// the popup always agree.

importScripts('api.js');

const MEMBER_ID_OVERRIDE_KEY = 'mtworks_member_id_override';
const FETCH_ALARM = 'inout-badge-refresh';
const TICK_ALARM = 'inout-badge-tick';

async function getMemberId() {
  const stored = await chrome.storage.local.get(MEMBER_ID_OVERRIDE_KEY);
  const override = stored[MEMBER_ID_OVERRIDE_KEY];
  if (override) return override;

  return self.MTApi.detectLoggedInMemberId(); // throws if not logged in
}

async function fetchAndRenderBadge() {
  try {
    const memberId = await getMemberId();
    const data = await self.MTApi.fetchDashboardData(memberId);
    const snapshot = self.MTApi.makeBadgeSnapshot(data);
    await self.MTApi.saveBadgeSnapshot(snapshot);
    self.MTApi.renderBadgeFromSnapshot(snapshot);
  } catch (err) {
    // Not logged in / network down — clear the badge rather than show stale data.
    await self.MTApi.clearBadgeSnapshot();
    chrome.action.setBadgeText({ text: '' });
  }
}

async function tickBadge() {
  const snapshot = await self.MTApi.loadBadgeSnapshot();
  self.MTApi.renderBadgeFromSnapshot(snapshot);
}

// Create alarms only if missing. Re-creating an existing alarm RESETS its
// schedule, and since the tick alarm wakes this worker every minute, blindly
// re-creating the 5-min fetch alarm on each wake would mean it never fires.
async function ensureAlarm(name, periodInMinutes) {
  const existing = await chrome.alarms.get(name);
  if (!existing) chrome.alarms.create(name, { periodInMinutes });
}

ensureAlarm(FETCH_ALARM, 5);
ensureAlarm(TICK_ALARM, 1);

chrome.runtime.onInstalled.addListener(fetchAndRenderBadge);
chrome.runtime.onStartup.addListener(fetchAndRenderBadge);

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === FETCH_ALARM) fetchAndRenderBadge();
  else if (alarm.name === TICK_ALARM) tickBadge();
});
