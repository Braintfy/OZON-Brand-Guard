// OZON Brand Guard — Background Service Worker
// Автор: firayzer (https://t.me/firayzer)

const ALARM_NAME = 'obg-schedule';

// ── State ──
let isRunning = false;

// ── Message handling ──
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  switch (msg.action) {
    case 'getStatus':
      sendResponse({ running: isRunning });
      return true;

    case 'setRunning':
      isRunning = msg.running;
      break;

    case 'updateSchedule':
      updateSchedule(msg.config);
      break;

    case 'logComplaint':
      addLogEntry(msg.entry);
      break;

    case 'showNotification':
      showNotification(msg.title, msg.message);
      break;

    case 'getConfig':
      chrome.storage.local.get('obgConfig', (result) => {
        sendResponse(result.obgConfig || null);
      });
      return true;

    // Relay messages from content script to all extension pages (popup/detached window)
    case 'scanBrandsResult':
    case 'updateStats':
    case 'done':
    case 'logUpdate':
    case 'techLog':
      relayToExtensionPages(msg);
      break;
  }
});

// Relay message to all open extension pages (popup, detached window)
function relayToExtensionPages(msg) {
  chrome.runtime.sendMessage(msg).catch(() => {
    // No listeners — popup may be closed, ignore
  });
}

// ── Scheduling ──
function updateSchedule(config) {
  chrome.alarms.clear(ALARM_NAME);

  if (config && config.scheduleEnabled) {
    chrome.alarms.create(ALARM_NAME, {
      periodInMinutes: config.scheduleInterval * 60
    });
    console.log('[OBG] Schedule set: every', config.scheduleInterval, 'hours');
  } else {
    console.log('[OBG] Schedule disabled');
  }
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== ALARM_NAME) return;
  if (isRunning) {
    console.log('[OBG] Already running, skipping scheduled run');
    return;
  }

  console.log('[OBG] Scheduled run triggered');

  const config = await getConfig();
  if (!config) return;

  // Find OZON seller tab or create one
  const tabs = await chrome.tabs.query({ url: 'https://seller.ozon.ru/app/brand/sellers*' });

  if (tabs.length > 0) {
    // Use existing tab
    chrome.tabs.update(tabs[0].id, { active: true });
    setTimeout(() => {
      chrome.tabs.sendMessage(tabs[0].id, { action: 'start', config });
    }, 2000);
  } else {
    // Open new tab
    const tab = await chrome.tabs.create({ url: 'https://seller.ozon.ru/app/brand/sellers' });
    // Wait for page to load
    chrome.tabs.onUpdated.addListener(function listener(tabId, info) {
      if (tabId === tab.id && info.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        setTimeout(() => {
          chrome.tabs.sendMessage(tab.id, { action: 'start', config });
        }, 3000);
      }
    });
  }
});

// ── Logging ──
async function addLogEntry(entry) {
  const config = await getConfig();
  if (!config) return;

  if (!config.log) config.log = [];
  config.log.push(entry);

  // Keep last 5000 entries
  if (config.log.length > 5000) {
    config.log = config.log.slice(-5000);
  }

  await chrome.storage.local.set({ obgConfig: config });
}

// ── Notifications ──
function showNotification(title, message) {
  chrome.notifications.create({
    type: 'basic',
    iconUrl: '../assets/icon-128.png',
    title: title || 'OZON Brand Guard',
    message: message
  });
}

// ── Helpers ──
async function getConfig() {
  return new Promise((resolve) => {
    chrome.storage.local.get('obgConfig', (result) => {
      resolve(result.obgConfig || null);
    });
  });
}

// ── Init on install ──
chrome.runtime.onInstalled.addListener(async () => {
  console.log('[OBG] Extension installed');

  const config = await getConfig();
  if (config && config.scheduleEnabled) {
    updateSchedule(config);
  }
});

// ── Restore schedule on startup ──
chrome.runtime.onStartup.addListener(async () => {
  const config = await getConfig();
  if (config && config.scheduleEnabled) {
    updateSchedule(config);
  }
});
