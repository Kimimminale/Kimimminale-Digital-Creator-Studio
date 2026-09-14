const fileInput = document.querySelector('#video-input');
const fileName = document.querySelector('#file-name');
const networks = document.querySelectorAll('.network');
const publishButton = document.querySelector('#publish-button');
const toast = document.querySelector('#toast');

fileInput.addEventListener('change', () => {
  const file = fileInput.files[0];
  fileName.textContent = file ? `Đã chọn: ${file.name}` : '';
});

networks.forEach((network) => network.addEventListener('click', () => {
  network.classList.toggle('selected');
}));

document.querySelectorAll('[data-scroll]').forEach((button) => button.addEventListener('click', () => {
  document.querySelector(button.dataset.scroll).scrollIntoView({ behavior: 'smooth' });
}));

publishButton.addEventListener('click', () => {
  const title = document.querySelector('#video-title').value.trim();
  const selected = [...document.querySelectorAll('.network.selected')].map((item) => item.dataset.network);
  if (!title || !fileInput.files[0] || !selected.length) {
    showToast('Hãy thêm video, tiêu đề và chọn ít nhất một nền tảng.');
    return;
  }
  const timing = document.querySelector('#publish-time').value === 'now' ? 'đăng ngay' : 'lên lịch';
  showToast(`Đã tạo chiến dịch ${timing} cho ${selected.join(', ')}.`);
});

function showToast(message) {
  toast.textContent = message;
  toast.classList.add('show');
  window.clearTimeout(window.toastTimer);
  window.toastTimer = window.setTimeout(() => toast.classList.remove('show'), 3600);
}
