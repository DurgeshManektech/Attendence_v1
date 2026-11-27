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

async function refreshBadge(trigger) {
  console.log(`[bg] refreshBadge fired (${trigger}) @ ${new Date().toLocaleTimeString()}`);
  try {
    const memberId = await getMemberId();
    const data = await self.MTApi.fetchBadgeData(memberId);
    const badge = self.MTApi.computeBadge(data);

    chrome.action.setBadgeText({ text: badge.text });
    chrome.action.setBadgeBackgroundColor({ color: badge.color });
    chrome.action.setBadgeTextColor && chrome.action.setBadgeTextColor({ color: '#0a1512' });
    console.log(`[bg] badge set to "${badge.text}"`);
  } catch (err) {
    // Badge just won't update; popup will show the real error state. Still
    // logged (rather than swallowed) so the service worker console shows
    // *why*, instead of looking like the alarm never fired at all.
    console.warn(`[bg] refreshBadge failed (${trigger}):`, err);
    chrome.action.setBadgeText({ text: '' });
  }
}

// Re-arm the alarm every time the service worker wakes up (not just on
// install/startup). MV3 service workers get killed and restarted on all
// sorts of events, and if the alarm was ever lost in between — the badge
// would otherwise freeze on whatever it last showed until the next full
// browser restart. Re-creating an existing alarm with the same name is a
// no-op schedule reset, so this is safe to call unconditionally.
chrome.alarms.create(ALARM_NAME, { periodInMinutes: 1 });
console.log(`[bg] service worker (re)started @ ${new Date().toLocaleTimeString()}, alarm (re)armed`);
chrome.alarms.get(ALARM_NAME, (a) => {
  console.log(
    `[bg] alarm state:`,
    a ? { scheduledTime: new Date(a.scheduledTime).toLocaleTimeString(), periodInMinutes: a.periodInMinutes } : "MISSING"
  );
});

// Also refresh immediately on every service-worker wake, so the badge
// never sits on stale data waiting for the next alarm tick.
refreshBadge('sw-wake');

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(ALARM_NAME, { periodInMinutes: 1 });
  refreshBadge('onInstalled');
});

chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create(ALARM_NAME, { periodInMinutes: 1 });
  refreshBadge('onStartup');
});

chrome.alarms.onAlarm.addListener((alarm) => {
  console.log(`[bg] onAlarm event received: "${alarm.name}" @ ${new Date().toLocaleTimeString()}`);
  if (alarm.name === ALARM_NAME) {
    refreshBadge('alarm');
  }
});
