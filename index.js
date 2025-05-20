require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { WebcastPushConnection } = require('tiktok-live-connector');
const googleSheets = require('./googleSheets');
const notify = require('./notify');

const accounts = require('./accounts.json');

// Pastikan folder logs/ ada
if (!fs.existsSync(path.join(__dirname, 'logs'))){
  fs.mkdirSync(path.join(__dirname, 'logs'));
}

// Struktur untuk menyimpan data gift per akun
const liveData = {};
const CACHE_FILE = path.join(__dirname, 'live_cache.json');
const RETRY_INTERVAL_MIN = 15 * 60 * 1000; // 15 menit
const RETRY_INTERVAL_MAX = 60 * 60 * 1000; // 60 menit
const RETRY_INTERVAL_STEP = 5 * 60 * 1000; // 5 menit
let idleRetryCount = 0;
let currentRetryInterval = RETRY_INTERVAL_MIN;
let lastIdleDay = (new Date()).getDate();

// Load cache saat start
let cacheData = {};
if (fs.existsSync(CACHE_FILE)) {
  try {
    cacheData = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8'));
    Object.assign(liveData, cacheData);
    console.log('Cache live session loaded.');
  } catch (e) {
    console.error('Failed to load cache:', e);
  }
}

function saveCache() {
  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify(liveData, null, 2));
  } catch (e) {
    console.error('Failed to save cache:', e);
  }
}

function getAllIdle() {
  return Object.values(liveData).every(d => d && d.status === 'idle' && d.lastLive === false);
}

function resetIdleRetryIfNeeded() {
  const nowDay = (new Date()).getDate();
  if (nowDay !== lastIdleDay) {
    idleRetryCount = 0;
    currentRetryInterval = RETRY_INTERVAL_MIN;
    lastIdleDay = nowDay;
  }
}

function getJitteredInterval(base) {
  // Jitter ±2 menit (0-120000 ms)
  const jitter = Math.floor(Math.random() * 120000) - 60000;
  return Math.max(60000, base + jitter); // minimal 1 menit
}

function startMonitor(username) {
  const client = new WebcastPushConnection(username);
  liveData[username] = {
    startTime: null,
    gifts: {},
    jamMulai: null,
    jamSelesai: null,
    peakViewer: 0,
    status: 'idle',
    lastLive: false
  };

  client.on('connect', () => {
    liveData[username].status = 'connected';
    liveData[username].lastLive = true;
    // Log hanya saat akun benar-benar live
    console.log(`[${username}] LIVE started at ${new Date().toLocaleString('id-ID')}`);
  });

  client.on('disconnect', () => {
    liveData[username].status = 'idle';
    liveData[username].lastLive = false;
    // Log saat live berakhir
    console.log(`[${username}] LIVE ended at ${new Date().toLocaleString('id-ID')}`);
  });

  client.on('viewer', (data) => {
    // data.viewerCount
    if (data && typeof data.viewerCount === 'number') {
      if (data.viewerCount > liveData[username].peakViewer) {
        liveData[username].peakViewer = data.viewerCount;
      }
    }
  });

  client.on('gift', (giftData) => {
    // giftData: { userId, uniqueId, repeatCount, diamondCount }
    const userId = giftData.userId;
    const points = giftData.diamondCount || 0;
    if (!liveData[username].gifts[userId]) {
      liveData[username].gifts[userId] = {
        username: giftData.uniqueId,
        points: 0
      };
    }
    liveData[username].gifts[userId].points += points;
    // Log hanya saat ada gift
    console.log(`[${username}] received gift from ${giftData.uniqueId} with ${giftData.diamondCount || 0} points`);
    // Realtime: update Top Spender sheet
    const now = new Date();
    const topGivers = Object.values(liveData[username].gifts)
      .sort((a, b) => b.points - a.points)
      .slice(0, 10);
    const top10 = topGivers.map(g => ({ username: g.username, points: g.points }));
    googleSheets.appendTopSpenders({
      tanggal: now.toLocaleDateString('id-ID'),
      akun: username,
      top10
    });
    googleSheets.insertTopSpendersToSupabase({
      tanggal: now.toLocaleDateString('id-ID'),
      akun: username,
      top10
    });
    saveCache(); // Simpan cache setiap ada gift
  });

  client.on('liveEnd', () => {
    const endTime = Date.now();
    liveData[username].jamSelesai = new Date();
    const durasiMs = endTime - (liveData[username].startTime || endTime);
    const durasiJam = Math.floor(durasiMs / (1000 * 60 * 60));
    const durasiMenit = Math.floor((durasiMs % (1000 * 60 * 60)) / (1000 * 60));
    const durasiStr = `${durasiJam > 0 ? durasiJam + ' jam ' : ''}${durasiMenit} menit`;
    const topGivers = Object.values(liveData[username].gifts)
      .sort((a, b) => b.points - a.points)
      .slice(0, 10);
    const totalPoints = Object.values(liveData[username].gifts).reduce((sum, g) => sum + g.points, 0);
    const peakViewer = liveData[username].peakViewer || 0;
    googleSheets.appendLiveSummary({
      tanggal: liveData[username].jamMulai ? liveData[username].jamMulai.toLocaleDateString('id-ID') : '',
      jamMulai: liveData[username].jamMulai ? liveData[username].jamMulai.toTimeString().slice(0,5) : '',
      jamSelesai: liveData[username].jamSelesai ? liveData[username].jamSelesai.toTimeString().slice(0,5) : '',
      durasi: durasiStr,
      akun: username,
      totalDiamond: totalPoints,
      peakViewer
    });
    googleSheets.insertLiveSummaryToSupabase({
      tanggal: liveData[username].jamMulai ? liveData[username].jamMulai.toLocaleDateString('id-ID') : '',
      jamMulai: liveData[username].jamMulai ? liveData[username].jamMulai.toTimeString().slice(0,5) : '',
      jamSelesai: liveData[username].jamSelesai ? liveData[username].jamSelesai.toTimeString().slice(0,5) : '',
      durasi: durasiStr,
      akun: username,
      totalDiamond: totalPoints,
      peakViewer
    });
    googleSheets.insertTopSpendersToSupabase({
      tanggal: liveData[username].jamMulai ? liveData[username].jamMulai.toLocaleDateString('id-ID') : '',
      akun: username,
      top10: topGivers.map(g => ({ username: g.username, points: g.points }))
    });
    require('./notify').sendNotification({ username, duration: durasiStr, totalPoints, topGivers });
    // Setelah data dicatat, hapus cache akun ini
    delete liveData[username];
    saveCache();
    // Setelah live selesai, mulai polling ulang
    setTimeout(() => startMonitor(username), RETRY_INTERVAL_MIN);
  });

  client.on('error', (error) => {
    let errMsg = (error && error.message) ? error.message : (typeof error === 'string' ? error : JSON.stringify(error));
    // Log error hanya jika akun sedang live atau error berat
    if (liveData[username].status === 'connected' || (errMsg && (errMsg.includes('rate limit') || errMsg.includes('banned') || errMsg.includes('API Error')))) {
      console.error(`[${username}] error: ${errMsg}`);
    }
    fs.appendFileSync(path.join(__dirname, 'logs', `${username}-error.log`), `[${new Date().toISOString()}] ${errMsg}\n`);
    // Jika error karena user not found/tidak live, retry periodik
    if (error && error.message && (error.message.includes('user_not_found') || error.message.includes('Failed to retrieve room_id'))) {
      liveData[username].status = 'idle';
      liveData[username].lastLive = false;
      resetIdleRetryIfNeeded();
      if (getAllIdle()) {
        idleRetryCount++;
        if (idleRetryCount % 3 === 0 && currentRetryInterval < RETRY_INTERVAL_MAX) {
          currentRetryInterval = Math.min(currentRetryInterval + RETRY_INTERVAL_STEP, RETRY_INTERVAL_MAX);
        }
      }
      setTimeout(() => startMonitor(username), getJitteredInterval(currentRetryInterval));
    } else {
      // Error lain: reconnect biasa
      liveData[username].status = 'idle';
      setTimeout(() => {
        if (liveData[username].status !== 'connecting' && liveData[username].status !== 'connected') {
          liveData[username].status = 'connecting';
          client.connect().catch(() => {});
        }
      }, 3000);
      // Jika error fatal (rate limit, banned, API Error berat), kirim notifikasi sekali saja
      if (error && error.message && (
        error.message.includes('rate limit') ||
        error.message.includes('banned') ||
        error.message.includes('API Error')
      )) {
        notify.sendErrorNotification(`[${username}] ${errMsg}`);
      }
    }
  });

  // --- Tambahan: tangani error async connect agar tidak crash ---
  (async () => {
    if (liveData[username].status === 'connecting' || liveData[username].status === 'connected') return;
    liveData[username].status = 'connecting';
    try {
      await client.connect();
    } catch (err) {
      liveData[username].status = 'idle';
      liveData[username].lastLive = false;
      resetIdleRetryIfNeeded();
      if (getAllIdle()) {
        idleRetryCount++;
        if (idleRetryCount % 3 === 0 && currentRetryInterval < RETRY_INTERVAL_MAX) {
          currentRetryInterval = Math.min(currentRetryInterval + RETRY_INTERVAL_STEP, RETRY_INTERVAL_MAX);
        }
      }
      setTimeout(() => startMonitor(username), getJitteredInterval(currentRetryInterval));
    }
  })();
}

accounts.forEach(username => {
  startMonitor(username);
});
