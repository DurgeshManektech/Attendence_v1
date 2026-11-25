// popup.js — wires MTApi data into the popup UI.

const MEMBER_ID_STORAGE_KEY = "mtworks_member_id";

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

  heroLabel: document.getElementById("heroLabel"),
  targetBadge: document.getElementById("targetBadge"),
  workedValue: document.getElementById("workedValue"),
  heroSub: document.getElementById("heroSub"),

  inTimeLabel: document.getElementById("inTimeLabel"),
  outTimeLabel: document.getElementById("outTimeLabel"),
  remainingTimeLabel: document.getElementById("remainingTimeLabel"),
  timelineFill: document.getElementById("timelineFill"),
  timelineNow: document.getElementById("timelineNow"),

  calMonthLabel: document.getElementById("calMonthLabel"),
  calGrid: document.getElementById("calGrid"),
  calPrevBtn: document.getElementById("calPrevBtn"),
  calNextBtn: document.getElementById("calNextBtn"),

  shiftLenValue: document.getElementById("shiftLenValue"),
  attendanceValue: document.getElementById("attendanceValue"),
  presentDaysValue: document.getElementById("presentDaysValue"),
  workingDaysValue: document.getElementById("workingDaysValue"),
  lateDaysValue: document.getElementById("lateDaysValue"),
  otValue: document.getElementById("otValue"), // optional — only if added to popup.html

  lastUpdated: document.getElementById("lastUpdated"),
  deptLabel: document.getElementById("deptLabel"),
};

// Tracks the most recent fetch so the hero number (and remaining-time
// stat) can tick live in between re-fetches, down to the second.
let lastFetchedWorkedMinutes = 0;
let lastFetchedRemainingMinutes = 0;
let lastFetchTimestamp = null;
// Only tick the clock while actually clocked in — on a break, after leaving,
// or before the first punch, worked/remaining time must stay frozen.
let lastIsCurrentlyIn = false;
// Same snapshot the background worker uses, so popup + badge always agree.
let lastBadgeSnapshot = null;

// Tracks calendar navigation state — the month the calendar currently
// shows, the member whose records to fetch, and the most recent full
// dashboard fetch (for "today" context when the shown month is the
// real current month).
let currentCalendarDate = new Date();
let currentMemberId = null;
let lastDashboardData = null;
let calendarNavBusy = false;

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

/** Formats a total-minutes value as HH:MM:SS, treating the value as a live
 *  starting point and adding whole seconds elapsed since it was fetched. */
function formatWorkedWithSeconds(totalMinutes) {
  const totalSeconds = Math.max(0, Math.round(totalMinutes * 60));
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  return `${h.toString().padStart(2, "0")}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
}

const MEMBER_ID_OVERRIDE_KEY = "mtworks_member_id_override";

/**
 * Resolves which member ID to fetch data for.
 *
 * Priority:
 *   1. An explicit manual override (set via the Options page) — for the
 *      rare case someone deliberately wants to view a different person's
 *      data (e.g. a PM checking a report they manage).
 *   2. Auto-detected from the logged-in session itself (reads the hidden
 *      field the server renders per-session on inout-summary.aspx).
 *
 * There is NO hardcoded fallback member ID anymore — that was the bug
 * that made every install show one specific person's data regardless of
 * who was actually logged in.
 */
async function getMemberId() {
  const stored = await chrome.storage.local.get(MEMBER_ID_OVERRIDE_KEY);
  const override = stored[MEMBER_ID_OVERRIDE_KEY];
  if (override) return override;

  return MTApi.detectLoggedInMemberId(); // throws if detection fails — caller must handle
}

/** Renders a compact month calendar, color-coded like the MTWorks portal's
 *  own calendar (present/off/holiday/leave/absent), from the raw per-day
 *  records returned alongside the month summary. */
function renderCalendar(data) {
  const { monthRecords, shiftMinutes, workedMinutesSoFar, remainingMinutes, targetReached, monthDate } = data;
  el.calGrid.innerHTML = "";

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

function render(data) {
  const {
    shiftMinutes,
    workedMinutesSoFar,
    remainingMinutes,
    targetReached,
    inTimeDate,
    expectedOutDate,
    monthSummary,
    memberInfo,
  } = data;

  // Hero — set the live-tick baseline from this fresh fetch.
  lastFetchedWorkedMinutes = workedMinutesSoFar;
  lastFetchedRemainingMinutes = remainingMinutes;
  lastFetchTimestamp = Date.now();
  lastIsCurrentlyIn = !!data.isCurrentlyIn;
  lastBadgeSnapshot = MTApi.makeBadgeSnapshot(data);
  MTApi.saveBadgeSnapshot(lastBadgeSnapshot);
  MTApi.renderBadgeFromSnapshot(lastBadgeSnapshot);
  el.workedValue.textContent = formatWorkedWithSeconds(workedMinutesSoFar);
  el.heroSub.textContent = `of ${MTApi.formatMinutesAsHM(shiftMinutes)} shift`;

  el.statusDot.classList.remove("live", "warn");
  if (targetReached) {
    el.heroLabel.textContent = "Shift complete";
    el.targetBadge.textContent =
      remainingMinutes < -1
        ? `+${MTApi.formatMinutesAsHM(-remainingMinutes)} extra`
        : "Target reached";
    el.targetBadge.className = "badge reached";
    el.statusDot.classList.add("live");
  } else {
    el.heroLabel.textContent = "Worked so far";
    el.targetBadge.textContent = "In progress";
    el.targetBadge.className = "badge on-track";
    el.statusDot.classList.add("live");
  }

  // In / Remaining / Expected out row
  el.inTimeLabel.textContent = formatClock(inTimeDate);
  el.outTimeLabel.textContent = formatClock(expectedOutDate);
  el.remainingTimeLabel.textContent =
    remainingMinutes > 0 ? formatWorkedWithSeconds(remainingMinutes) : "00:00:00";

  let pct = shiftMinutes > 0 ? (workedMinutesSoFar / shiftMinutes) * 100 : 0;
  const over = pct > 100;
  pct = Math.max(0, Math.min(pct, 100));
  el.timelineFill.style.width = `${pct}%`;
  el.timelineFill.classList.toggle("over", over);
  el.timelineNow.style.left = `${pct}%`;

  // Stats
  el.shiftLenValue.textContent = MTApi.formatMinutesAsHM(shiftMinutes);
  el.attendanceValue.textContent = `${monthSummary.attendancePct}%`;
  el.presentDaysValue.textContent = monthSummary.presentDays;
  el.workingDaysValue.textContent = monthSummary.workingDays;
  el.lateDaysValue.textContent = monthSummary.lateDays;
  if (el.otValue) el.otValue.textContent = monthSummary.OT;

  el.deptLabel.textContent = memberInfo.department || "";
  el.lastUpdated.textContent = `Updated ${formatClock(new Date())}`;

  // A full refresh always returns the calendar to the current month.
  currentCalendarDate = new Date();
  renderCalendar({ ...data, monthDate: currentCalendarDate });

  showState("main");
}

async function load() {
  showState("loading");
  el.refreshBtn.classList.add("spinning");

  try {
    let memberId;
    try {
      memberId = await getMemberId();
    } catch (detectErr) {
      console.error("[popup] member ID detection failed:", detectErr);
      const authErr = new Error("AUTH_REQUIRED");
      authErr.cause =
        detectErr && detectErr.message ? detectErr.message : String(detectErr);
      throw authErr;
    }

    currentMemberId = memberId;
    const data = await MTApi.fetchDashboardData(memberId);
    lastDashboardData = data;
    render(data);
  } catch (err) {
    console.error("[popup] load failed:", err);
    const detail =
      err && err.cause
        ? `${err.message} — ${err.cause}`
        : err
          ? err.message
          : "Unknown error";

    if (err && err.message === "AUTH_REQUIRED") {
      el.authDetail.textContent = err.cause ? `Detail: ${err.cause}` : "";
      showState("auth");
    } else {
      el.errorMsg.textContent =
        "Check your connection or try again in a moment.";
      el.errorDetail.textContent = `Detail: ${detail}`;
      showState("error");
    }
  } finally {
    el.refreshBtn.classList.remove("spinning");
  }
}

/** Smoothly ticks the hero "worked so far" value every second between
 *  the real 60s re-fetches, so seconds visibly move instead of jumping. */
function tickDisplay() {
  if (!lastFetchTimestamp || el.mainContent.classList.contains("hidden"))
    return;
  const elapsedMinutesSinceFetch = lastIsCurrentlyIn
    ? (Date.now() - lastFetchTimestamp) / 60000
    : 0;
  const liveWorkedMinutes = lastFetchedWorkedMinutes + elapsedMinutesSinceFetch;
  el.workedValue.textContent = formatWorkedWithSeconds(liveWorkedMinutes);

  const liveRemainingMinutes = lastFetchedRemainingMinutes - elapsedMinutesSinceFetch;
  el.remainingTimeLabel.textContent = formatWorkedWithSeconds(liveRemainingMinutes);

  // Keep the toolbar badge in lockstep with the popup while it's open.
  if (lastBadgeSnapshot) MTApi.renderBadgeFromSnapshot(lastBadgeSnapshot);
}

/** Moves the calendar to the previous/next month and fetches that month's
 *  records on demand — only the month actually being looked at is ever
 *  fetched, never the whole year up front. */
async function navigateMonth(delta) {
  if (calendarNavBusy || !currentMemberId) return;
  calendarNavBusy = true;
  el.calPrevBtn.disabled = true;
  el.calNextBtn.disabled = true;

  const targetDate = new Date(
    currentCalendarDate.getFullYear(),
    currentCalendarDate.getMonth() + delta,
    1
  );

  try {
    const monthRecords = await MTApi.getMonthRecords(currentMemberId, targetDate);
    currentCalendarDate = targetDate;
    renderCalendar({
      monthRecords,
      shiftMinutes: lastDashboardData ? lastDashboardData.shiftMinutes : 0,
      workedMinutesSoFar: lastDashboardData ? lastDashboardData.workedMinutesSoFar : 0,
      remainingMinutes: lastDashboardData ? lastDashboardData.remainingMinutes : 0,
      targetReached: lastDashboardData ? lastDashboardData.targetReached : false,
      monthDate: targetDate,
    });
  } catch (err) {
    console.error("[popup] month navigation failed:", err);
  } finally {
    calendarNavBusy = false;
    el.calPrevBtn.disabled = false;
    el.calNextBtn.disabled = false;
  }
}

el.calPrevBtn.addEventListener("click", () => navigateMonth(-1));
el.calNextBtn.addEventListener("click", () => navigateMonth(1));

el.refreshBtn.addEventListener("click", load);
el.retryBtn.addEventListener("click", load);

load();

setInterval(load, 5 * 60 * 1000); // real re-fetch every 5 min
setInterval(tickDisplay, 1000); // smooth per-second UI tick between fetches
