require('dotenv').config();
const express = require('express');
const basicAuth = require('express-basic-auth');
const fetch = require('node-fetch');

const app = express();
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true, limit: '5mb' }));

// Basic Auth (kullanıcı adı/şifre)
app.use(basicAuth({
  users: { [process.env.ADMIN_USER]: process.env.ADMIN_PASS },
  challenge: true,
  realm: 'TV Admin'
}));

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_OWNER = process.env.GITHUB_OWNER; // örn: kadirsener1
const GITHUB_REPO = process.env.GITHUB_REPO;   // örn: livetv
const GITHUB_PATH = process.env.GITHUB_PATH;   // örn: tv247tr.m3u
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || 'main';

const API_BASE = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${GITHUB_PATH}`;

// GitHub'dan dosyayı ve sha'sını çek
async function getFile() {
  const res = await fetch(`${API_BASE}?ref=${GITHUB_BRANCH}`, {
    headers: {
      Authorization: `token ${GITHUB_TOKEN}`,
      'User-Agent': 'tv-admin'
    }
  });
  if (!res.ok) throw new Error(`GitHub GET hatası: ${res.status}`);
  const data = await res.json();
  const content = Buffer.from(data.content, 'base64').toString('utf8');
  return { content, sha: data.sha };
}

// GitHub'a dosyayı yaz
async function saveFile(content, sha, message) {
  const res = await fetch(API_BASE, {
    method: 'PUT',
    headers: {
      Authorization: `token ${GITHUB_TOKEN}`,
      'User-Agent': 'tv-admin',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      message: message || 'Playlist güncellendi (admin panel)',
      content: Buffer.from(content).toString('base64'),
      sha,
      branch: GITHUB_BRANCH
    })
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`GitHub PUT hatası: ${res.status} - ${err}`);
  }
  return res.json();
}

// Ana sayfa: kanal listesi
app.get('/', async (req, res) => {
  try {
    const { content } = await getFile();
    res.send(renderPage(content));
  } catch (e) {
    res.status(500).send(`<pre>${e.message}</pre>`);
  }
});

// Kaydet
app.post('/save', async (req, res) => {
  try {
    const newContent = req.body.content;
    const { sha } = await getFile();
    await saveFile(newContent, sha, 'Playlist güncellendi (admin panel)');
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Basit HTML arayüz
function renderPage(content) {
  const escaped = content.replace(/`/g, '\\`').replace(/\$/g, '\\$');
  return `<!DOCTYPE html>
<html lang="tr">
<head>
<meta charset="UTF-8">
<title>TV Admin Panel</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 0; background: #111; color: #eee; }
  header { padding: 12px 20px; background: #1a1a1a; border-bottom: 1px solid #333; display: flex; justify-content: space-between; align-items: center; }
  h1 { font-size: 18px; margin: 0; }
  .toolbar { padding: 12px 20px; background: #181818; border-bottom: 1px solid #333; display: flex; gap: 8px; flex-wrap: wrap; }
  button { padding: 8px 14px; background: #2b6cb0; color: #fff; border: none; border-radius: 4px; cursor: pointer; font-size: 14px; }
  button:hover { background: #3182ce; }
  button.danger { background: #c53030; }
  button.danger:hover { background: #e53e3e; }
  button.success { background: #2f855a; }
  button.success:hover { background: #38a169; }
  .container { display: flex; height: calc(100vh - 100px); }
  .channels { width: 40%; overflow-y: auto; border-right: 1px solid #333; }
  .channel { padding: 10px 14px; border-bottom: 1px solid #222; cursor: pointer; display: flex; align-items: center; gap: 10px; }
  .channel:hover { background: #1e1e1e; }
  .channel.active { background: #2a3a52; }
  .channel img { width: 40px; height: 40px; object-fit: contain; background: #000; border-radius: 3px; }
  .channel .info { flex: 1; overflow: hidden; }
  .channel .name { font-weight: 600; font-size: 14px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .channel .group { font-size: 12px; color: #888; }
  .editor { flex: 1; padding: 20px; overflow-y: auto; }
  .editor label { display: block; margin-bottom: 6px; font-size: 13px; color: #aaa; }
  .editor input, .editor select, .editor textarea {
    width: 100%; padding: 8px; margin-bottom: 14px; background: #1a1a1a; color: #eee;
    border: 1px solid #333; border-radius: 4px; font-size: 14px; box-sizing: border-box;
  }
  .editor textarea { min-height: 200px; font-family: monospace; }
  .status { padding: 8px 14px; font-size: 13px; }
  .status.ok { color: #68d391; }
  .status.err { color: #fc8181; }
</style>
</head>
<body>
<header>
  <h1>📺 TV Admin Panel — tv247tr.m3u</h1>
  <div>
    <button class="success" onclick="saveAll()">💾 Kaydet</button>
    <span id="status" class="status"></span>
  </div>
</header>
<div class="toolbar">
  <button onclick="addChannel()">➕ Yeni Kanal</button>
  <button onclick="reload()">🔄 Yeniden Yükle</button>
  <button onclick="showRaw()">📝 Ham M3U</button>
</div>
<div class="container">
  <div class="channels" id="channels"></div>
  <div class="editor" id="editor">
    <p style="color:#888">Soldan bir kanal seç veya yeni kanal ekle.</p>
  </div>
</div>

<script>
let rawContent = \`${escaped}\`;
let channels = [];
let currentIndex = -1;

function parseM3U(content) {
  const lines = content.split(/\\r?\\n/);
  const result = [];
  let pending = null;
  for (const line of lines) {
    if (line.startsWith('#EXTINF')) {
      pending = { extinf: line, opts: [], url: '', extra: [] };
    } else if (line.startsWith('#EXTVLCOPT') && pending) {
      pending.opts.push(line);
    } else if (line.startsWith('#') && pending && !line.startsWith('#EXTM3U')) {
      pending.extra.push(line);
    } else if (line.trim() && !line.startsWith('#') && pending) {
      pending.url = line.trim();
      result.push(pending);
      pending = null;
    } else if (!line.trim()) {
      // boş satır
    }
  }
  return result;
}

function parseExtinf(extinf) {
  const meta = {};
  const nameMatch = extinf.match(/,(.*)$/);
  meta.name = nameMatch ? nameMatch[1].trim() : '';
  const attrRegex = /([a-zA-Z0-9-]+)="([^"]*)"/g;
  let m;
  while ((m = attrRegex.exec(extinf)) !== null) {
    meta[m[1]] = m[2];
  }
  return meta;
}

function buildExtinf(meta) {
  let s = '#EXTINF:-1';
  const order = ['tvg-id','tvg-name','tvg-language','tvg-country','tvg-logo','group-title'];
  for (const k of order) {
    if (meta[k] !== undefined && meta[k] !== '') s += \` \${k}="\${meta[k]}"\`;
  }
  // diğer attr'lar
  for (const k in meta) {
    if (!order.includes(k) && k !== 'name' && meta[k]) {
      s += \` \${k}="\${meta[k]}"\`;
    }
  }
  s += \`,\${meta.name || ''}\`;
  return s;
}

function serialize() {
  let out = '#EXTM3U\\n';
  for (const ch of channels) {
    out += ch.extinf + '\\n';
    for (const o of ch.opts) out += o + '\\n';
    for (const e of ch.extra) out += e + '\\n';
    out += ch.url + '\\n';
  }
  return out;
}

function renderChannelList() {
  const el = document.getElementById('channels');
  el.innerHTML = '';
  channels.forEach((ch, i) => {
    const meta = parseExtinf(ch.extinf);
    const div = document.createElement('div');
    div.className = 'channel' + (i === currentIndex ? ' active' : '');
    div.onclick = () => selectChannel(i);
    div.innerHTML = \`
      <img src="\${meta['tvg-logo'] || ''}" onerror="this.style.visibility='hidden'">
      <div class="info">
        <div class="name">\${meta.name || '(isimsiz)'}</div>
        <div class="group">\${meta['group-title'] || ''}</div>
      </div>
    \`;
    el.appendChild(div);
  });
}

function selectChannel(i) {
  currentIndex = i;
  renderChannelList();
  const ch = channels[i];
  const meta = parseExtinf(ch.extinf);
  const editor = document.getElementById('editor');
  editor.innerHTML = \`
    <label>Kanal Adı</label>
    <input id="f-name" value="\${escapeAttr(meta.name)}">
    <label>Grup</label>
    <input id="f-group" value="\${escapeAttr(meta['group-title'] || '')}">
    <label>Logo URL</label>
    <input id="f-logo" value="\${escapeAttr(meta['tvg-logo'] || '')}">
    <label>tvg-id</label>
    <input id="f-id" value="\${escapeAttr(meta['tvg-id'] || '')}">
    <label>tvg-name</label>
    <input id="f-tvgname" value="\${escapeAttr(meta['tvg-name'] || '')}">
    <label>Yayın URL</label>
    <input id="f-url" value="\${escapeAttr(ch.url)}">
    <label>EXTVLCOPT Satırları (her satır bir tane)</label>
    <textarea id="f-opts">\${escapeHtml(ch.opts.join('\\n'))}</textarea>
    <div style="display:flex;gap:8px;margin-top:10px">
      <button onclick="applyChanges()">✅ Uygula</button>
      <button class="danger" onclick="deleteChannel()">🗑️ Sil</button>
    </div>
  \`;
}

function applyChanges() {
  const ch = channels[currentIndex];
  const meta = parseExtinf(ch.extinf);
  meta.name = document.getElementById('f-name').value;
  meta['group-title'] = document.getElementById('f-group').value;
  meta['tvg-logo'] = document.getElementById('f-logo').value;
  meta['tvg-id'] = document.getElementById('f-id').value;
  meta['tvg-name'] = document.getElementById('f-tvgname').value;
  ch.extinf = buildExtinf(meta);
  ch.url = document.getElementById('f-url').value.trim();
  const optsText = document.getElementById('f-opts').value.trim();
  ch.opts = optsText ? optsText.split('\\n').filter(l => l.trim()) : [];
  renderChannelList();
  setStatus('Değişiklikler uygulandı (henüz kaydedilmedi)', 'ok');
}

function deleteChannel() {
  if (!confirm('Bu kanalı silmek istediğine emin misin?')) return;
  channels.splice(currentIndex, 1);
  currentIndex = -1;
  document.getElementById('editor').innerHTML = '<p style="color:#888">Kanal silindi.</p>';
  renderChannelList();
  setStatus('Kanal silindi (henüz kaydedilmedi)', 'ok');
}

function addChannel() {
  const meta = { name: 'Yeni Kanal', 'group-title': 'Genel' };
  channels.push({ extinf: buildExtinf(meta), opts: [], extra: [], url: 'https://' });
  currentIndex = channels.length - 1;
  renderChannelList();
  selectChannel(currentIndex);
}

function reload() {
  if (!confirm('Kaydedilmemiş değişiklikler kaybolacak. Devam?')) return;
  location.reload();
}

function showRaw() {
  const editor = document.getElementById('editor');
  editor.innerHTML = \`
    <label>Ham M3U İçeriği (dikkatli düzenle)</label>
    <textarea id="f-raw" style="min-height:60vh">\${escapeHtml(serialize())}</textarea>
    <button onclick="applyRaw()">✅ Ham İçeriği Uygula</button>
  \`;
}

function applyRaw() {
  const raw = document.getElementById('f-raw').value;
  channels = parseM3U(raw);
  currentIndex = -1;
  renderChannelList();
  document.getElementById('editor').innerHTML = '<p style="color:#888">Ham içerik ayrıştırıldı.</p>';
  setStatus('Ham içerik uygulandı', 'ok');
}

async function saveAll() {
  const content = serialize();
  setStatus('Kaydediliyor...', '');
  try {
    const res = await fetch('/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content })
    });
    const data = await res.json();
    if (data.ok) {
      setStatus('✅ GitHub\\'a kaydedildi, Render otomatik deploy edecek', 'ok');
    } else {
      setStatus('❌ Hata: ' + data.error, 'err');
    }
  } catch (e) {
    setStatus('❌ Hata: ' + e.message, 'err');
  }
}

function setStatus(msg, cls) {
  const el = document.getElementById('status');
  el.textContent = msg;
  el.className = 'status ' + (cls || '');
}

function escapeHtml(s) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function escapeAttr(s) { return (s || '').replace(/"/g,'&quot;'); }

// Başlat
channels = parseM3U(rawContent);
renderChannelList();
</script>
</body>
</html>`;
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Admin panel ${PORT} portunda`));
