// background.js — periodically refreshes badge text with worked hours,
// so you get a glance without opening the popup.

importScripts('api.js');

const ALARM_NAME = 'inout-badge-refresh';

// Override → cached ID → detect (slow, full page fetch) — see api.js.
function getMemberId() {
  return self.MTApi.resolveMemberId();
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
    // Anything other than a plain network failure may mean the cached member
    // ID is stale (logged out / different user) — re-detect next time.
    if (!String(err && err.message).startsWith('NETWORK_ERROR')) {
      self.MTApi.clearCachedMemberId();
    }
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
