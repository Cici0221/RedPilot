const form = document.querySelector('#login-form');
const email = document.querySelector('#login-email');
const password = document.querySelector('#login-password');
const submit = document.querySelector('#login-submit');
const toggle = document.querySelector('#password-toggle');
const error = document.querySelector('#login-error');
let configured = false;
let submitting = false;

function showError(message, invalid = false) {
  error.textContent = message;
  error.hidden = !message;
  for (const input of [email, password]) {
    input.setAttribute('aria-invalid', String(invalid));
    if (message) input.setAttribute('aria-describedby', 'login-error');
    else input.removeAttribute('aria-describedby');
  }
}

toggle.addEventListener('click', () => {
  const visible = password.type === 'password';
  password.type = visible ? 'text' : 'password';
  toggle.textContent = visible ? '隐藏' : '显示';
  toggle.setAttribute('aria-label', visible ? '隐藏密码' : '显示密码');
  toggle.setAttribute('aria-pressed', String(visible));
});
form.addEventListener('input', () => { if (configured) showError(''); });

form.addEventListener('submit', async event => {
  event.preventDefault();
  if (submitting || !configured || !form.reportValidity()) return;
  submitting = true;
  submit.disabled = true;
  submit.textContent = '登录中…';
  showError('');
  try {
    const response = await fetch('/api/auth/login', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: email.value.trim(), password: password.value })
    });
    if (!response.ok) {
      const messages = { 401: '账号或密码不正确', 429: '尝试次数过多，请稍后再试', 503: '登录尚未配置' };
      showError(messages[response.status] || '登录未完成，请重试', response.status === 401);
      return;
    }
    const result = await response.json();
    if (result.ok !== true) { showError('登录未完成，请重试'); return; }
    password.value = '';
    location.replace('/');
  } catch {
    showError('连接失败，请重试');
  } finally {
    submitting = false;
    submit.disabled = !configured;
    submit.textContent = '登录';
  }
});

async function checkSession() {
  try {
    const response = await fetch('/api/auth/session', { credentials: 'same-origin', cache: 'no-store' });
    if (!response.ok) throw new Error();
    const session = await response.json();
    if (session.authenticated) { location.replace('/'); return; }
    configured = session.configured === true;
    if (!configured) showError('登录尚未配置');
  } catch {
    configured = true;
    showError('无法连接服务，请重试');
  } finally {
    submit.disabled = !configured;
  }
}
checkSession();
