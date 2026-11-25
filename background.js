// background.js — periodically refreshes badge text with worked hours,
// so you get a glance without opening the popup.

importScripts('api.js');

const MEMBER_ID_OVERRIDE_KEY = 'mtworks_member_id_override';
const ALARM_NAME = 'inout-badge-refresh';

async function getMemberId() {
  const stored = await chrome.storage.local.get(MEMBER_ID_OVERRIDE_KEY);
  const override = stored[MEMBER_ID_OVERRIDE_KEY];
  if (override) return override;

  return self.MTApi.detectLoggedInMemberId(); // throws if not logged in
}

async function refreshBadge() {
  try {
    const memberId = await getMemberId();
    const data = await self.MTApi.fetchDashboardData(memberId);
    // Badge shows time REMAINING in the shift, not time worked so far.
    const remainingMinutes = Math.max(0, Math.round(data.remainingMinutes));
    const hours = Math.floor(remainingMinutes / 60);
    const mins = remainingMinutes % 60;
    // Chrome badges only reliably show ~4 characters — cap hours so the
    // label never gets silently clipped (e.g. "12:34" -> just show "12h").
    const label = hours >= 10 ? `${hours}h` : `${hours}:${mins.toString().padStart(2, '0')}`;

    chrome.action.setBadgeText({ text: data.targetReached ? '✓' : label });
    chrome.action.setBadgeBackgroundColor({
      color: data.targetReached ? '#5ee6c4' : '#e7e8e9'
    });
    chrome.action.setBadgeTextColor && chrome.action.setBadgeTextColor({ color: '#0a1512' });
  } catch (err) {
    // Silent fail — badge just won't update; popup will show the real error state.
    chrome.action.setBadgeText({ text: '' });
  }
}

// Re-arm the alarm every time the service worker wakes up (not just on
// install/startup). MV3 service workers get killed and restarted on all
// sorts of events, and if the alarm was ever lost in between — the badge
// would otherwise freeze on whatever it last showed until the next full
// browser restart. Re-creating an existing alarm with the same name is a
// no-op schedule reset, so this is safe to call unconditionally.
chrome.alarms.create(ALARM_NAME, { periodInMinutes: 5 });

// Also refresh immediately on every service-worker wake, so the badge
// never sits on stale data waiting for the next alarm tick.
refreshBadge();

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(ALARM_NAME, { periodInMinutes: 5 });
  refreshBadge();
});

chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create(ALARM_NAME, { periodInMinutes: 5 });
  refreshBadge();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) {
    refreshBadge();
  }
});
