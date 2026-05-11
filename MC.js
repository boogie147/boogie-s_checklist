/**
 * Combined MC Tracker & Incident Report Function
 * Version: 2.2 (Standardized Permanent Status Formatting for Merged Entries)
 */
function processLatestEntryCombined_text() {
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(30000); 
  } catch (e) {
    Logger.log('Could not obtain lock: ' + e);
    return;
  }

  const ss = SpreadsheetApp.openById("16h-93Uf9NLgflhoJZgMaIGEsllmxF5qIGOTR0NHYS0U");
  const sheet = ss.getSheetByName("Form Responses 1");
  const data = sheet.getDataRange().getValues();
  const lastRowIdx = data.length;
  const lastRow = data[lastRowIdx - 1];

  // --- Shared Mapping ---
  const name = lastRow[1].toString().toUpperCase();
  const rank = lastRow[2].toString().toUpperCase();
  const method = lastRow[3] || ""; 
  const reason = (lastRow[4] || "No Reason Provided").toString().trim();
  const location = lastRow[5] || "Medical Center";
  
  const timestamp = Utilities.formatDate(new Date(lastRow[0]), "Asia/Singapore", "ddMMyy");
  const timeStr = Utilities.formatDate(new Date(lastRow[0]), "Asia/Singapore", "HHmm");
  const actionText = (method.toUpperCase() === "MA") ? "went for MA" : "reported sick";

  /**
   * HELPER FUNCTION: Formats status for both Dashboard and Report
   * This ensures "Permanent" logic is applied consistently.
   */
  const formatStatusEntry = (statusName, startDate, endDate) => {
    const sName = statusName || "";
    const sNameUpper = sName.toUpperCase();
    const isPerm = sNameUpper.includes("PERM") || sNameUpper.includes("PERMANENT");
    const isNoStatus = sNameUpper === "NO STATUS" || !startDate || !endDate;

    if (isNoStatus) {
      return { dash: `• <code>NO STATUS</code>`, report: `no status` };
    }

    const startDash = Utilities.formatDate(new Date(startDate), "Asia/Singapore", "dd MMM yy");
    const endDash = Utilities.formatDate(new Date(endDate), "Asia/Singapore", "dd MMM yy");
    const sStart = Utilities.formatDate(new Date(startDate), "Asia/Singapore", "ddMMyy");
    const sEnd = Utilities.formatDate(new Date(endDate), "Asia/Singapore", "ddMMyy");

    if (isPerm) {
      return {
        dash: `• <code>${sNameUpper}</code>`,
        report: `${sName} from ${sStart}`
      };
    } else {
      const duration = Math.ceil(Math.abs(new Date(endDate) - new Date(startDate)) / (1000 * 60 * 60 * 24)) + 1;
      return {
        dash: `• <code>${sNameUpper}</code> (${startDash} — ${endDash})`,
        report: `${duration} day(s) ${sName} from ${sStart} to ${sEnd} (inclusive)`
      };
    }
  };

  // --- Process Current Row ---
  const currentFormat = formatStatusEntry(lastRow[6], lastRow[7], lastRow[8]);
  let dashStatuses = [currentFormat.dash];
  let reportStatuses = [currentFormat.report];

  // --- LOOKBACK & MERGE LOGIC ---
  let targetMsgIdDash = null;
  let targetMsgIdReport = null;
  const isNoStatusCurrent = (lastRow[6] || "").toUpperCase() === "NO STATUS";

  if (!isNoStatusCurrent) {
    for (let i = data.length - 2; i >= Math.max(0, data.length - 15); i--) {
      const prevRow = data[i];
      const timeDiffMins = (new Date(lastRow[0]) - new Date(prevRow[0])) / (1000 * 60);

      if (prevRow[1].toString().toUpperCase() === name && timeDiffMins > 0.1 && timeDiffMins < 60) {
        if (prevRow[6].toUpperCase() === "NO STATUS") continue;

        targetMsgIdDash = prevRow[10]; 
        targetMsgIdReport = prevRow[11]; 

        // Apply the SAME helper function to previous rows
        const prevFormat = formatStatusEntry(prevRow[6], prevRow[7], prevRow[8]);
        dashStatuses.unshift(prevFormat.dash);
        reportStatuses.unshift(prevFormat.report);
      } else if (prevRow[1].toString().toUpperCase() !== name && timeDiffMins < 60) {
        continue;
      } else {
        break; 
      }
    }
  }

  // --- OUTPUT 1: DASHBOARD ALERT ---
  const dashMessage = `<b>📋 NEW ENTRY RECEIVED</b>\n\n` +
                      `👤 <b>Personnel:</b> ${rank} ${name}\n\n` +
                      `🔍 <b>Reason:</b> ${reason}\n\n` +
                      `🩺 <b>Status:</b>\n${dashStatuses.join('\n')}\n\n` +
                      `⚙️ <b>Method:</b> <code>${method.toUpperCase()}</code>`;

  // [Rest of your Telegram Sending Logic remains the same...]
  const token = '8551508429:AAFxq9njGmJnM-3wTMn4_TXK3PuTEniC540';
  const dashChatId = "-1003852714517";
  //const dashChatId = "-1003762341308"; // test
  const reportChatId = "-1003578168227"; 
  //const reportChatId = "-1003936129132"; // test 
  const apiUrl = `https://api.telegram.org/bot${token}/`;

  let resDashData;
  try {
    const dashEndpoint = targetMsgIdDash ? "editMessageText" : "sendMessage";
    const dashPayload = { "chat_id": dashChatId, "text": dashMessage, "parse_mode": "HTML" };
    if (targetMsgIdDash) dashPayload.message_id = targetMsgIdDash;
    const resDash = UrlFetchApp.fetch(apiUrl + dashEndpoint, { "method": "post", "contentType": "application/json", "payload": JSON.stringify(dashPayload), "muteHttpExceptions": true });
    resDashData = JSON.parse(resDash.getContentText());
    if (!resDashData.ok && targetMsgIdDash) {
      const retry = UrlFetchApp.fetch(apiUrl + "sendMessage", { "method": "post", "contentType": "application/json", "payload": JSON.stringify({ "chat_id": dashChatId, "text": dashMessage, "parse_mode": "HTML" }), "muteHttpExceptions": true });
      resDashData = JSON.parse(retry.getContentText());
    }
  } catch (e) { Logger.log("Dash Error: " + e); }

  // --- OUTPUT 2: FORMAL INCIDENT REPORT ---
  const reportMessage = 
    `<b>10 C4I Bn - Bravo Company Non-Training Related Incident Report</b>\n\n` +
    `Summary of Incident:\n\n` +
    `1. On ${timestamp} at ${timeStr} hrs, ${rank} ${name} ${actionText} at ${location} for ${reason}.\n\n` +
    `2. The serviceman was given ${reportStatuses.join(' and ')}.\n\n` +
    `3. ⁠The serviceman is vaccinated. There will be no further updates.`;

  try {
    const googleDriveLink = lastRow[9] || "";
    let resRepData;
    const hasMC = googleDriveLink && googleDriveLink.includes("id=");
    let editSuccessful = false;

    if (targetMsgIdReport) {
      const editMethod = hasMC ? "editMessageCaption" : "editMessageText";
      const editPayload = { "chat_id": reportChatId, "message_id": targetMsgIdReport, "caption": reportMessage, "text": reportMessage, "parse_mode": "HTML" };
      const res = UrlFetchApp.fetch(apiUrl + editMethod, { "method": "post", "contentType": "application/json", "payload": JSON.stringify(editPayload), "muteHttpExceptions": true });
      resRepData = JSON.parse(res.getContentText());
      if (resRepData.ok) editSuccessful = true;
    }

    if (!editSuccessful) {
      if (hasMC) {
        const fileId = googleDriveLink.split("id=")[1];
        const fileBlob = DriveApp.getFileById(fileId).getBlob();
        const formData = { "chat_id": reportChatId, "document": fileBlob, "caption": reportMessage, "parse_mode": "HTML" };
        const res = UrlFetchApp.fetch(apiUrl + "sendDocument", { "method": "post", "payload": formData, "muteHttpExceptions": true});
        resRepData = JSON.parse(res.getContentText());
      } else {
        const textPayload = { "chat_id": reportChatId, "text": reportMessage, "parse_mode": "HTML" };
        const res = UrlFetchApp.fetch(apiUrl + "sendMessage", { "method": "post", "contentType": "application/json", "payload": JSON.stringify(textPayload), "muteHttpExceptions": true});
        resRepData = JSON.parse(res.getContentText());
      }
    }

    if (resDashData && resDashData.ok && resRepData && resRepData.ok) {
      sheet.getRange(lastRowIdx, 11).setValue(resDashData.result.message_id); 
      sheet.getRange(lastRowIdx, 12).setValue(resRepData.result.message_id);  
    }
  } catch (err) { Logger.log("Report Error: " + err); }

  lock.releaseLock();
}
