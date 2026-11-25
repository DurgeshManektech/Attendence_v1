// api.js — talks to MTWorks DataService.asmx directly, same endpoints the
// inout-summary.aspx / inout-detail.aspx pages themselves use. Relies on
// the user's existing logged-in session cookie (credentials: 'include').

const BASE_URL = "http://mtworks.manektech.com";

function pad2(n) {
  return n.toString().padStart(2, "0");
}

function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function firstOfMonthMDY(date = new Date()) {
  return `${date.getMonth() + 1}/1/${date.getFullYear()}`;
}

function daysInMonth(month, year) {
  // month is 1-based here to match getDaysInMonth() in the original page
  return new Date(year, month, 0).getDate();
}

/**
 * Auto-detects the CURRENTLY LOGGED-IN user's own member ID by fetching
 * inout-summary.aspx and reading the hidden field the server renders
 * per-session:
 *   <input type="hidden" id="content_hdnMemberId" value="6552" />
 * This is what makes the extension work correctly for every person who
 * installs it, instead of always showing one hardcoded person's data.
 */
async function detectLoggedInMemberId() {
  let res;
  try {
    res = await fetch(`${BASE_URL}/inout-summary.aspx`, {
      method: "GET",
      credentials: "include",
    });
  } catch (networkErr) {
    throw new Error(`NETWORK_ERROR detecting member ID: ${networkErr.message}`);
  }

  if (res.status === 0 || res.type === "opaqueredirect") {
    throw new Error(
      "REDIRECTED while detecting member ID (likely not logged in)"
    );
  }
  if (!res.ok) {
    throw new Error(`HTTP_${res.status} while detecting member ID`);
  }

  const html = await res.text();

  // Look for: id="content_hdnMemberId" ... value="6552"  (attribute order
  // can vary, so match value= either before or after the id=).
  let match = html.match(
    /id=["']content_hdnMemberId["']\s+value=["'](\d+)["']/i
  );
  if (!match) {
    match = html.match(
      /value=["'](\d+)["']\s+name=["']ctl00\$content\$hdnMemberId["']/i
    );
  }
  if (!match) {
    match = html.match(
      /name=["']ctl00\$content\$hdnMemberId["'][^>]*value=["'](\d+)["']/i
    );
  }

  if (!match) {
    const err = new Error("Could not find content_hdnMemberId in page HTML");
    err.cause =
      "Page structure may have changed, or the response was a login page";
    throw err;
  }

  return match[1];
}

/** Formats a Date as "Jul 29 2026" — the format InOutSelectByDateAsc expects. */
function dateToMonDDYYYY(date = new Date()) {
  const months = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  return `${months[date.getMonth()]} ${date.getDate()} ${date.getFullYear()}`;
}

/** Parses "07/29/2026 12:41 PM" style datetime strings into a Date. */
function parsePunchDateTime(str) {
  if (!str) return null;
  const d = new Date(str);
  return isNaN(d.getTime()) ? null : d;
}

async function callAsmx(method, bodyObj) {
  let res;
  try {
    res = await fetch(`${BASE_URL}/DataService.asmx/${method}`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify(bodyObj),
    });
  } catch (networkErr) {
    // Most commonly: host_permissions missing, network down, or the
    // extension isn't allowed to reach an http:// (non-https) origin.
    throw new Error(`NETWORK_ERROR calling ${method}: ${networkErr.message}`);
  }

  if (res.status === 0 || res.type === "opaqueredirect") {
    throw new Error(
      `REDIRECTED calling ${method} (likely bounced to a login page)`
    );
  }
  if (!res.ok) {
    let bodySnippet = "";
    try {
      bodySnippet = (await res.text()).slice(0, 200);
    } catch {}
    throw new Error(
      `HTTP_${res.status} calling ${method}${bodySnippet ? `: ${bodySnippet}` : ""}`
    );
  }

  const data = await res.json();
  // ASMX wraps the real payload as a JSON *string* inside "d"
  if (data && typeof data.d === "string") {
    try {
      return JSON.parse(data.d);
    } catch {
      return data.d;
    }
  }
  return data ? data.d : null;
}

/**
 * Lightweight "did we get a 200 at all" ping. NOTE: GetMemberID returns
 * text/xml, not JSON, so we don't attempt to parse it as JSON here. Real
 * auth gating happens via MemberSelect in fetchDashboardData, since that's
 * the endpoint we know behaves correctly and returns real JSON.
 */
async function checkSession() {
  try {
    const res = await fetch(`${BASE_URL}/DataService.asmx/GetMemberID`, {
      method: "GET",
      credentials: "include",
    });
    return res.ok;
  } catch {
    return null;
  }
}

/**
 * Member's shift info: shift time string (e.g. "12 PM to 9 PM"),
 * department, join date, gender.
 */
async function getMemberInfo(memberId) {
  const json = await callAsmx("MemberSelect", { memberID: String(memberId) });
  if (!json || typeof json !== "object") {
    const err = new Error("MemberSelect returned empty/non-object response");
    err.cause = `raw response: ${JSON.stringify(json)}`;
    throw err;
  }
  return {
    shiftTimeRaw: json.ShiftTime,
    department: json.DepartmentName,
    joinDate: json.JoinDate,
    gender: json.Gender,
  };
}

/**
 * Parses shift time strings shaped like "12 PM to 9 PM" (real format seen
 * in production) into { durationMinutes, startHour, startMinute }.
 * Falls back gracefully for older "8:15" style values just in case some
 * accounts still show that format.
 *
 * NOTE: durationMinutes here reflects the *scheduled window* (includes
 * unpaid break) and is only used as a fallback for expected-out-time
 * when there's no real punch-in yet today. The actual worked-shift
 * duration used everywhere else is the fixed WORK_SHIFT_MINUTES below.
 */
function parseShiftTime(shiftTimeRaw) {
  const DEFAULT = {
    durationMinutes: 8 * 60 + 15,
    startHour: null,
    startMinute: null,
  };
  if (!shiftTimeRaw) return DEFAULT;

  const str = String(shiftTimeRaw).trim();

  // Format: "12 PM to 9 PM" / "9:30 AM to 6:30 PM" etc.
  const rangeMatch = str.match(
    /(\d{1,2})(?::(\d{2}))?\s*(AM|PM)\s*to\s*(\d{1,2})(?::(\d{2}))?\s*(AM|PM)/i
  );
  if (rangeMatch) {
    const [, sH, sM, sAmPm, eH, eM, eAmPm] = rangeMatch;
    const to24 = (h, ampm) => {
      h = parseInt(h, 10) % 12;
      if (/pm/i.test(ampm)) h += 12;
      return h;
    };
    const startHour = to24(sH, sAmPm);
    const startMinute = sM ? parseInt(sM, 10) : 0;
    const endHour = to24(eH, eAmPm);
    const endMinute = eM ? parseInt(eM, 10) : 0;

    let durationMinutes =
      endHour * 60 + endMinute - (startHour * 60 + startMinute);
    if (durationMinutes <= 0) durationMinutes += 24 * 60; // handles overnight shifts

    return { durationMinutes, startHour, startMinute };
  }

  // Fallback format: "8:15" meaning shift *duration*, not a time range.
  const durationMatch = str.match(/^(\d{1,2}):(\d{2})$/);
  if (durationMatch) {
    const h = parseInt(durationMatch[1], 10);
    const m = parseInt(durationMatch[2], 10);
    return { durationMinutes: h * 60 + m, startHour: null, startMinute: null };
  }

  console.warn("[MTApi] Unrecognized ShiftTime format:", shiftTimeRaw);
  return DEFAULT;
}

/**
 * Fetches today's individual in/out punches (mirrors the inout-detail.aspx
 * modal's own call: InOutSelectByDateAsc) and derives: first in-time, total
 * worked minutes so far (summing each in→out gap, treating an open last
 * punch as in→now), and whether the user is currently clocked in.
 */
async function getTodayPunches(memberId, date = new Date()) {
  const json = await callAsmx("InOutSelectByDateAsc", {
    memberID: String(memberId),
    inDateTime: dateToMonDDYYYY(date),
  });

  const punches = Array.isArray(json) ? json : [];
  if (!punches.length) return null;

  const firstInTime = parsePunchDateTime(punches[0].InTime);
  let totalWorkedMinutes = 0;
  let totalBreakMinutes = 0;
  let isCurrentlyIn = false;

  for (let i = 0; i < punches.length; i++) {
    const p = punches[i];
    const inT = parsePunchDateTime(p.InTime);
    const outT = parsePunchDateTime(p.OutTime);
    if (!inT) continue;

    if (outT) {
      totalWorkedMinutes += (outT.getTime() - inT.getTime()) / 60000;

      // Gap between this punch's out and the NEXT punch's in = break time.
      const next = punches[i + 1];
      const nextIn = next ? parsePunchDateTime(next.InTime) : null;
      if (nextIn) {
        totalBreakMinutes += (nextIn.getTime() - outT.getTime()) / 60000;
      }
    } else {
      totalWorkedMinutes += (Date.now() - inT.getTime()) / 60000;
      isCurrentlyIn = true;
    }
  }

  return {
    firstInTime,
    totalWorkedMinutes,
    totalBreakMinutes,
    isCurrentlyIn,
    punches,
  };
}

/**
 * Full month's in/out records — used to derive lateness and month-to-date
 * attendance stats. (No longer relied on for today's in-time/worked-minutes;
 * getTodayPunches is the source of truth for those now.)
 */
async function getMonthRecords(memberId, date = new Date()) {
  const json = await callAsmx("InOutSelectByMonth", {
    memberID: String(memberId),
    firstDay: firstOfMonthMDY(date),
    isActive: true,
    contextMemberID: Number(memberId),
    contextRoleID: 0,
  });
  if (json && json.error) throw new Error(json.error);
  return Array.isArray(json) ? json : [];
}

/**
 * Aggregates month records into stats: working days, present days,
 * attendance %, late days, OT, and today's raw record if present.
 */
function summarizeMonth(records, shiftMinutes) {
  const halfDayMin = Math.floor(shiftMinutes / 2); // ~4:07 for 8:15, close to original 4:15
  const today = todayISO();

  let presentDays = 0;
  let OT = 0;
  let lateDays = 0;
  let todayRecord = null;
  let nonWorking = 0;

  const totalDaysInMonth = records.length
    ? daysInMonth(
        new Date(records[0].CalendarDay).getMonth() + 1,
        new Date(records[0].CalendarDay).getFullYear()
      )
    : new Date().getDate();

  for (const r of records) {
    const isWeekend = r.WeekDay === "Saturday" || r.WeekDay === "Sunday";
    const isHoliday = r.Holiday && r.Holiday.length > 0;
    const inMin = parseInt(r.InMin, 10) || 0;
    const isLeaveApplied = r.IsLeaveApplied === "1" || r.IsLeaveApplied === 1;
    const hasWorkOnHoliday = ["0.25", "0.50", "1.00"].includes(
      r.WorkOnHolidayDays
    );

    if (r.CalendarDay === today) todayRecord = r;
    if (r.IsLate === "True" || r.IsLate === true) lateDays++;
    if (isWeekend || isHoliday) nonWorking++;

    // Work-on-holiday / OT day handling
    if (hasWorkOnHoliday) {
      if (r.WorkOnHolidayStatus === "1") {
        OT += parseFloat(r.WorkOnHolidayDays) || 0;
      }
      if (r.IsWorking == 1 && inMin >= halfDayMin && r.InTime) {
        const joinDate = new Date(r.JoinDate);
        const calDate = new Date(r.CalendarDay);
        if (joinDate <= calDate && !isWeekend && !isHoliday) {
          presentDays += 1;
        }
      }
      continue;
    }

    // Regular working day
    if ((isWeekend || isHoliday) && inMin === 0) {
      continue; // non-working day, no credit
    }

    if (r.IsWorking == 1 && inMin >= shiftMinutes) {
      if (!isWeekend && !isHoliday) presentDays += 1;
    } else if (r.IsWorking == 1 && inMin >= halfDayMin) {
      if (!isWeekend && !isHoliday) presentDays += 0.5;
    } else if (isLeaveApplied && parseFloat(r.LeaveDays) <= 0.5) {
      presentDays += 0.5;
    }
  }

  const workingDays = Math.max(totalDaysInMonth - nonWorking, 0);
  const attendancePct =
    workingDays > 0 ? Math.round((presentDays * 100) / workingDays) : 0;

  return { workingDays, presentDays, attendancePct, lateDays, OT, todayRecord };
}

function formatMinutesAsHM(totalMin) {
  const sign = totalMin < 0 ? "-" : "";
  const abs = Math.abs(Math.round(totalMin));
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  return `${sign}${pad2(h)}:${pad2(m)}`;
}

/** Parses a "HH:MM" / "H:MM" time-of-day string into a Date object for today. */
function timeStringToTodayDate(timeStr) {
  if (!timeStr) return null;
  const [h, m] = timeStr.split(":").map(Number);
  const d = new Date();
  d.setHours(h || 0, m || 0, 0, 0);
  return d;
}

/**
 * Fetches everything needed for the popup in one go.
 */
async function fetchDashboardData(memberId) {
  // Gate on MemberSelect — the one endpoint we know returns real JSON and
  // fails cleanly (rather than the unverified/XML GetMemberID endpoint).
  let memberInfo;
  try {
    memberInfo = await getMemberInfo(memberId);
  } catch (err) {
    console.error("[MTApi] MemberSelect failed:", err);
    const authErr = new Error("AUTH_REQUIRED");
    authErr.cause = err && err.message ? err.message : String(err);
    throw authErr;
  }

  if (
    !memberInfo ||
    (!memberInfo.department && !memberInfo.shiftTimeRaw && !memberInfo.joinDate)
  ) {
    const authErr = new Error("AUTH_REQUIRED");
    authErr.cause =
      "MemberSelect returned an empty/unexpected response (possibly a login redirect, or memberID mismatch)";
    throw authErr;
  }

  const [todayPunches, monthRecords] = await Promise.all([
    getTodayPunches(memberId).catch((err) => {
      console.warn("[MTApi] InOutSelectByDateAsc failed:", err);
      return null;
    }),
    getMonthRecords(memberId).catch((err) => {
      console.warn("[MTApi] InOutSelectByMonth failed:", err);
      return [];
    }),
  ]);

  const shiftInfo = parseShiftTime(memberInfo.shiftTimeRaw);
  const WORK_SHIFT_MINUTES = 495; // 8:15 actual working time — excludes unpaid break
  const shiftMinutes = WORK_SHIFT_MINUTES;
  const monthSummary = summarizeMonth(monthRecords, shiftMinutes);

  // Real in-time = first punch of the day, from actual punch data.
  let inTimeDate = todayPunches ? todayPunches.firstInTime : null;
  if (
    !inTimeDate &&
    monthSummary.todayRecord &&
    monthSummary.todayRecord.InTime
  ) {
    inTimeDate = timeStringToTodayDate(monthSummary.todayRecord.InTime);
  }

  const workedMinutesSoFar = todayPunches
    ? todayPunches.totalWorkedMinutes
    : monthSummary.todayRecord
      ? parseInt(monthSummary.todayRecord.InMin, 10) || 0
      : 0;

  const remainingMinutes = shiftMinutes - workedMinutesSoFar;
  const targetReached = remainingMinutes <= 0;
  const breakMinutesSoFar = todayPunches ? todayPunches.totalBreakMinutes : 0;

  let expectedOutDate = null;
  if (inTimeDate) {
    expectedOutDate = new Date(
      inTimeDate.getTime() + (shiftMinutes + breakMinutesSoFar) * 60000
    );
  } else if (shiftInfo.startHour !== null) {
    // Not clocked in yet today — show the scheduled shift window instead.
    const scheduledStart = new Date();
    scheduledStart.setHours(
      shiftInfo.startHour,
      shiftInfo.startMinute || 0,
      0,
      0
    );
    inTimeDate = scheduledStart;
    expectedOutDate = new Date(scheduledStart.getTime() + shiftMinutes * 60000);
  }

  return {
    memberInfo,
    shiftMinutes,
    shiftInfo,
    workedMinutesSoFar,
    remainingMinutes,
    targetReached,
    inTimeDate,
    expectedOutDate,
    isCurrentlyIn: todayPunches ? todayPunches.isCurrentlyIn : null,
    monthSummary,
    monthRecords,
    fetchedAt: new Date(),
    breakMinutesSoFar,
  };
}

// ---------------------------------------------------------------------------
// Toolbar badge — shared by popup.js and background.js so both always show
// the same number. The last fetch is saved as a small "snapshot"; the live
// remaining time is derived from it on demand, so the badge can count down
// every minute without hitting the server each time.
// ---------------------------------------------------------------------------

const BADGE_SNAPSHOT_KEY = "inout_badge_snapshot";

function makeBadgeSnapshot(data) {
  return {
    remainingMinutes: data.remainingMinutes,
    isCurrentlyIn: !!data.isCurrentlyIn,
    fetchedAt: Date.now(),
  };
}

/** Remaining shift minutes right now. Only counts down while clocked in. */
function liveRemainingMinutes(snapshot, now = Date.now()) {
  if (!snapshot) return null;
  const elapsed = snapshot.isCurrentlyIn ? (now - snapshot.fetchedAt) / 60000 : 0;
  return snapshot.remainingMinutes - elapsed;
}

/** Sets the toolbar badge from a snapshot. Floors minutes so it matches the
 *  HH:MM part of the popup's HH:MM:SS countdown. */
function renderBadgeFromSnapshot(snapshot) {
  const remaining = liveRemainingMinutes(snapshot);
  if (remaining === null) {
    chrome.action.setBadgeText({ text: "" });
    return;
  }
  const targetReached = remaining <= 0;
  const wholeMinutes = Math.max(0, Math.floor(remaining));
  const hours = Math.floor(wholeMinutes / 60);
  const mins = wholeMinutes % 60;
  // Chrome badges only reliably show ~4 characters.
  const label = hours >= 10 ? `${hours}h` : `${hours}:${pad2(mins)}`;

  chrome.action.setBadgeText({ text: targetReached ? "✓" : label });
  chrome.action.setBadgeBackgroundColor({
    color: targetReached ? "#5ee6c4" : "#e7e8e9",
  });
  if (chrome.action.setBadgeTextColor) {
    chrome.action.setBadgeTextColor({ color: "#0a1512" });
  }
}

async function saveBadgeSnapshot(snapshot) {
  await chrome.storage.local.set({ [BADGE_SNAPSHOT_KEY]: snapshot });
}

async function loadBadgeSnapshot() {
  const stored = await chrome.storage.local.get(BADGE_SNAPSHOT_KEY);
  return stored[BADGE_SNAPSHOT_KEY] || null;
}

async function clearBadgeSnapshot() {
  await chrome.storage.local.remove(BADGE_SNAPSHOT_KEY);
}

// Exposed for popup.js / background.js (classic script, no ES modules in MV3 popup by default)
self.MTApi = {
  makeBadgeSnapshot,
  liveRemainingMinutes,
  renderBadgeFromSnapshot,
  saveBadgeSnapshot,
  loadBadgeSnapshot,
  clearBadgeSnapshot,
  BASE_URL,
  todayISO,
  formatMinutesAsHM,
  fetchDashboardData,
  detectLoggedInMemberId,
  checkSession,
  getMonthRecords,
};
