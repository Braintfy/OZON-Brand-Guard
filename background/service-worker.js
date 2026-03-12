// OZON Brand Guard — Background Service Worker
// Автор: firayzer (https://t.me/firayzer)

const ALARM_SELLERS = 'obg-schedule';
const ALARM_PRODUCTS = 'obg-schedule-products';

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

    case 'updateProductSchedule':
      updateProductSchedule(msg.config);
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
    case 'updateProductStats':
    case 'done':
    case 'doneProducts':
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

// ── Scheduling — Sellers ──
function updateSchedule(config) {
  chrome.alarms.clear(ALARM_SELLERS);
  if (config && config.scheduleEnabled) {
    chrome.alarms.create(ALARM_SELLERS, { periodInMinutes: config.scheduleInterval * 60 });
    console.log('[OBG] Sellers schedule: every', config.scheduleInterval, 'hours');
  } else {
    console.log('[OBG] Sellers schedule disabled');
  }
}

// ── Scheduling — Products ──
function updateProductSchedule(config) {
  chrome.alarms.clear(ALARM_PRODUCTS);
  if (config && config.productScheduleEnabled) {
    chrome.alarms.create(ALARM_PRODUCTS, { periodInMinutes: config.productScheduleInterval * 60 });
    console.log('[OBG] Products schedule: every', config.productScheduleInterval, 'hours');
  } else {
    console.log('[OBG] Products schedule disabled');
  }
}

// ── Alarm handler (both sellers and products) ──
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== ALARM_SELLERS && alarm.name !== ALARM_PRODUCTS) return;
  if (isRunning) {
    console.log('[OBG] Already running, skipping scheduled run');
    return;
  }

  const config = await getConfig();
  if (!config) return;

  const isSellers = alarm.name === ALARM_SELLERS;
  const url = isSellers ? 'https://seller.ozon.ru/app/brand/sellers' : 'https://seller.ozon.ru/app/brand-products/all';
  const action = isSellers ? 'start' : 'startProducts';
  const scriptFile = isSellers ? 'content/content.js' : 'content/content-products.js';

  console.log('[OBG] Scheduled run:', isSellers ? 'sellers' : 'products');

  const tabs = await chrome.tabs.query({ url: url + '*' });

  if (tabs.length > 0) {
    chrome.tabs.update(tabs[0].id, { active: true });
    setTimeout(async () => {
      try {
        await chrome.scripting.executeScript({ target: { tabId: tabs[0].id }, files: [scriptFile] });
        await chrome.scripting.insertCSS({ target: { tabId: tabs[0].id }, files: ['content/content.css'] });
      } catch (e) { /* already injected */ }
      chrome.tabs.sendMessage(tabs[0].id, { action, config });
    }, 2000);
  } else {
    const tab = await chrome.tabs.create({ url });
    chrome.tabs.onUpdated.addListener(function listener(tabId, info) {
      if (tabId === tab.id && info.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        setTimeout(async () => {
          try {
            await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: [scriptFile] });
            await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ['content/content.css'] });
          } catch (e) { /* already injected */ }
          chrome.tabs.sendMessage(tab.id, { action, config });
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
  if (config) {
    if (config.scheduleEnabled) updateSchedule(config);
    if (config.productScheduleEnabled) updateProductSchedule(config);
  }
});

// ── Restore schedules on startup ──
chrome.runtime.onStartup.addListener(async () => {
  const config = await getConfig();
  if (config) {
    if (config.scheduleEnabled) updateSchedule(config);
    if (config.productScheduleEnabled) updateProductSchedule(config);
  }
});
