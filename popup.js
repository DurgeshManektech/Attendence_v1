// popup.js — wires MTApi data into the popup UI.

const el = {
  statusDot: document.getElementById("statusDot"),
  refreshBtn: document.getElementById("refreshBtn"),
  loadingState: document.getElementById("loadingState"),
  authState: document.getElementById("authState"),
  errorState: document.getElementById("errorState"),
  errorMsg: document.getElementById("errorMsg"),
  errorDetail: document.getElementById("errorDetail"),
  authDetail: document.getElementById("authDetail"),
  retryBtn: document.getElementById("retryBtn"),
  mainContent: document.getElementById("mainContent"),

  // Hero
  ringFill: document.getElementById("ringFill"),
  workedValue: document.getElementById("workedValue"),
  workedSec: document.getElementById("workedSec"),
  targetBadge: document.getElementById("targetBadge"),
  heroLabel: document.getElementById("heroLabel"),
  outTimeLabel: document.getElementById("outTimeLabel"),
  remainingTimeLabel: document.getElementById("remainingTimeLabel"),
  inTimeCaption: document.getElementById("inTimeCaption"),
  inTimeLabel: document.getElementById("inTimeLabel"),
  shiftLenValue: document.getElementById("shiftLenValue"),

  // Month stats
  attendanceValue: document.getElementById("attendanceValue"),
  presentDaysValue: document.getElementById("presentDaysValue"),
  workingDaysValue: document.getElementById("workingDaysValue"),
  lateDaysValue: document.getElementById("lateDaysValue"),

  // Calendar
  calMonthLabel: document.getElementById("calMonthLabel"),
  calGrid: document.getElementById("calGrid"),
  calPrevBtn: document.getElementById("calPrevBtn"),
  calNextBtn: document.getElementById("calNextBtn"),

  lastUpdated: document.getElementById("lastUpdated"),
  deptLabel: document.getElementById("deptLabel"),
};

const RING_CIRCUMFERENCE = 2 * Math.PI * 52; // matches r="52" in popup.html

// Baseline from the most recent fetch, so the hero can tick every second
// in between re-fetches.
let lastFetchedWorkedMinutes = 0;
let lastFetchedRemainingMinutes = 0;
let lastFetchedShiftMinutes = 0;
let lastFetchTimestamp = null;
// Time only moves while actually clocked in — on a break, after leaving,
// or before the first punch, worked/remaining must stay frozen.
let lastIsCurrentlyIn = false;

// Calendar navigation state.
let currentCalendarDate = new Date();
let currentMemberId = null;
let lastDashboardData = null;
let calendarNavBusy = false;
let loadBusy = false;

function showState(name) {
  el.loadingState.classList.toggle("hidden", name !== "loading");
  el.authState.classList.toggle("hidden", name !== "auth");
  el.errorState.classList.toggle("hidden", name !== "error");
  el.mainContent.classList.toggle("hidden", name !== "main");
}

function formatClock(date) {
  if (!date) return "--:--";
  let h = date.getHours();
  const m = date.getMinutes();
  const ampm = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  return `${h}:${m.toString().padStart(2, "0")} ${ampm}`;
}

// pad2() comes from api.js — both scripts share one global scope, so
// re-declaring it here would be a SyntaxError that stops popup.js loading.

/** Splits minutes into whole h / m / s (never negative). */
function splitMinutes(totalMinutes) {
  const totalSeconds = Math.max(0, Math.floor(totalMinutes * 60));
  return {
    h: Math.floor(totalSeconds / 3600),
    m: Math.floor((totalSeconds % 3600) / 60),
    s: totalSeconds % 60,
  };
}

/** "8h 15m" — for durations shown as plain text. */
function formatDuration(totalMinutes) {
  const { h, m } = splitMinutes(totalMinutes);
  if (h && m) return `${h}h ${m}m`;
  if (h) return `${h}h`;
  return `${m}m`;
}

/** "2h 05m 10s" / "5m 45s" — for the live countdown. */
function formatCountdown(totalMinutes) {
  const { h, m, s } = splitMinutes(totalMinutes);
  return h ? `${h}h ${pad2(m)}m ${pad2(s)}s` : `${m}m ${pad2(s)}s`;
}

/** Override → cached ID → detect (slow, full page fetch) — see api.js. */
function getMemberId() {
  return MTApi.resolveMemberId(); // throws if detection fails — caller must handle
}

// Last successful dashboard fetch, saved so the next popup open can show it
// instantly while fresh data loads in the background.
const DASHBOARD_CACHE_KEY = "inout_last_dashboard";

async function saveDashboardCache(data) {
  try {
    await chrome.storage.local.set({ [DASHBOARD_CACHE_KEY]: JSON.stringify(data) });
  } catch (err) {
    console.warn("[popup] couldn't cache dashboard:", err);
  }
}

/** Returns today's cached dashboard (with Dates restored), or null. Data
 *  from a previous day is ignored — it would show yesterday's hours. */
async function loadDashboardCache() {
  try {
    const stored = await chrome.storage.local.get(DASHBOARD_CACHE_KEY);
    if (!stored[DASHBOARD_CACHE_KEY]) return null;
    const data = JSON.parse(stored[DASHBOARD_CACHE_KEY]);
    const toDate = (v) => (v ? new Date(v) : null);
    data.fetchedAt = toDate(data.fetchedAt);
    data.inTimeDate = toDate(data.inTimeDate);
    data.expectedOutDate = toDate(data.expectedOutDate);
    if (!data.fetchedAt || data.fetchedAt.toDateString() !== new Date().toDateString()) return null;
    return data;
  } catch {
    return null;
  }
}

/** Renders a compact month calendar, color-coded like the MTWorks portal's
 *  own calendar (present/off/holiday/leave/absent). `direction` (-1 / 1)
 *  slides the grid in from the side you navigated toward. */
function renderCalendar(data, direction = 0) {
  const { monthRecords, shiftMinutes, workedMinutesSoFar, remainingMinutes, targetReached, monthDate } = data;
  el.calGrid.innerHTML = "";

  el.calGrid.classList.remove("slide-next", "slide-prev");
  if (direction) {
    void el.calGrid.offsetWidth; // restart the animation
    el.calGrid.classList.add(direction > 0 ? "slide-next" : "slide-prev");
  }

  const labelDate = monthDate || new Date();
  el.calMonthLabel.textContent = labelDate.toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
  });

  if (!Array.isArray(monthRecords) || !monthRecords.length) {
    const empty = document.createElement("span");
    empty.className = "cal-empty-note";
    empty.textContent = "No records for this month";
    el.calGrid.appendChild(empty);
    return;
  }

  const halfDayMin = Math.floor(shiftMinutes / 2);
  const todayStr = MTApi.todayISO();
  const todayAtMidnight = new Date();
  todayAtMidnight.setHours(0, 0, 0, 0);

  const sorted = [...monthRecords].sort((a, b) =>
    a.CalendarDay < b.CalendarDay ? -1 : a.CalendarDay > b.CalendarDay ? 1 : 0
  );

  const firstDate = new Date(sorted[0].CalendarDay);

  // Mon-start offset for the first day of the month.
  const leadBlanks = (firstDate.getDay() + 6) % 7;
  for (let i = 0; i < leadBlanks; i++) {
    const blank = document.createElement("span");
    blank.className = "cal-day empty";
    el.calGrid.appendChild(blank);
  }

  for (const r of sorted) {
    const cell = document.createElement("span");
    const recordDate = new Date(r.CalendarDay);
    cell.textContent = recordDate.getDate();

    const dateOnly = new Date(r.CalendarDay);
    dateOnly.setHours(0, 0, 0, 0);
    const isToday = r.CalendarDay === todayStr;
    const isFuture = !isToday && dateOnly > todayAtMidnight;
    const isWeekend = r.WeekDay === "Saturday" || r.WeekDay === "Sunday";
    const isHoliday = !!(r.Holiday && String(r.Holiday).trim());
    const isLeave = r.IsLeaveApplied === "1" || r.IsLeaveApplied === 1;
    const inMin = parseInt(r.InMin, 10) || 0;
    const workedOnHoliday =
      ["0.25", "0.50", "1.00"].includes(r.WorkOnHolidayDays) &&
      r.WorkOnHolidayStatus === "1";

    let status = "absent";
    let title = "Absent — no record";

    if (isToday) {
      status = "today";
      if (targetReached) {
        title = `Today — target reached (${MTApi.formatMinutesAsHM(workedMinutesSoFar)} worked)`;
      } else if (workedMinutesSoFar > 0) {
        title = `Today — ${MTApi.formatMinutesAsHM(workedMinutesSoFar)} worked, ${MTApi.formatMinutesAsHM(Math.max(0, remainingMinutes))} remaining`;
      } else {
        title = "Today — not clocked in yet";
      }
    } else if (workedOnHoliday) {
      status = "present";
      title = `Present — worked on holiday/weekend (${MTApi.formatMinutesAsHM(inMin)})`;
    } else if (isHoliday) {
      status = "holiday";
      title = isFuture ? `Upcoming — ${r.Holiday}` : r.Holiday;
    } else if (isWeekend) {
      status = "off";
      title = isFuture ? "Upcoming weekend" : "Weekend";
    } else if (isLeave) {
      status = "leave";
      title = "Leave";
    } else if (isFuture) {
      status = "future";
      title = "Upcoming";
    } else if (inMin >= shiftMinutes) {
      status = "present";
      const variation = inMin - shiftMinutes;
      const variationStr =
        variation > 0 ? `+${MTApi.formatMinutesAsHM(variation)}` : MTApi.formatMinutesAsHM(variation);
      title = `Present — ${MTApi.formatMinutesAsHM(inMin)} worked, Variation ${variationStr}`;
    } else if (inMin >= halfDayMin) {
      status = "present";
      title = `Half day — ${MTApi.formatMinutesAsHM(inMin)} worked`;
    }

    cell.className = `cal-day ${status}`;
    cell.title = title;
    el.calGrid.appendChild(cell);
  }
}

/** Live worked/remaining minutes right now, based on the last fetch. */
function liveMinutes() {
  const elapsed =
    lastIsCurrentlyIn && lastFetchTimestamp ? (Date.now() - lastFetchTimestamp) / 60000 : 0;
  return {
    worked: lastFetchedWorkedMinutes + elapsed,
    remaining: lastFetchedRemainingMinutes - elapsed,
  };
}

/** Updates the parts of the hero that change every second. */
function renderLive() {
  const { worked, remaining } = liveMinutes();

  const w = splitMinutes(worked);
  el.workedValue.textContent = `${w.h}:${pad2(w.m)}`;
  el.workedSec.textContent = `:${pad2(w.s)}`;

  const pct = lastFetchedShiftMinutes > 0 ? Math.min(worked / lastFetchedShiftMinutes, 1) : 0;
  el.ringFill.style.strokeDashoffset = `${RING_CIRCUMFERENCE * (1 - pct)}`;

  if (remaining <= 0) {
    el.remainingTimeLabel.textContent =
      remaining < -1 ? `+${formatDuration(-remaining)} extra today` : "Shift complete";
  } else if (worked <= 0 && !lastIsCurrentlyIn) {
    el.remainingTimeLabel.textContent = "Not clocked in yet";
  } else {
    el.remainingTimeLabel.textContent = `${formatCountdown(remaining)} left`;
  }
  el.remainingTimeLabel.classList.toggle("muted", worked <= 0 && !lastIsCurrentlyIn);
}

/** Sets the status pill, ring colour, status dot and labels for the
 *  current state: working / on break / done / not clocked in. */
function renderStatus(remainingMinutes, workedMinutes) {
  const done = remainingMinutes <= 0;
  const notStarted = workedMinutes <= 0 && !lastIsCurrentlyIn;
  const onBreak = !done && !notStarted && !lastIsCurrentlyIn;

  let pill = { text: "Working", cls: "working" };
  if (done) pill = { text: "Shift complete", cls: "done" };
  else if (notStarted) pill = { text: "Not clocked in", cls: "" };
  else if (onBreak) pill = { text: "On break", cls: "break" };

  el.targetBadge.textContent = pill.text;
  el.targetBadge.className = `pill ${pill.cls}`;

  el.ringFill.classList.toggle("done", done);
  el.ringFill.classList.toggle("paused", onBreak);

  el.statusDot.classList.remove("live", "idle");
  if (lastIsCurrentlyIn) el.statusDot.classList.add("live");
  else if (onBreak) el.statusDot.classList.add("idle");

  el.heroLabel.textContent = done ? "You could leave at" : notStarted ? "Expected out" : "Leave at";
  el.inTimeCaption.textContent = notStarted ? "Starts" : "In";
}

function render(data, { keepCalendarMonth = false } = {}) {
  const { shiftMinutes, workedMinutesSoFar, remainingMinutes, inTimeDate, expectedOutDate, monthSummary, memberInfo } =
    data;

  // Live-tick baseline from this fresh fetch.
  lastFetchedWorkedMinutes = workedMinutesSoFar;
  lastFetchedRemainingMinutes = remainingMinutes;
  lastFetchedShiftMinutes = shiftMinutes;
  // Use the real fetch time, so data shown from the cache ticks forward correctly.
  const fetchedAt = data.fetchedAt instanceof Date ? data.fetchedAt : new Date();
  lastFetchTimestamp = fetchedAt.getTime();
  lastIsCurrentlyIn = data.isCurrentlyIn === true;

  renderStatus(remainingMinutes, workedMinutesSoFar);
  el.outTimeLabel.textContent = formatClock(expectedOutDate);
  el.inTimeLabel.textContent = formatClock(inTimeDate);
  el.shiftLenValue.textContent = formatDuration(shiftMinutes);

  // Month stats
  el.attendanceValue.textContent = `${monthSummary.attendancePct}%`;
  el.presentDaysValue.textContent = monthSummary.presentDays;
  el.workingDaysValue.textContent = monthSummary.workingDays;
  el.lateDaysValue.textContent = monthSummary.lateDays;

  el.deptLabel.textContent = memberInfo.department || "";
  el.lastUpdated.textContent = `Updated ${formatClock(fetchedAt)}`;

  // Background refreshes keep whatever month you were looking at; a manual
  // refresh brings the calendar back to the current month.
  const now = new Date();
  const viewingCurrentMonth =
    currentCalendarDate.getFullYear() === now.getFullYear() &&
    currentCalendarDate.getMonth() === now.getMonth();
  if (!keepCalendarMonth || viewingCurrentMonth) {
    currentCalendarDate = now;
    renderCalendar({ ...data, monthDate: currentCalendarDate });
  }

  const firstShow = el.mainContent.classList.contains("hidden");
  if (firstShow) {
    // Start the ring empty so it animates up to the real value.
    el.ringFill.style.strokeDashoffset = `${RING_CIRCUMFERENCE}`;
    showState("main");
    requestAnimationFrame(() => requestAnimationFrame(renderLive));
  } else {
    renderLive();
  }
}

/** Pushes the toolbar badge to match this fetch immediately, so it doesn't
 *  sit on whatever background.js's own refresh cycle last computed. */
function syncBadge(data) {
  try {
    const badge = MTApi.computeBadge(data);
    chrome.action.setBadgeText({ text: badge.text });
    chrome.action.setBadgeBackgroundColor({ color: badge.color });
    chrome.action.setBadgeTextColor && chrome.action.setBadgeTextColor({ color: "#0a1512" });
  } catch (err) {
    console.warn("[popup] badge sync failed:", err);
  }
}

/** Resolves the member ID (cached when possible) and fetches the dashboard. */
async function fetchForCurrentMember() {
  let memberId;
  try {
    memberId = await getMemberId();
  } catch (detectErr) {
    console.error("[popup] member ID detection failed:", detectErr);
    const authErr = new Error("AUTH_REQUIRED");
    authErr.cause = detectErr && detectErr.message ? detectErr.message : String(detectErr);
    throw authErr;
  }
  currentMemberId = memberId;
  return MTApi.fetchDashboardData(memberId);
}

/** `silent` = background auto-refresh: keeps the current data on screen
 *  (no loading spinner flash) and keeps the calendar on the month you're viewing. */
async function load({ silent = false } = {}) {
  if (loadBusy) return;
  loadBusy = true;

  const showingData = !el.mainContent.classList.contains("hidden");
  if (!(silent && showingData)) showState("loading");
  el.refreshBtn.classList.add("spinning");

  if (silent && showingData) el.lastUpdated.textContent = "Updating…";

  try {
    let data;
    try {
      data = await fetchForCurrentMember();
    } catch (err) {
      if (!(err && err.message === "AUTH_REQUIRED")) throw err;
      // The cached member ID may be stale (session expired, or a different
      // person logged in). Forget it and try once more with a fresh detect.
      await MTApi.clearCachedMemberId();
      data = await fetchForCurrentMember();
    }

    lastDashboardData = data;
    render(data, { keepCalendarMonth: silent });
    syncBadge(data);
    saveDashboardCache(data);
  } catch (err) {
    console.error("[popup] load failed:", err);
    const detail =
      err && err.cause
        ? `${err.message} — ${err.cause}`
        : err
          ? err.message
          : "Unknown error";

    if (err && err.message === "AUTH_REQUIRED") {
      chrome.storage.local.remove(DASHBOARD_CACHE_KEY);
      el.authDetail.textContent = err.cause || "";
      showState("auth");
    } else if (silent && showingData) {
      // Keep showing the last good data rather than replacing it with an error.
      el.lastUpdated.textContent = "Couldn't refresh";
    } else {
      el.errorMsg.textContent = "Check your connection or try again in a moment.";
      el.errorDetail.textContent = detail;
      showState("error");
    }
  } finally {
    el.refreshBtn.classList.remove("spinning");
    loadBusy = false;
  }
}

/** Ticks the live parts of the hero every second between re-fetches. */
function tickDisplay() {
  if (!lastFetchTimestamp || el.mainContent.classList.contains("hidden")) return;
  renderLive();
  // Flip the pill to "Shift complete" the moment the countdown hits zero.
  const { worked, remaining } = liveMinutes();
  if (remaining <= 0 && !el.targetBadge.classList.contains("done")) {
    renderStatus(remaining, worked);
  }
}

/** Moves the calendar to the previous/next month and fetches that month's
 *  records on demand. */
async function navigateMonth(delta) {
  if (calendarNavBusy || !currentMemberId) return;
  calendarNavBusy = true;
  el.calPrevBtn.disabled = true;
  el.calNextBtn.disabled = true;
  el.calGrid.classList.add("loading");

  const targetDate = new Date(
    currentCalendarDate.getFullYear(),
    currentCalendarDate.getMonth() + delta,
    1
  );

  try {
    const monthRecords = await MTApi.getMonthRecords(currentMemberId, targetDate);
    currentCalendarDate = targetDate;
    renderCalendar(
      {
        monthRecords,
        shiftMinutes: lastDashboardData ? lastDashboardData.shiftMinutes : 0,
        workedMinutesSoFar: lastDashboardData ? lastDashboardData.workedMinutesSoFar : 0,
        remainingMinutes: lastDashboardData ? lastDashboardData.remainingMinutes : 0,
        targetReached: lastDashboardData ? lastDashboardData.targetReached : false,
        monthDate: targetDate,
      },
      delta
    );
  } catch (err) {
    console.error("[popup] month navigation failed:", err);
  } finally {
    el.calGrid.classList.remove("loading");
    calendarNavBusy = false;
    el.calPrevBtn.disabled = false;
    el.calNextBtn.disabled = false;
  }
}

el.calPrevBtn.addEventListener("click", () => navigateMonth(-1));
el.calNextBtn.addEventListener("click", () => navigateMonth(1));

el.refreshBtn.addEventListener("click", () => load());

const themeBtn = document.getElementById("themeBtn");
function updateThemeBtnTitle() {
  themeBtn.title = InOutTheme.current() === "light" ? "Switch to dark theme" : "Switch to light theme";
}
themeBtn.addEventListener("click", () => {
  InOutTheme.toggle();
  updateThemeBtnTitle();
});
updateThemeBtnTitle();
el.retryBtn.addEventListener("click", () => load());

// Open instantly: show today's last-known data straight from the cache
// (no network), then refresh it quietly in the background.
//
// If that data is under a minute old (you just closed and reopened the
// popup), don't hit the server at all. MTWorks handles one request at a time
// per login session, so the previous popup's still-running requests would
// make a new set queue up behind them — that's what made re-opens slow.
const FRESH_ENOUGH_MS = 60 * 1000;

(async () => {
  const t0 = performance.now();
  const cached = await loadDashboardCache();
  if (cached && !lastDashboardData) {
    lastDashboardData = cached;
    render(cached);
    console.info(`[popup] showed cached data in ${Math.round(performance.now() - t0)} ms`);
  }

  if (cached && Date.now() - cached.fetchedAt.getTime() < FRESH_ENOUGH_MS) {
    console.info("[popup] cached data is fresh — skipping network refresh");
    // We still need the member ID for calendar month navigation (cached, no network).
    MTApi.resolveMemberId().then((id) => (currentMemberId = id), () => {});
    return;
  }

  await load({ silent: !!cached });
  console.info(`[popup] refresh finished in ${Math.round(performance.now() - t0)} ms`);
})();

setInterval(() => load({ silent: true }), 5 * 60 * 1000); // quiet re-fetch every 5 min
setInterval(tickDisplay, 1000); // per-second UI tick between fetches
