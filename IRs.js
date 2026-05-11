const SS_ID = "16h-93Uf9NLgflhoJZgMaIGEsllmxF5qIGOTR0NHYS0U";
const BOT_TOKEN = "8551508429:AAFxq9njGmJnM-3wTMn4_TXK3PuTEniC540";

function doPost(e) {
  try {
    const contents = JSON.parse(e.postData.contents);
    
    // 1. Handle Command
    if (contents.message && contents.message.text) {
      const text = contents.message.text;
      const chatId = contents.message.chat.id;
      if (text.startsWith('/getir')) {
        const query = text.replace('/getir', '').trim().toUpperCase();
        handleSearch(chatId, query);
      }
    }

    // 2. Handle Button Click
    if (contents.callback_query) {
      const chatId = contents.callback_query.message.chat.id;
      const callbackData = contents.callback_query.data;

      if (callbackData.startsWith('pull_')) {
        const rowIdx = parseInt(callbackData.split('_')[1]);
        const sheet = SpreadsheetApp.openById(SS_ID).getSheetByName("Form Responses 1");
        const data = sheet.getDataRange().getValues();
        const selectedRow = data[rowIdx - 1];
        const reportId = selectedRow[11]; // Column L
        
        let reportStatuses = [];
        let googleDriveLink = "";
        let main = { ts: selectedRow[0], rnk: selectedRow[2], nm: selectedRow[1], meth: selectedRow[3], reas: selectedRow[4], loc: selectedRow[5] };

        // MERGE LOGIC
        data.forEach((row) => {
          if (row[11] == reportId) {
            const type = row[6], start = row[7], end = row[8];
            const isNoStatus = !type || type.toString().trim() === "" || !start || !end || type.toString().toUpperCase() === "NO STATUS";
            
            if (!isNoStatus) reportStatuses.push(formatStatusForReport(type, start, end));
            if (!googleDriveLink && row[9] && row[9].toString().includes("http")) googleDriveLink = row[9].toString();
          }
        });

        const statusText = reportStatuses.length > 0 ? reportStatuses.join(' and ') : "no status";
        const dateStr = Utilities.formatDate(new Date(main.ts), "Asia/Singapore", "ddMMyy");
        const timeStr = Utilities.formatDate(new Date(main.ts), "Asia/Singapore", "HHmm");
        const actionText = (main.meth && main.meth.toString().toUpperCase() === "MA") ? "went for MA" : "reported sick";

        const finalReport = 
          `<b>10 C4I Bn - Bravo Company Non-Training Related Incident Report</b>\n\n` +
          `Summary of Incident:\n\n` +
          `1. On ${dateStr} at ${timeStr} hrs, ${main.rnk.toUpperCase()} ${main.nm.toUpperCase()} ${actionText} at ${main.loc || "Medical Center"} for ${main.reas || "No Reason Provided"}.\n\n` +
          `2. The serviceman was given ${statusText}.\n\n` +
          `3. ⁠The serviceman is vaccinated. There will be no further updates.`;

        let fileSent = false;
        if (googleDriveLink) {
          try {
            const match = googleDriveLink.match(/[-\w]{25,}/);
            if (match) {
              const fileId = match[0];
              const blob = DriveApp.getFileById(fileId).getBlob();
              // SEND DOCUMENT
              const res = sendDocument(chatId, blob, finalReport);
              if (res.getResponseCode() === 200) fileSent = true;
            }
          } catch (e) { /* Fallback to text if Drive fails */ }
        }

        if (!fileSent) sendMessage(chatId, finalReport);
      }
    }
  } catch (err) {
    // If it fails, try to send the error to the chat where the command was used
    // instead of a hardcoded Admin ID
  }
}

// --- UPDATED SEND DOCUMENT HELPER ---
function sendDocument(chatId, blob, caption) {
  const payload = {
    "chat_id": chatId.toString(),
    "document": blob,
    "caption": caption,
    "parse_mode": "HTML"
  };
  
  const options = {
    "method": "post",
    "payload": payload, // Do NOT use JSON.stringify for blobs
    "muteHttpExceptions": true
  };
  
  return UrlFetchApp.fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendDocument`, options);
}

// --- OTHER HELPERS ---
function formatStatusForReport(statusName, startDate, endDate) {
  const sName = statusName.toString();
  const sNameUpper = sName.toUpperCase();
  const isPerm = sNameUpper.includes("PERM") || sNameUpper.includes("PERMANENT");
  const sStart = Utilities.formatDate(new Date(startDate), "Asia/Singapore", "ddMMyy");
  const sEnd = Utilities.formatDate(new Date(endDate), "Asia/Singapore", "ddMMyy");
  if (isPerm) return `${sName} from ${sStart}`;
  const duration = Math.ceil(Math.abs(new Date(endDate) - new Date(startDate)) / (1000 * 60 * 60 * 24)) + 1;
  return `${duration} day(s) ${sName} from ${sStart} to ${sEnd} (inclusive)`;
}

function handleSearch(chatId, query) {
  // --- ADD THIS CHECK AT THE TOP ---
  const cleanQuery = query ? query.trim().toUpperCase() : "";

  if (!cleanQuery || cleanQuery.length === 0) {
    const usageMsg = "<b>💡 How to use /getir:</b>\n\n" +
                     "Type <code>/getir NAME</code> to search for a specific person.\n\n" +
                     "Note: Use at least 2 characters for better accuracy.";
    return sendMessage(chatId, usageMsg);
  }

  // --- REST OF THE FUNCTION REMAINS THE SAME ---
  const sheet = SpreadsheetApp.openById(SS_ID).getSheetByName("Form Responses 1");
  const data = sheet.getDataRange().getValues();
  let matches = [];
  let seenIds = new Set();
  
  if (cleanQuery.length < 2) {
    return sendMessage(chatId, "⚠️ Please enter at least 2 characters for a more precise search.");
  }

  for (let i = data.length - 1; i >= 1; i--) {
    const nameInSheet = data[i][1].toString().toUpperCase();
    const reportId = data[i][11];

    const nameWords = nameInSheet.split(" ");
    const isMatch = nameInSheet.startsWith(cleanQuery) || 
                    nameWords.some(word => word.startsWith(cleanQuery));

    if (isMatch) {
      if (reportId && seenIds.has(reportId)) continue;
      if (reportId) seenIds.add(reportId);
      
      matches.push({ 
        row: i + 1, 
        date: data[i][0], 
        reason: data[i][4] || "Status Update",
        name: nameInSheet
      });
    }
  }

  if (matches.length === 0) return sendMessage(chatId, `No records found for "${query}".`);

  const buttons = matches.slice(0, 5).map(m => [{ 
    text: `${Utilities.formatDate(new Date(m.date), "GMT+8", "dd/MM/yyy")} - ${m.name} (${m.reason})`, 
    callback_data: `pull_${m.row}` 
  }]);

  sendKeyboard(chatId, `Results for <b>${query}</b>:`, buttons);
}

function sendMessage(chatId, text) {
  const payload = { "chat_id": chatId, "text": text, "parse_mode": "HTML" };
  UrlFetchApp.fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, { "method": "post", "contentType": "application/json", "payload": JSON.stringify(payload) });
}

function sendKeyboard(chatId, text, buttons) {
  const payload = { "chat_id": chatId, "text": text, "parse_mode": "HTML", "reply_markup": { "inline_keyboard": buttons } };
  UrlFetchApp.fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, { "method": "post", "contentType": "application/json", "payload": JSON.stringify(payload) });
}
