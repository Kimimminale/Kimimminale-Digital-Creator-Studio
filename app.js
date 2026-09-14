const fileInput = document.querySelector('#video-input');
const fileName = document.querySelector('#file-name');
const networks = document.querySelectorAll('.network');
const publishButton = document.querySelector('#publish-button');
const toast = document.querySelector('#toast');
const publishTime = document.querySelector('#publish-time');
const scheduleTime = document.querySelector('.schedule-time');
let uploadedVideoId = null;

fileInput.addEventListener('change', () => {
  const file = fileInput.files[0];
  uploadedVideoId = null;
  fileName.textContent = file ? `Sẵn sàng tải lên: ${file.name}` : '';
});
networks.forEach((network) => network.addEventListener('click', () => network.classList.toggle('selected')));
publishTime.addEventListener('change', () => { scheduleTime.hidden = publishTime.value !== 'schedule'; });
document.querySelectorAll('[data-scroll]').forEach((button) => button.addEventListener('click', () => document.querySelector(button.dataset.scroll).scrollIntoView({ behavior: 'smooth' })));
document.querySelector('#refresh-dashboard').addEventListener('click', loadDashboard);

publishButton.addEventListener('click', async () => {
  const title = document.querySelector('#video-title').value.trim();
  const description = document.querySelector('#video-description').value.trim();
  const selected = [...document.querySelectorAll('.network.selected')].map((item) => item.dataset.network);
  const file = fileInput.files[0];
  if (!title || !file || !selected.length) return showToast('Hãy thêm video, tiêu đề và chọn ít nhất một nền tảng.');
  const scheduledAt = publishTime.value === 'schedule' ? document.querySelector('#scheduled-at').value : new Date().toISOString();
  if (!scheduledAt) return showToast('Hãy chọn ngày giờ xuất bản.');
  try {
    setPublishing(true);
    if (!uploadedVideoId) {
      fileName.textContent = `Đang tải ${file.name} lên kho lưu trữ…`;
      const upload = await api('/api/videos', { method: 'POST', headers: { 'Content-Type': file.type || 'video/mp4', 'X-File-Name': encodeURIComponent(file.name) }, body: file });
      uploadedVideoId = upload.video.id;
      fileName.textContent = `Đã lưu an toàn: ${upload.video.name}`;
    }
    const result = await api('/api/campaigns', { method: 'POST', body: JSON.stringify({ title, description, videoId: uploadedVideoId, platforms: selected, scheduledAt }) });
    showToast(`Đã tạo chiến dịch cho ${result.campaign.platforms.join(', ')}.`);
    await loadDashboard();
  } catch (error) { showToast(error.message); } finally { setPublishing(false); }
});

async function loadDashboard() {
  try {
    const dashboard = await api('/api/dashboard');
    renderConnections(dashboard.platforms);
    renderCampaigns(dashboard.campaigns);
    renderLogs(dashboard.logs);
  } catch (error) { showToast(`Không thể tải trạng thái: ${error.message}`); }
}
function renderConnections(platforms) {
  document.querySelector('#connection-list').innerHTML = platforms.map((platform) => `<article class="connection-card"><div><span class="platform-icon ${platform.name.toLowerCase()}">${platform.name === 'YouTube' ? '▶' : platform.name === 'TikTok' ? '♪' : platform.name === 'Instagram' ? '◎' : 'f'}</span><div><h3>${escapeHtml(platform.name)}</h3><p>${platform.connected ? 'Đã cấp quyền OAuth · token được mã hóa' : `Hỗ trợ: ${platform.supportedContent.join(', ')}`}</p></div></div><a class="oauth-button ${platform.connected ? 'connected' : ''}" href="/api/oauth/${platform.name.toLowerCase()}/start">${platform.connected ? 'Đã kết nối' : 'Kết nối OAuth'}</a></article>`).join('');
}
function renderCampaigns(campaigns) { document.querySelector('#campaign-list').innerHTML = campaigns.length ? campaigns.map((campaign) => `<div class="activity-row"><div><strong>${escapeHtml(campaign.title)}</strong><small>${new Date(campaign.scheduledAt).toLocaleString('vi-VN')} · ${campaign.platforms.map(escapeHtml).join(', ')}</small></div><span class="status ${campaign.status}">${statusLabel(campaign.status)}</span></div>`).join('') : 'Chưa có chiến dịch nào.'; }
function renderLogs(logs) { document.querySelector('#log-list').innerHTML = logs.length ? logs.map((log) => `<div class="log-row ${log.level}"><span>${log.level === 'error' ? '!' : log.level === 'warning' ? '↻' : '✓'}</span><div>${escapeHtml(log.message)}<small>${new Date(log.createdAt).toLocaleString('vi-VN')}${log.platform ? ` · ${escapeHtml(log.platform)}` : ''}</small></div></div>`).join('') : 'Nhật ký sẽ xuất hiện khi bạn tạo chiến dịch.'; }
async function api(url, options = {}) { const response = await fetch(url, { ...options, headers: { ...(options.headers || {}), ...(options.body && !(options.body instanceof File) ? { 'Content-Type': 'application/json' } : {}) } }); const payload = await response.json(); if (!response.ok) throw new Error(payload.error || 'Có lỗi xảy ra.'); return payload; }
function setPublishing(active) { publishButton.disabled = active; publishButton.textContent = active ? 'Đang lưu an toàn…' : 'Lên lịch xuất bản →'; }
function statusLabel(status) { return ({ scheduled: 'Đã lên lịch', published: 'Đã đăng', failed: 'Thất bại' })[status] || status; }
function escapeHtml(value) { return String(value).replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]); }
function showToast(message) { toast.textContent = message; toast.classList.add('show'); window.clearTimeout(window.toastTimer); window.toastTimer = window.setTimeout(() => toast.classList.remove('show'), 3600); }
loadDashboard();
