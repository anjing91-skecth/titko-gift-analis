require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { WebcastPushConnection } = require('tiktok-live-connector');
const googleSheets = require('./googleSheets');
const notify = require('./notify');
const { v4: uuidv4 } = require('uuid');

const accounts = require('./accounts.json');

// Pastikan folder logs/ ada
if (!fs.existsSync(path.join(__dirname, 'logs'))){
  fs.mkdirSync(path.join(__dirname, 'logs'));
}

// Struktur untuk menyimpan data gift per akun
const liveData = {};
const topSpenderCache = {};
const liveSummaryCache = {};
const CACHE_FILE = path.join(__dirname, 'live_cache.json');
const TOP_SPENDER_CACHE_FILE = path.join(__dirname, 'top_spender_cache.json');
const LIVE_SUMMARY_CACHE_FILE = path.join(__dirname, 'live_summary_cache.json');

// Retry interval management
const RETRY_INTERVAL_MIN = 15 * 60 * 1000; // 15 menit
const RETRY_INTERVAL_MAX = 60 * 60 * 1000; // 60 menit
const RETRY_INTERVAL_STEP = 5 * 60 * 1000; // 5 menit
let idleRetryCount = 0;
let currentRetryInterval = RETRY_INTERVAL_MIN;
let lastIdleDay = (new Date()).getDate();

// Load cache saat start
let cacheData = {};
let topSpenderData = {};
let liveSummaryData = {};

if (fs.existsSync(TOP_SPENDER_CACHE_FILE)) {
  try {
    topSpenderData = JSON.parse(fs.readFileSync(TOP_SPENDER_CACHE_FILE, 'utf-8'));
    Object.assign(topSpenderCache, topSpenderData);
    console.log('Top spender cache loaded.');
  } catch (e) {
    console.error('Failed to load top spender cache:', e);
  }
}

if (fs.existsSync(CACHE_FILE)) {
  try {
    cacheData = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8'));
    Object.assign(liveData, cacheData);
    console.log('Cache live session loaded.');
  } catch (e) {
    console.error('Failed to load cache:', e);
  }
}

if (fs.existsSync(LIVE_SUMMARY_CACHE_FILE)) {
  try {
    liveSummaryData = JSON.parse(fs.readFileSync(LIVE_SUMMARY_CACHE_FILE, 'utf-8'));
    Object.assign(liveSummaryCache, liveSummaryData);
    console.log('Live summary cache loaded.');
  } catch (e) {
    console.error('Failed to load live summary cache:', e);
  }
}

function saveCache() {
  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify(liveData, null, 2));
    fs.writeFileSync(TOP_SPENDER_CACHE_FILE, JSON.stringify(topSpenderCache, null, 2));
    fs.writeFileSync(LIVE_SUMMARY_CACHE_FILE, JSON.stringify(liveSummaryCache, null, 2));
  } catch (e) {
    console.error('Failed to save cache:', e);
  }
}

function getAllIdle() {
  return Object.values(liveData).every(d => d && d.status === 'idle' && d.lastLive === false);
}

function resetIdleRetryIfNeeded() {
  // Tidak perlu idleRetryCount, retry langsung setiap 15 menit
  currentRetryInterval = RETRY_INTERVAL_MIN;
  lastIdleDay = (new Date()).getDate();
}

function getJitteredInterval(base) {
  // Jitter ±2 menit (0-120000 ms)
  const jitter = Math.floor(Math.random() * 120000) - 60000;
  return Math.max(60000, base + jitter); // minimal 1 menit
}

function getJakartaDate(dateObj) {
  // Kembalikan objek Date baru di zona waktu Asia/Jakarta
  const options = { timeZone: 'Asia/Jakarta', hour12: false };
  const parts = new Intl.DateTimeFormat('id-ID', {
    ...options,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  }).formatToParts(dateObj);
  // parts: [{type: 'day', value: '20'}, ...]
  const get = t => parts.find(p => p.type === t)?.value;
  return {
    tanggal: `${get('year')}-${get('month')}-${get('day')}`,
    jam: `${get('hour')}:${get('minute')}:${get('second')}`,
    jamShort: `${get('hour')}:${get('minute')}`
  };
}

function startMonitor(username) {
  // Log saat mulai monitoring akun (sekali saja)
  console.log(`[${username}] Monitoring started.`);
  const client = new WebcastPushConnection(username);
  liveData[username] = {
    startTime: null,
    sessionId: null, // Will be set when live starts
    gifts: {},
    jamMulai: null,
    jamMulaiJakarta: null,
    jamSelesai: null,
    jamSelesaiJakarta: null,
    peakViewer: 0,
    lastViewer: 0, // Tambahan: simpan viewer terakhir
    status: 'idle',
    lastLive: false
  };

  client.on('connect', () => {
    liveData[username].status = 'connected';
    liveData[username].lastLive = true;
    liveData[username].startTime = Date.now();
    // Gunakan waktu Jakarta
    const now = new Date();
    const jakarta = getJakartaDate(now);
    liveData[username].jamMulai = now;
    liveData[username].jamMulaiJakarta = jakarta;
    liveData[username].sessionId = uuidv4();
    liveData[username].peakViewer = 0;
    liveData[username].lastViewer = 0;
    console.log(`[${username}] LIVE started at ${jakarta.tanggal} ${jakarta.jamShort} (Jakarta) with session ID ${liveData[username].sessionId}`);
  });

  client.on('disconnect', () => {
    liveData[username].status = 'idle';
    liveData[username].lastLive = false;
    // Log saat live berakhir
    console.log(`[${username}] LIVE ended at ${new Date().toLocaleString('id-ID')}`);
  });

  client.on('viewer', (data) => {
    // Tidak perlu log viewer kecuali ingin debug peak viewer
    if (data && typeof data.viewerCount === 'number') {
      liveData[username].lastViewer = data.viewerCount;
      if (data.viewerCount > liveData[username].peakViewer) {
        liveData[username].peakViewer = data.viewerCount;
      }
    }
  });

  client.on('gift', (giftData) => {
    // giftData: { userId, uniqueId, repeatCount, diamondCount }
    const userId = giftData.userId;
    const points = giftData.diamondCount || 0;
    
    // Update live data gifts
    if (!liveData[username].gifts[userId]) {
      liveData[username].gifts[userId] = {
        username: giftData.uniqueId,
        points: 0
      };
    }
    liveData[username].gifts[userId].points += points;

    // Update top spender cache
    if (!topSpenderCache[username]) {
      topSpenderCache[username] = {
        lastUpdate: new Date().toISOString(),
        gifts: {}
      };
      console.log(`[${username}] Membuat topSpenderCache baru.`);
    }
    if (!topSpenderCache[username].gifts[userId]) {
      topSpenderCache[username].gifts[userId] = {
        username: giftData.uniqueId,
        points: 0
      };
      console.log(`[${username}] Menambah user baru ke topSpenderCache: ${giftData.uniqueId}`);
    }
    topSpenderCache[username].gifts[userId].points += points;
    topSpenderCache[username].lastUpdate = new Date().toISOString();
    console.log(`[${username}] topSpenderCache sekarang:`, topSpenderCache[username]);
    
    // Log hanya saat ada gift
    console.log(`[${username}] received gift from ${giftData.uniqueId} with ${giftData.diamondCount || 0} points`);
    saveCache(); // Simpan cache setiap ada gift
  });

  client.on('liveEnd', async () => {
    const endTime = Date.now();
    const now = new Date();
    const jakartaEnd = getJakartaDate(now);
    liveData[username].jamSelesai = now;
    liveData[username].jamSelesaiJakarta = jakartaEnd;
    const durasiMs = endTime - (liveData[username].startTime || endTime);
    const durasiJam = Math.floor(durasiMs / (1000 * 60 * 60));
    const durasiMenit = Math.floor((durasiMs % (1000 * 60 * 60)) / (1000 * 60));
    const durasiStr = `${durasiJam > 0 ? durasiJam + ' jam ' : ''}${durasiMenit} menit`;
    
    // Get top givers from cache
    const topGivers = Object.values(topSpenderCache[username]?.gifts || {})
      .sort((a, b) => b.points - a.points)
      .slice(0, 10);
    
    const totalPoints = Object.values(liveData[username].gifts).reduce((sum, g) => sum + g.points, 0);
    const peakViewer = liveData[username].peakViewer || 0;

    // Simpan ke live summary cache
    if (!liveSummaryCache[username]) {
      liveSummaryCache[username] = [];
    }
    
    const summaryData = {
      tanggal_mulai: liveData[username].jamMulaiJakarta?.tanggal || jakartaEnd.tanggal,
      jam_mulai: liveData[username].jamMulaiJakarta?.jamShort || jakartaEnd.jamShort,
      durasi_live: durasiStr,
      nama_akun: username,
      total_diamond: totalPoints,
      peak_viewer: liveData[username].peakViewer || liveData[username].lastViewer || 0,
      session_id: liveData[username].sessionId
    };
    
    // Simpan ke cache dan Supabase
    liveSummaryCache[username].push(summaryData);
    await googleSheets.insertLiveSummaryToSupabase(summaryData);
    summaryData.saved_to_supabase = true;
    
    // Simpan top spender ke Supabase
    await googleSheets.insertTopSpendersToSupabase({
      tanggal_live: liveData[username].jamMulaiJakarta?.tanggal || '',
      jam_mulai: liveData[username].jamMulaiJakarta?.jamShort || '',
      akun: username,
      session_id: liveData[username].sessionId,
      top_spenders: topGivers.map(g => ({ username: g.username, points: g.points }))
    });

    // Kosongkan cache summary & top spender untuk akun ini
    liveSummaryCache[username] = [];
    topSpenderCache[username] = undefined;

    // Kirim notifikasi
    require('./notify').sendNotification({ username, duration: durasiStr, totalPoints, topGivers });
    
    // Clear cache untuk akun ini
    delete liveData[username];
    delete topSpenderCache[username];
    saveCache();
    
    // Setelah live selesai, mulai polling ulang
    setTimeout(() => startMonitor(username), RETRY_INTERVAL_MIN);
  });

  client.on('error', (error) => {
    let errMsg = (error && error.message) ? error.message : (typeof error === 'string' ? error : JSON.stringify(error));
    if (liveData[username].status === 'connected' || (errMsg && (errMsg.includes('rate limit') || errMsg.includes('banned') || errMsg.includes('API Error')))) {
      console.error(`[${username}] error: ${errMsg}`);
    }
    fs.appendFileSync(path.join(__dirname, 'logs', `${username}-error.log`), `[${new Date().toISOString()}] ${JSON.stringify(error)}\n`);
    // Jika error karena user not found/tidak live, retry periodik 15 menit (tanpa retry cepat)
    if (error && error.message && (error.message.includes('user_not_found') || error.message.includes('Failed to retrieve room_id'))) {
      liveData[username].status = 'idle';
      liveData[username].lastLive = false;
      resetIdleRetryIfNeeded();
      setTimeout(() => startMonitor(username), getJitteredInterval(RETRY_INTERVAL_MIN));
    } else {
      // Error lain: reconnect biasa (delay 3 detik)
      liveData[username].status = 'idle';
      setTimeout(() => {
        if (liveData[username].status !== 'connecting' && liveData[username].status !== 'connected') {
          liveData[username].status = 'connecting';
          client.connect().catch(() => {});
        }
      }, 3000);
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
      // Retry langsung setiap 15 menit jika gagal connect (tanpa menunggu 3x percobaan)
      setTimeout(() => startMonitor(username), getJitteredInterval(RETRY_INTERVAL_MIN));
    }
  })();
}

// Handle program exit
process.on('SIGINT', async () => {
  console.log('\nMenyimpan data sebelum keluar...');
  
  // Simpan data dari live yang masih berlangsung
  for (const [username, data] of Object.entries(liveData)) {
    if (data.status === 'connected' && data.jamMulai) {
      const endTime = Date.now();
      const now = new Date();
      const jakartaEnd = getJakartaDate(now);
      const jakartaMulai = data.jamMulaiJakarta || getJakartaDate(data.jamMulai || now);
      const durasiMs = endTime - (data.startTime || endTime);
      const durasiJam = Math.floor(durasiMs / (1000 * 60 * 60));
      const durasiMenit = Math.floor((durasiMs % (1000 * 60 * 60)) / (1000 * 60));
      const durasiStr = `${durasiJam > 0 ? durasiJam + ' jam ' : ''}${durasiMenit} menit`;
      
      const totalPoints = Object.values(data.gifts).reduce((sum, g) => sum + g.points, 0);
      
      // Simpan live summary untuk sesi yang sedang berlangsung
      const summaryData = {
        tanggal_mulai: jakartaMulai.tanggal,
        jam_mulai: jakartaMulai.jamShort,
        durasi_live: durasiStr,
        nama_akun: username,
        total_diamond: totalPoints,
        peak_viewer: data.peakViewer || 0,
        session_id: data.sessionId
      };
      
      // Simpan ke cache dan Supabase
      if (!liveSummaryCache[username]) {
        liveSummaryCache[username] = [];
      }
      liveSummaryCache[username].push(summaryData);
      await googleSheets.insertLiveSummaryToSupabase(summaryData);
      summaryData.saved_to_supabase = true;
    }
  }
  
  // Tambahan: Jika ada data gift di topSpenderCache, tapi status akun idle (belum pernah liveEnd), tetap simpan live summary
  for (const [username, spenderData] of Object.entries(topSpenderCache)) {
    if (spenderData && spenderData.gifts && Object.keys(spenderData.gifts).length > 0) {
      const live = liveData[username];
      // Jika live summary belum pernah disimpan untuk akun ini
      const alreadySaved = liveSummaryCache[username] && liveSummaryCache[username].some(s => s.saved_to_supabase);
      if (!alreadySaved) {
        // Ambil waktu mulai dari liveData jika ada, jika tidak pakai waktu sekarang
        const jamMulai = live?.jamMulai || new Date();
        const startTime = live?.startTime || Date.now();
        const endTime = Date.now();
        const durasiMs = endTime - startTime;
        const durasiJam = Math.floor(durasiMs / (1000 * 60 * 60));
        const durasiMenit = Math.floor((durasiMs % (1000 * 60 * 60)) / (1000 * 60));
        const durasiStr = `${durasiJam > 0 ? durasiJam + ' jam ' : ''}${durasiMenit} menit`;
        const totalPoints = Object.values(spenderData.gifts).reduce((sum, g) => sum + g.points, 0);
        const peakViewer = live?.peakViewer || 0;
        const sessionId = live?.sessionId || uuidv4();
        const jakartaMulai = live?.jamMulaiJakarta || getJakartaDate(jamMulai);
        const summaryData = {
          tanggal_mulai: jakartaMulai.tanggal,
          jam_mulai: jakartaMulai.jamShort,
          durasi_live: durasiStr,
          nama_akun: username,
          total_diamond: totalPoints,
          peak_viewer: peakViewer,
          session_id: sessionId
        };
        if (!liveSummaryCache[username]) liveSummaryCache[username] = [];
        liveSummaryCache[username].push(summaryData);
        await googleSheets.insertLiveSummaryToSupabase(summaryData);
        summaryData.saved_to_supabase = true;
        console.log(`[${username}] Live summary idle berhasil disimpan ke Supabase.`);
      }
    }
  }

  // Untuk setiap akun yang punya data di topSpenderCache, selalu buat dan simpan live summary
  for (const [username, spenderData] of Object.entries(topSpenderCache)) {
    if (spenderData && spenderData.gifts && Object.keys(spenderData.gifts).length > 0) {
      const live = liveData[username];
      const now = new Date();
      const jakartaEnd = getJakartaDate(now);
      const jakartaMulai = live?.jamMulaiJakarta || getJakartaDate(live?.jamMulai || now);
      const startTime = live?.startTime || Date.now();
      const endTime = Date.now();
      const durasiMs = endTime - startTime;
      const durasiJam = Math.floor(durasiMs / (1000 * 60 * 60));
      const durasiMenit = Math.floor((durasiMs % (1000 * 60 * 60)) / (1000 * 60));
      const durasiStr = `${durasiJam > 0 ? durasiJam + ' jam ' : ''}${durasiMenit} menit`;
      const totalPoints = Object.values(spenderData.gifts).reduce((sum, g) => sum + g.points, 0);
      const peakViewer = live?.peakViewer || 0;
      const sessionId = live?.sessionId || uuidv4();
      const summaryData = {
        tanggal_mulai: jakartaMulai.tanggal,
        jam_mulai: jakartaMulai.jamShort,
        durasi_live: durasiStr,
        nama_akun: username,
        total_diamond: totalPoints,
        peak_viewer: peakViewer,
        session_id: sessionId
      };
      if (!liveSummaryCache[username]) liveSummaryCache[username] = [];
      liveSummaryCache[username].push(summaryData);
      await googleSheets.insertLiveSummaryToSupabase(summaryData);
      summaryData.saved_to_supabase = true;
      console.log(`[${username}] Live summary (SIGINT) berhasil disimpan ke Supabase.`);
    }
  }

  // Simpan data top spender terakhir ke Supabase
  for (const [username, data] of Object.entries(topSpenderCache)) {
    if (data && data.gifts && Object.keys(data.gifts).length > 0) {
      const topGivers = Object.values(data.gifts)
        .sort((a, b) => b.points - a.points)
        .slice(0, 10);
      
      // Cek apakah ada data live yang sedang berlangsung untuk mendapatkan waktu mulai
      const currentLiveData = liveData[username];
      const tanggal = currentLiveData?.jamMulaiJakarta?.tanggal 
        ? currentLiveData.jamMulaiJakarta.tanggal
        : new Date().toLocaleDateString('id-ID');
      const jamMulai = currentLiveData?.jamMulaiJakarta?.jamShort
        ? currentLiveData.jamMulaiJakarta.jamShort
        : new Date().toTimeString().slice(0,5);
        
      await googleSheets.insertTopSpendersToSupabase({
        tanggal_live: tanggal,
        jam_mulai: jamMulai,
        akun: username,
        session_id: currentLiveData?.sessionId || uuidv4(), // Generate new session ID if none exists
        top_spenders: topGivers.map(g => ({ username: g.username, points: g.points }))
      });
      console.log(`[${username}] Top spender terakhir tersimpan ke Supabase.`);
      // Kosongkan cache top spender
      topSpenderCache[username] = undefined;
    }
  }

  // Simpan cache yang belum tersimpan dari live summary sebelumnya
  for (const [username, summaries] of Object.entries(liveSummaryCache)) {
    if (summaries && summaries.length > 0) {
      for (const summary of summaries) {
        if (!summary.saved_to_supabase) {
          await googleSheets.insertLiveSummaryToSupabase(summary);
          summary.saved_to_supabase = true;
        }
      }
      // Kosongkan cache summary
      liveSummaryCache[username] = [];
    }
  }
  
  saveCache();
  console.log('Data tersimpan. Program berhenti.');
  process.exit(0);
});

// Start monitoring semua akun langsung paralel (tanpa delay)
console.log('=== TikTok Live Monitoring started ===');
console.log('Tanggal & waktu:', new Date().toLocaleString('id-ID'));
console.log('Akun yang dimonitor:', accounts.join(', '));

accounts.forEach(username => {
  startMonitor(username);
});

// Info jika semua akun idle (tidak live)
setInterval(() => {
  const idleAccounts = Object.entries(liveData).filter(([_, d]) => d.status === 'idle');
  if (idleAccounts.length === accounts.length) {
    console.log('Semua akun sedang tidak live pada', new Date().toLocaleString('id-ID'));
  }
}, 10 * 60 * 1000); // cek tiap 10 menit
